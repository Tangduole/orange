/**
 * 下载控制器 v3
 *
 * v3 改进:
 * 1. 自动识别平台(前端驱动,后端兼容)
 * 2. 支持 options 数组:video/copywriting/cover/asr/subtitle
 * 3. 支持 saveTarget: phone/pc
 * 4. 支持 copywriting(提取描述)、cover(封面下载)、subtitle(字幕下载)
 */

const { v4: uuidv4 } = require('uuid');
const store = require('../store');
const ytdlp = require('../services/yt-dlp');
const asr = require('../services/asr');
const { validateInput } = require('../utils/validator');
const { executeWithRetry, downloadWithLimit, getLimiterStatus } = require('../utils/limiter');
const { tikhubRequest } = require('../services/tikhub');
const path = require('path');
const fs = require('fs');
const axios = require('axios');

// 新增工具导入
const taskLock = require('../utils/taskLock');
const cacheManager = require('../utils/cacheManager');
const asyncFs = require('../utils/asyncFs');
const fileRefManager = require('../utils/fileRefManager');
const logger = require('../utils/logger');
const { heightToLabel, formatSize, detectPlatform } = require('../utils/media');
const { 
  QUALITY, 
  TIMEOUT, 
  LIMITS, 
  TASK_STATUS, 
  RESPONSE_CODE,
  HTTP_STATUS,
  PLATFORM 
} = require('../config/constants');

const API_KEY_DOUYIN = process.env.TIKHUB_API_KEY_DOUYIN;

/**
 * 立即保存下载历史到数据库（不依赖 /status 调用）
 */
function saveHistory(taskId) {
  const task = store.get(taskId);
  if (!task || task.historySaved) return;
  try {
    const userDb = require('../userDb');
    userDb.addHistory({
      userId: task.userId,
      guestIp: task.guestIp,
      taskId: task.taskId,
      url: task.url,
      platform: task.platform,
      title: task.title,
      thumbnailUrl: task.thumbnailUrl,
      duration: task.duration
    }).then(() => store.update(taskId, { historySaved: true })).catch(e => logger.error('[history] save failed:', e.message));
  } catch (e) { logger.error('[history]', e.message); }
}

/**
 * 流式下载文件到磁盘(避免 OOM)
 */
async function downloadToStream(url, destPath, timeout = TIMEOUT.DOWNLOAD) {
  const writer = fs.createWriteStream(destPath);
  const response = await axios.get(url, { responseType: 'stream', timeout });

  // 检查 Content-Type，防止下载到 HTML 错误页
  const contentType = response.headers['content-type'] || '';
  if (contentType.includes('text/html') || contentType.includes('application/json')) {
    writer.close();
    await asyncFs.safeUnlink(destPath);
    throw new Error('Video link expired or blocked');
  }

  return new Promise((resolve, reject) => {
    response.data.pipe(writer);
    writer.on('finish', async () => {
      // 下载完成后再次检查文件内容（防止 Content-Type 误报）
      const isHtml = await asyncFs.isHtmlFile(destPath);
      if (isHtml) {
        await asyncFs.safeUnlink(destPath);
        reject(new Error('Video link expired or blocked'));
        return;
      }
      resolve();
    });
    writer.on('error', async (err) => {
      await asyncFs.safeUnlink(destPath);
      reject(err);
    });
  });
}

/**
 * 提取音频为 MP3（统一处理所有平台的音频转换）
 */
async function extractAudioToMp3(videoPath, taskId, destDir = null) {
  const dir = destDir || path.join(__dirname, '../../downloads');
  const audioPath = path.join(dir, `${taskId}.mp3`);
  const { spawn } = require('child_process');
  await new Promise((resolve, reject) => {
    const ff = spawn('ffmpeg', ['-i', videoPath, '-vn', '-acodec', 'libmp3lame', '-b:a', '128k', '-y', audioPath]);
    const timer = setTimeout(() => { ff.kill('SIGKILL'); reject(new Error('timeout')); }, TIMEOUT.FFMPEG);
    ff.on('close', code => { clearTimeout(timer); code === 0 ? resolve() : reject(new Error('ffmpeg exit ' + code)); });
    ff.on('error', err => { clearTimeout(timer); reject(err); });
  });
  return audioPath;
}

/**
 * 任务完成收尾：增加下载计数 + 保存历史 + 释放锁
 */
async function finalizeTask(taskId) {
  const task = store.get(taskId);
  if (!task) return;
  if (task.status === TASK_STATUS.COMPLETED) {
    try {
      const userDb = require('../userDb');
      if (task.userId) await userDb.incrementDownloads(task.userId);
      else if (task.guestIp) await userDb.incrementGuestDownload(task.guestIp);
    } catch (e) { logger.error('[finalize] count failed:', e.message); }
  }
  saveHistory(taskId);
  taskLock.release(taskId);
}

/**
 * 创建下载任务
 */
async function createDownload(req, res) {
  try {
    const validation = validateInput(req.body);
    if (!validation.valid) {
      return res.json({ code: 400, message: validation.message });
    }

    let { url, platform, needAsr = false, options = ['video'], saveTarget = 'phone', quality = null, asrLanguage = 'zh', targetLang = null } = req.body;

    // 从分享文本中提取 URL
    const { extractUrl } = require('../utils/validator');
    const extracted = extractUrl(url);
    if (extracted) url = extracted;

    // 平台自动识别
    const detectedPlatform = detectPlatform(url);
    const finalPlatform = platform || detectedPlatform || 'auto';

    // 兼容:前端 'audio' 和 'audio_only' 选项
    const normalizedOptions = (Array.isArray(options) ? options : [options]).map(
      o => o === 'asr' || o === 'audio_only' ? 'audio' : o
    );

    const wantsAsr = needAsr;

    // ========== 用户限额检查 ==========
    let userId = null;
    let isVip = false;
    const authHeader = req.headers.authorization;
    let isGuest = true;
    if (authHeader && authHeader.startsWith('Bearer ')) {
      try {
        const token = authHeader.slice(7);
        const jwt = require('jsonwebtoken');
        const JWT_SECRET = process.env.JWT_SECRET;
        const payload = jwt.verify(token, JWT_SECRET);
        const userDb = require('../userDb');
        const user = await userDb.getById(payload.sub);
        if (user) {
          isGuest = false;
          userId = user.id;

          // 检查邮箱是否已验证
          if (user.email_verified !== 1) {
            return res.json({
              code: 403,
              message: '请先验证邮箱后再下载。查收注册邮箱点击验证链接。'
            });
          }

          isVip = userDb.isVip(user);
          const usage = await userDb.getUsage(userId);
          if (!usage.isPro && usage.remaining <= 0) {
            return res.json({
              code: RESPONSE_CODE.FORBIDDEN,
              message: `今日下载次数已用完(${usage.dailyLimit}次/天)。升级 Pro 解锁无限制下载`
            });
          }
          // 注意：不在这里增加计数，等下载成功后再增加
        }
      } catch (e) {
        // token 无效,继续作为游客
      }
    }

    // 游客每日下载限制
    let guestIp = null;
    if (isGuest) {
      guestIp = req.ip || req.headers['x-forwarded-for']?.split(',')[0] || 'unknown';
      const userDb = require('../userDb');
      const guestUsage = await userDb.checkGuestDownload(guestIp);
      if (!guestUsage.allowed) {
        return res.json({
          code: RESPONSE_CODE.FORBIDDEN,
          message: `今日下载次数已用完(${guestUsage.limit}次/天)。注册账号获得更多下载次数`
        });
      }
      // 注意：不在这里增加计数，等下载成功后再增加
    }

    // ========== 画质VIP限制检查 ==========
    // 如果用户选择了1080p以上画质,检查是否为VIP
    if (quality) {
      const heightMatch = quality.match(/height<=(\d+)/i);
      const selectedHeight = heightMatch ? parseInt(heightMatch[1]) : 99999;

      if (selectedHeight > QUALITY.HD_THRESHOLD && !isVip) {
        // 免费用户允许试用1次高清画质
        const userDb = require('../userDb');
        const trialUsed = await userDb.useHdTrial(userId);
        if (!trialUsed) {
          return res.json({
            code: RESPONSE_CODE.FORBIDDEN,
            message: `${QUALITY.HD_THRESHOLD}p以上画质为会员专享。试用次数已用完,请升级Pro解锁高清下载。`
          });
        }
        // 试用成功,继续下载(不报错)
        logger.info(`[task] HD trial used for user ${userId}`);
      }
    }
    // ========== 画质VIP限制检查结束 ==========

    const limitStatus = getLimiterStatus();
    if (limitStatus.queued >= LIMITS.MAX_QUEUE) {
      return res.json({ code: HTTP_STATUS.TOO_MANY_REQUESTS, message: '任务队列已满,请稍后再试' });
    }

    const taskId = uuidv4();
    const task = {
      taskId,
      url: url.trim(),
      platform: finalPlatform,
      needAsr: wantsAsr,
      targetLang,
      options: normalizedOptions,
      saveTarget,
      status: 'pending',
      progress: 0,
      createdAt: Date.now(),
      userId: isGuest ? null : userId,
      guestIp: isGuest ? guestIp : null
    };

    store.save(task);

    // 抖音链接:走专用下载器(不依赖 yt-dlp)
    // VIP 不限画质（默认 1080p），免费用户最高 720p
    const { isDouyinUrl } = require('../services/douyin');
    if (isDouyinUrl(url)) {
      const douyinQuality = quality || (isVip ? null : 'bestvideo[height<=720]+bestaudio/best[height<=720]');
      processDouyin(taskId, url, wantsAsr, normalizedOptions, douyinQuality, asrLanguage, douyinQuality, isVip).catch(err => {
        logger.error(`[task] ${taskId} douyin failed:`, err);
        store.update(taskId, { status: TASK_STATUS.ERROR, progress: 0, error: err.message });
      });
      return res.json({ code: RESPONSE_CODE.SUCCESS, data: { taskId, status: TASK_STATUS.PENDING, platform: finalPlatform } });
    }

    // X/Twitter 链接:走专用下载器
    const { isXUrl } = require('../services/x-download');
    if (isXUrl(url)) {
      processX(taskId, url, wantsAsr, normalizedOptions).catch(err => {
        logger.error(`[task] ${taskId} x failed:`, err);
        store.update(taskId, { status: TASK_STATUS.ERROR, progress: 0, error: err.message });
      });
      return res.json({ code: RESPONSE_CODE.SUCCESS, data: { taskId, status: TASK_STATUS.PENDING, platform: finalPlatform } });
    }

    // 微信视频号链接:走专用下载器
    const { parseWechatExportId } = require('../services/tikhub');
    if (parseWechatExportId(url)) {
      processWechat(taskId, url, wantsAsr, normalizedOptions).catch(err => {
        logger.error(`[task] ${taskId} wechat failed:`, err);
        store.update(taskId, { status: TASK_STATUS.ERROR, progress: 0, error: err.message });
      });
      return res.json({ code: RESPONSE_CODE.SUCCESS, data: { taskId, status: TASK_STATUS.PENDING, platform: 'wechat' } });
    }

    // TikTok 链接:走 TikHub API
    if (/tiktok\.com|tiktok\.cn/i.test(url)) {
      processTikTok(taskId, url, wantsAsr, normalizedOptions, quality).catch(err => {
        logger.error(`[task] ${taskId} tiktok failed:`, err);
        store.update(taskId, { status: TASK_STATUS.ERROR, progress: 0, error: err.message });
      });
      return res.json({ code: RESPONSE_CODE.SUCCESS, data: { taskId, status: TASK_STATUS.PENDING, platform: PLATFORM.TIKTOK } });
    }

    // YouTube 链接:走 TikHub API(直接链接)
    if (/youtube\.com|youtu\.be/i.test(url)) {
      // VIP用户不传quality限制,后端自动使用最高画质
      const ytQuality = isVip ? null : quality;
      processYouTube(taskId, url, wantsAsr, normalizedOptions, ytQuality).catch(err => {
        logger.error(`[task] ${taskId} youtube failed:`, err);
        store.update(taskId, { status: TASK_STATUS.ERROR, progress: 0, error: err.message });
      });
      return res.json({ code: RESPONSE_CODE.SUCCESS, data: { taskId, status: TASK_STATUS.PENDING, platform: PLATFORM.YOUTUBE } });
    }

    // 小红书链接:走 TikHub API
    if (/xiaohongshu\.com|xhslink\.com/i.test(url)) {
      processXiaohongshu(taskId, url, wantsAsr, normalizedOptions).catch(err => {
        logger.error(`[task] ${taskId} xiaohongshu failed:`, err);
        store.update(taskId, { status: TASK_STATUS.ERROR, progress: 0, error: err.message });
      });
      return res.json({ code: RESPONSE_CODE.SUCCESS, data: { taskId, status: TASK_STATUS.PENDING, platform: PLATFORM.XIAOHONGSHU } });
    }

    // 快手链接:暂不支持
    if (/kuaishou\.com|v\.kuaishou\.com/i.test(url)) {
      store.update(taskId, { status: TASK_STATUS.ERROR, progress: 0, error: '快手平台暂不支持,请使用其他平台链接' });
      return res.json({ code: RESPONSE_CODE.SUCCESS, data: { taskId, status: TASK_STATUS.ERROR, platform: PLATFORM.KUAISHOU, message: '快手平台暂不支持' } });
    }

    // Instagram 链接:走 TikHub API
    if (/instagram\.com|instagr\.am/i.test(url)) {
      processInstagram(taskId, url, wantsAsr, normalizedOptions).catch(err => {
        logger.error(`[task] ${taskId} instagram failed:`, err);
        store.update(taskId, { status: TASK_STATUS.ERROR, progress: 0, error: err.message });
      });
      return res.json({ code: RESPONSE_CODE.SUCCESS, data: { taskId, status: TASK_STATUS.PENDING, platform: PLATFORM.INSTAGRAM } });
    }

    // Bilibili 链接:走 yt-dlp(待完善)
    if (/bilibili\.com|b23\.tv/i.test(url)) {
      processDownload(taskId, url, wantsAsr, normalizedOptions, quality).catch(err => {
        logger.error(`[task] ${taskId} bilibili failed:`, err);
        store.update(taskId, { status: TASK_STATUS.ERROR, progress: 0, error: err.message });
      });
      return res.json({ code: RESPONSE_CODE.SUCCESS, data: { taskId, status: TASK_STATUS.PENDING, platform: PLATFORM.BILIBILI } });
    }

    // 其他平台:走 yt-dlp
    processDownload(taskId, url, wantsAsr, normalizedOptions, quality).catch(err => {
      logger.error(`[task] ${taskId} failed:`, err);
      store.update(taskId, {
        status: TASK_STATUS.ERROR,
        progress: 0,
        error: err.message
      });
    });

    res.json({
      code: RESPONSE_CODE.SUCCESS,
      data: {
        taskId,
        status: TASK_STATUS.PENDING,
        platform: finalPlatform
      }
    });
  } catch (e) {
    logger.error('[createDownload] Error:', e);
    res.json({ code: HTTP_STATUS.INTERNAL_ERROR, message: e.message });
  }
}

/**
 * 获取视频信息(不下载)
 */
async function getInfo(req, res) {
  try {
    const { url } = req.query;
    if (!url) {
      return res.json({ code: 400, message: '请提供 url 参数' });
    }

    const info = await ytdlp.getInfo(url);
    res.json({ code: 0, data: info });
  } catch (e) {
    res.json({ code: 500, message: e.message });
  }
}

/**
 * 保存文本为可下载的 .txt 文件
 */
async function saveTextFile(taskId, text, suffix = 'txt') {
  if (!text) return null;
  const filename = taskId + '_' + suffix + '.txt';
  const filepath = path.join(__dirname, '../../downloads', filename);
  await asyncFs.safeWriteFile(filepath, text, 'utf-8');
  return '/download/' + filename;
}

/**
 * ASR 语音转文字(公共函数)
 */
async function handleAsr(taskId, filePath, asrLanguage, targetLang = null) {
  try {
    store.update(taskId, { status: TASK_STATUS.ASR, progress: 100 });
    const asr = require('../services/asr');
    const { spawn } = require('child_process');
    const audioPath = path.join(path.dirname(filePath), taskId + '_asr.mp3');

    // 用 ffmpeg 提取音频
    await new Promise((resolve, reject) => {
      const ff = spawn('ffmpeg', ['-i', filePath, '-vn', '-acodec', 'libmp3lame', '-b:a', '128k', '-y', audioPath]);
      const timer = setTimeout(() => { ff.kill('SIGKILL'); reject(new Error('timeout')); }, TIMEOUT.FFMPEG);
      ff.on('close', code => { clearTimeout(timer); code === 0 ? resolve() : reject(new Error('ffmpeg exit ' + code)); });
      ff.on('error', err => { clearTimeout(timer); reject(err); });
    });

    // ASR 转文字
    const text = await asr.transcribe(audioPath, asrLanguage);

    // 翻译(如果指定了目标语言)
    const task = store.get(taskId);
    const tLang = targetLang || task?.targetLang;
    logger.info(`[ASR] ${taskId} targetLang=${targetLang}, task.targetLang=${task?.targetLang}, tLang=${tLang}`);
    let translatedText = null;
    if (tLang && text) {
      try {
        logger.info(`[ASR] ${taskId} translating: ${asrLanguage === 'auto' ? 'zh' : asrLanguage} -> ${tLang}, textLen=${text.length}`);
        translatedText = await asr.translateText(text, asrLanguage === 'auto' ? 'zh' : asrLanguage, tLang);
      } catch (e) {
        logger.error(`[ASR] Translation failed: ${e.message}`);
      }
    }

    // 保存为 txt 文件
    const txtUrl = await saveTextFile(taskId, text, 'subtitle');
    const translatedTxtUrl = translatedText ? await saveTextFile(taskId, translatedText, 'translation') : null;

    // 清理临时音频
    await asyncFs.safeUnlink(audioPath);

    return { text, txtUrl, translatedText, translatedTxtUrl };
  } catch (e) {
    logger.error(`[ASR] ${taskId} failed:`, e.message);
    return null;
  }
}

/**
 * 处理下载任务(异步)
 */
async function processDownload(taskId, url, needAsr, options = ['video'], quality = null) {
  // 获取任务锁
  if (!taskLock.tryAcquire(taskId)) {
    logger.warn(`[task] ${taskId} is already being processed`);
    store.update(taskId, { 
      status: TASK_STATUS.ERROR, 
      error: 'Task is already in progress' 
    });
    return;
  }

  try {
    const normalizedOptions = (Array.isArray(options) ? options : [options]).map(
      o => o === 'asr' || o === 'audio_only' ? 'audio' : o
    );
    const wantsVideo = normalizedOptions.includes('video');
    const wantsAudioOnly = normalizedOptions.includes('audio_only');
    const wantsCopywriting = normalizedOptions.includes('copywriting');
    const wantsCover = normalizedOptions.includes('cover');
    const wantsAudio = normalizedOptions.includes('audio');
    const wantsSubtitle = normalizedOptions.includes('subtitle');

    // 1. 解析阶段
    store.update(taskId, { status: TASK_STATUS.PARSING, progress: 5 });

    let result = null;

    // 2. 需要实际下载的情况
    if (wantsVideo || wantsCover || wantsSubtitle || wantsAudio || wantsAudioOnly || wantsCopywriting || needAsr) {
      store.update(taskId, { status: TASK_STATUS.DOWNLOADING, progress: 10 });

      const isYouTube = /youtube\.com|youtu\.be/i.test(url);

      // 如果只想要音频(不想要视频/字幕/封面)
      const wantsOnlyAudio = wantsAudioOnly && !wantsVideo && !wantsCover && !wantsSubtitle;

      // ========== Cobalt 优先 (bilibili/facebook/tumblr/reddit 等通用平台) ==========
      const { isCobaltConfigured, downloadViaCobalt } = require('../services/cobalt');
      if (isCobaltConfigured() && wantsVideo && !wantsOnlyAudio) {
        try {
          logger.info(`[task] ${taskId} trying cobalt first (generic platform)...`);
          store.update(taskId, { status: TASK_STATUS.PARSING, progress: 5 });
          const cobaltResult = await downloadViaCobalt(url, taskId, {
            onProgress: (percent) => store.update(taskId, {
              status: percent < 90 ? TASK_STATUS.DOWNLOADING : TASK_STATUS.PROCESSING,
              progress: percent
            }),
            options: {
              videoQuality: 'max',
              filenameStyle: 'basic'
            }
          });

          if (cobaltResult.isPicker) {
            const first = cobaltResult.images[0];
            const update = {
              status: TASK_STATUS.COMPLETED,
              quality: 'image',
              progress: 100,
              downloadUrl: first.url,
              filePath: first.path,
              ext: 'jpg'
            };
            fileRefManager.addRef(first.filename);
            store.update(taskId, update);
          } else {
            const update = {
              status: TASK_STATUS.COMPLETED,
              width: 0,
              height: 0,
              quality: cobaltResult.cobaltFilename || 'max',
              progress: 100,
              downloadUrl: cobaltResult.downloadUrl,
              filePath: cobaltResult.filePath,
              ext: cobaltResult.ext
            };
            fileRefManager.addRef(`${taskId}.${cobaltResult.ext}`);
            store.update(taskId, update);
          }

          await finalizeTask(taskId);
          logger.info(`[task] ${taskId} completed via cobalt (generic platform)`);
          return;
        } catch (cobaltErr) {
          logger.warn(`[task] ${taskId} cobalt failed: ${cobaltErr.message}, falling back to yt-dlp...`);
        }
      }

      // ========== yt-dlp Fallback ==========
      result = await downloadWithLimit(async () => {
        try {
          // 如果只想要音频,使用专门的音频下载
          if (wantsOnlyAudio) {
            return await ytdlp.downloadAudio(url, taskId, (percent, speed, eta) => {
              store.update(taskId, {
                status: TASK_STATUS.DOWNLOADING,
                progress: percent,
                speed,
                eta,
                downloadedBytes: 0,
                totalBytes: 0
              });
            });
          }

          return await executeWithRetry(async () => {
            return await ytdlp.download(url, taskId, (percent, speed, eta, downloaded, total) => {
              store.update(taskId, {
                status: TASK_STATUS.DOWNLOADING,
                progress: percent,
                speed,
                eta,
                downloadedBytes: downloaded || 0,
                totalBytes: total || 0
              });
            }, quality);
          });
        } catch (err) {
          // YouTube 失败时用 Invidious 备用方案
          if (isYouTube && err.message.includes('Sign in to confirm')) {
            logger.info(`[task] ${taskId} yt-dlp failed, trying Invidious...`);
            store.update(taskId, { progress: 5 });
            return await ytdlp.downloadViaInvidious(url, taskId, (percent) => {
              store.update(taskId, {
                status: TASK_STATUS.DOWNLOADING,
                progress: percent,
              });
            });
          }
          throw err;
        }
      });

      const update = {
        status: TASK_STATUS.COMPLETED,
        width: result.width,
        height: result.height,
        quality: result.quality,
        progress: 100,
        title: result.title,
        duration: result.duration || 0,
        thumbnailUrl: result.thumbnailUrl,
      };

      // 音频下载链接(只想要音频的情况)
      if (wantsOnlyAudio) {
        update.audioUrl = `/download/${path.basename(result.filePath)}`;
        fileRefManager.addRef(path.basename(result.filePath));
      }

      // 视频下载链接
      if (wantsVideo) {
        update.filePath = result.filePath;
        update.ext = result.ext;
        update.downloadUrl = `/download/${path.basename(result.filePath)}`;
        fileRefManager.addRef(path.basename(result.filePath));
      }

      // 封面(总是返回,供显示和下载)
      const coverImage = result.thumbnailUrl || result.coverUrl;
      if (coverImage) {
        update.thumbnailUrl = coverImage;
        update.coverUrl = coverImage;
      }

      // 文案(总是提取标题和描述)
      if (result.title) {
        update.copyText = result.title;
        logger.info(`[task] ${taskId} set copyText=${result.title?.substring(0, 50)}`);
      }

      // 原声音频
      if (wantsAudio) {
        try {
          const audioPath = path.join(path.dirname(result.filePath), `${taskId}_audio.mp3`);
          await ytdlp.extractAudio(result.filePath, audioPath);
          update.audioUrl = `/download/${path.basename(audioPath)}`;
          fileRefManager.addRef(path.basename(audioPath));
        } catch (audioErr) {
          logger.error(`[audio] ${taskId} extract failed:`, audioErr);
        }
      }

      // 字幕
      if (wantsSubtitle && result.subtitleFiles && result.subtitleFiles.length > 0) {
        update.subtitleFiles = result.subtitleFiles;
      }

      store.update(taskId, update);
    } else if (wantsCopywriting) {
      // 仅文案:获取信息不下载
      const info = await ytdlp.getInfo(url);
      store.update(taskId, {
        status: TASK_STATUS.COMPLETED,
        width: 0,
        height: 0,
        quality: 'N/A',
        progress: 100,
        title: info.title,
        duration: info.duration,
        copyText: info.description || `标题: ${info.title}`,
      });
    }

    // 3. ASR(可选)
    if (needAsr && result) {
      store.update(taskId, { status: TASK_STATUS.ASR, progress: 100 });

      try {
        const task = store.get(taskId);
        const asrLang = task?.asrLanguage || 'zh';
        const asrResult = await handleAsr(taskId, result.filePath, asrLang);
        const update = { status: TASK_STATUS.COMPLETED, width: result.width, height: result.height, quality: result.quality };
        if (asrResult?.text) {
          update.asrText = asrResult.text;
          update.asrTxtUrl = asrResult.txtUrl;
          if (asrResult.translatedText) { update.translatedText = asrResult.translatedText; update.translatedTxtUrl = asrResult.translatedTxtUrl; }
        }
        store.update(taskId, update);
      } catch (asrError) {
        logger.error(`[ASR] ${taskId} failed:`, asrError);
        store.update(taskId, { asrError: asrError.message });
      }
    }

    await finalizeTask(taskId);
    logger.info(`[task] ${taskId} completed`);
  } catch (error) {
    logger.error(`[task] ${taskId} failed:`, error);
    store.update(taskId, { status: TASK_STATUS.ERROR, error: error.message });
  } finally {
    taskLock.release(taskId);
  }
}

/**
 * 处理抖音下载(视频/图文,不依赖 yt-dlp)
 */
async function processDouyin(taskId, url, needAsr, options = ['video'], quality = null, asrLanguage = 'zh', requestedQuality = null, isVip = false) {
  // 获取任务锁
  if (!taskLock.tryAcquire(taskId)) {
    logger.warn(`[task] ${taskId} is already being processed`);
    store.update(taskId, { 
      status: TASK_STATUS.ERROR, 
      error: 'Task is already in progress' 
    });
    return;
  }

  try {
    // 主力：iesdouyin.com 解析器（免费稳定，不需要 API Key）
    const { downloadDouyin } = require('../services/douyin');
    const ytdlp = require('../services/yt-dlp');
    const { parseDouyin: parseDouyinTikHub } = require('../services/tikhub');

    store.update(taskId, { status: TASK_STATUS.PARSING, progress: 5, requestedQuality });

    let result;
    let usedYtdlpFallback = false;

    // Step 1: 尝试 iesdouyin.com（主力方案）
    try {
      store.update(taskId, { status: TASK_STATUS.PARSING, progress: 5 });
      result = await downloadDouyin(url, taskId, (percent, msg) => {
        store.update(taskId, {
          status: percent < 90 ? TASK_STATUS.DOWNLOADING : TASK_STATUS.PROCESSING,
          progress: percent,
        });
      }, { quality, isVip });
      logger.info(`[task] ${taskId} iesdouyin.com succeeded (quality=${result.quality}, watermarked=${!!result.watermarked})`);
    } catch (iesErr) {
      logger.warn(`[task] ${taskId} iesdouyin.com failed: ${iesErr.message}, trying TikHub...`);

      // Step 2: TikHub API fallback
      try {
        store.update(taskId, { status: TASK_STATUS.PARSING, progress: 5 });
        const tikhubResult = await parseDouyinTikHub(url, taskId, (percent, downloaded, total) => {
          store.update(taskId, {
            status: percent < 30 ? TASK_STATUS.PARSING : TASK_STATUS.DOWNLOADING,
            progress: percent,
            downloadedBytes: downloaded || 0,
            totalBytes: total || 0
          });
        }, quality, isVip);
        result = tikhubResult;
        logger.info(`[task] ${taskId} TikHub succeeded`);
      } catch (tikhubErr) {
        logger.warn(`[task] ${taskId} TikHub failed: ${tikhubErr.message}, trying yt-dlp...`);

        // Step 3: yt-dlp 最后的兜底
        try {
          store.update(taskId, { status: TASK_STATUS.PARSING, progress: 5 });
          const ytdlpResult = await ytdlp.download(url, taskId, (percent, speed, eta, downloaded, total) => {
            store.update(taskId, {
              status: percent < 90 ? TASK_STATUS.DOWNLOADING : TASK_STATUS.PROCESSING,
              progress: Math.round(percent * 0.9),
              downloadedBytes: downloaded || 0,
              totalBytes: total || 0,
              speed: speed || '',
              eta: eta || ''
            });
          }, quality);
          result = {
            title: ytdlpResult.title || '抖音作品',
            width: 0,
            height: 0,
            quality: ytdlpResult.ext || 'mp4',
            thumbnailUrl: ytdlpResult.thumbnailUrl || '',
            filePath: ytdlpResult.filePath,
            ext: ytdlpResult.ext || 'mp4'
          };
          usedYtdlpFallback = true;
          logger.info(`[task] ${taskId} yt-dlp fallback succeeded`);
        } catch (ytdlpErr) {
          logger.error(`[task] ${taskId} yt-dlp fallback also failed: ${ytdlpErr.message}`);
          throw new Error(`抖音解析失败: iesdouyin(${iesErr.message}) → TikHub(${tikhubErr.message}) → yt-dlp(${ytdlpErr.message})`);
        }
      }
    }

    // 获取用户请求的画质
    let task = store.get(taskId) || {};
    const reqQ = task.requestedQuality || requestedQuality;

    // 计算画质调整提示
    let qualityAdjusted = null;
    if (reqQ && result.height) {
      const reqMatch = reqQ.match(/height<=(\d+)/i);
      if (reqMatch) {
        const reqHeight = parseInt(reqMatch[1]);
        if (result.height < reqHeight) {
          qualityAdjusted = 'downgrade'; // 降级
        } else if (result.height > reqHeight) {
          qualityAdjusted = 'upgrade'; // 升级
        }
      }
    }

    const update = {
      status: TASK_STATUS.COMPLETED,
      width: result.width,
      height: result.height,
      quality: result.quality,
      qualityAdjusted,
      progress: 100,
      title: result.title,
      thumbnailUrl: result.thumbnailUrl,
    };

    if (result.filePath) {
      update.filePath = result.filePath;
      update.ext = result.ext;
      update.downloadUrl = `/download/${path.basename(result.filePath)}`;
      fileRefManager.addRef(path.basename(result.filePath));
    }

    // 处理封面
    if (options.includes('cover') && result.thumbnailUrl) {
      update.coverUrl = result.thumbnailUrl;
    }

    // 处理文案
    if (options.includes('copywriting')) {
      update.copyText = result.title || '抖音作品';
    }

    // 处理纯音频
    const wantsAudioOnly = options.includes('audio') && !options.includes('video');
    if (wantsAudioOnly && result.filePath) {
      try {
        const audioPath = path.join(path.dirname(result.filePath), `${taskId}.mp3`);
        const { spawn } = require('child_process');
        await new Promise((resolve, reject) => {
          const ff = spawn('ffmpeg', ['-i', result.filePath, '-vn', '-acodec', 'libmp3lame', '-b:a', '128k', '-y', audioPath]);
          const timer = setTimeout(() => { ff.kill('SIGKILL'); reject(new Error('timeout')); }, TIMEOUT.FFMPEG);
          ff.on('close', code => { clearTimeout(timer); code === 0 ? resolve() : reject(new Error('ffmpeg exit ' + code)); });
          ff.on('error', err => { clearTimeout(timer); reject(err); });
        });
        update.downloadUrl = `/download/${taskId}.mp3`;
        update.filePath = audioPath;
        update.ext = 'mp3';
        update.audioUrl = `/download/${taskId}.mp3`;
        fileRefManager.addRef(`${taskId}.mp3`);
        // 删除视频文件
        await asyncFs.safeUnlink(result.filePath);
      } catch (e) {
        logger.error(`[audio] ${taskId} extract failed:`, e.message);
      }
    }

    // 处理 ASR + 翻译
    if (needAsr && result.filePath) {
      try {
        store.update(taskId, { status: TASK_STATUS.ASR, progress: 100 });
        const asr = require('../services/asr');
        const audioPath = path.join(path.dirname(result.filePath), `${taskId}_asr.mp3`);

        // 提取音频
        const { spawn } = require('child_process');
        await new Promise((resolve, reject) => {
          const ff = spawn('ffmpeg', ['-i', result.filePath, '-vn', '-acodec', 'libmp3lame', '-b:a', '128k', '-y', audioPath]);
          const timer = setTimeout(() => { ff.kill('SIGKILL'); reject(new Error('timeout')); }, TIMEOUT.FFMPEG);
          ff.on('close', code => { clearTimeout(timer); code === 0 ? resolve() : reject(new Error('ffmpeg exit ' + code)); });
          ff.on('error', err => { clearTimeout(timer); reject(err); });
        });

        // ASR 转文字
        const text = await asr.transcribe(audioPath, asrLanguage);
        if (text) {
          update.asrText = text;
          update.asrTxtUrl = await saveTextFile(taskId, text, 'subtitle');
        }

        // 翻译
        let task = store.get(taskId);
        if (task?.targetLang && text) {
          try {
            const translated = await asr.translateText(text, asrLanguage === 'auto' ? 'zh' : asrLanguage, task.targetLang);
            if (translated) {
              update.translatedText = translated;
              update.translatedTxtUrl = await saveTextFile(taskId, translated, 'translation');
            }
          } catch (e) {
            logger.error(`[ASR] ${taskId} translate failed:`, e.message);
          }
        }

        // 清理临时音频
        await asyncFs.safeUnlink(audioPath);
      } catch (asrError) {
        logger.error(`[ASR] ${taskId} failed:`, asrError.message);
        update.asrError = asrError.message;
      }
    }

    store.update(taskId, update);

    await finalizeTask(taskId);
    logger.info(`[task] ${taskId} douyin completed`);
  } catch (error) {
    logger.error(`[task] ${taskId} douyin failed:`, error);
    store.update(taskId, { status: TASK_STATUS.ERROR, error: error.message });
  } finally {
    // 释放任务锁
    taskLock.release(taskId);
  }
}

/**
 * 处理 X/Twitter 下载
 */
async function processX(taskId, url, needAsr, options = ['video']) {
  // 获取任务锁
  if (!taskLock.tryAcquire(taskId)) {
    logger.warn(`[task] ${taskId} is already being processed`);
    store.update(taskId, { 
      status: TASK_STATUS.ERROR, 
      error: 'Task is already in progress' 
    });
    return;
  }

  try {
    const { downloadX } = require('../services/x-download');
    store.update(taskId, { status: TASK_STATUS.PARSING, progress: 5 });
    const result = await downloadX(url, taskId, (percent, msg) => {
      store.update(taskId, {
        status: percent < 30 ? TASK_STATUS.PARSING : TASK_STATUS.DOWNLOADING,
        progress: percent
      });
    });

    // 检查是否有可用的下载链接
    if (!result.downloadUrl && (!result.images || result.images.length === 0)) {
      throw new Error('X/Twitter 视频解析失败,无法下载');
    }

    const update = {
      status: TASK_STATUS.COMPLETED,
      width: result.width || 0,
      height: result.height || 0,
      quality: result.quality || 'unknown',
      progress: 100,
      title: result.title,
      thumbnailUrl: result.thumbnailUrl || '',
    };
    if (result.downloadUrl) {
      update.filePath = result.filePath;
      update.ext = result.ext || 'mp4';
      update.downloadUrl = result.downloadUrl;
      fileRefManager.addRef(path.basename(result.filePath));
    }
    if (result.images) {
      update.imageFiles = result.images;
    }

    // 纯音频
    const wantsAudioOnly = options.includes('audio') && !options.includes('video');
    if (wantsAudioOnly && result.filePath) {
      try {
        const audioPath = path.join(path.dirname(result.filePath), taskId + '.mp3');
        const { spawn } = require('child_process');
        await new Promise((resolve, reject) => {
          const ff = spawn('ffmpeg', ['-i', result.filePath, '-vn', '-acodec', 'libmp3lame', '-b:a', '128k', '-y', audioPath]);
          const timer = setTimeout(() => { ff.kill('SIGKILL'); reject(new Error('timeout')); }, TIMEOUT.FFMPEG);
          ff.on('close', code => { clearTimeout(timer); code === 0 ? resolve() : reject(new Error('ffmpeg exit ' + code)); });
          ff.on('error', err => { clearTimeout(timer); reject(err); });
        });
        update.downloadUrl = '/download/' + taskId + '.mp3';
        update.filePath = audioPath;
        update.ext = 'mp3';
        fileRefManager.addRef(taskId + '.mp3');
        await asyncFs.safeUnlink(result.filePath);
      } catch (e) {
        logger.error('[x audio] extract failed:', e.message);
      }
    }

    store.update(taskId, update);

    // ASR 语音转文字
    if (needAsr && update.filePath) {
      const asrResult = await handleAsr(taskId, update.filePath, 'zh');
      if (asrResult?.text) { const upd = { status: TASK_STATUS.COMPLETED, asrText: asrResult.text, asrTxtUrl: asrResult.txtUrl }; if (asrResult.translatedText) { upd.translatedText = asrResult.translatedText; upd.translatedTxtUrl = asrResult.translatedTxtUrl; } store.update(taskId, upd); }
    }

    await finalizeTask(taskId);
    logger.info(`[task] ${taskId} x completed`);
  } catch (error) {
    logger.error(`[task] ${taskId} x failed:`, error);
    store.update(taskId, { status: TASK_STATUS.ERROR, error: error.message || 'X/Twitter 下载失败' });
  } finally {
    taskLock.release(taskId);
  }
}

/**
 * 处理 YouTube 下载 (TikHub API)
 */
async function processYouTube(taskId, url, needAsr, options = ['video'], quality = null) {
  // 获取任务锁
  if (!taskLock.tryAcquire(taskId)) {
    logger.warn(`[task] ${taskId} is already being processed`);
    store.update(taskId, { 
      status: TASK_STATUS.ERROR, 
      error: 'Task is already in progress' 
    });
    return;
  }

  try {
    logger.info('[processYouTube] CALLED for task:', taskId, 'url:', url, 'quality:', quality);
    const path = require('path');

    store.update(taskId, { status: TASK_STATUS.PARSING, progress: 5 });
    store.update(taskId, { requestedQuality: quality });

    // Parse quality from height<= format if present
    let videoQuality = 'max';
    if (quality && quality.includes('height<=')) {
      const match = quality.match(/height<=(\d+)/);
      if (match) videoQuality = match[1] + 'p';
    }

    // ========== Cobalt (第一优先 - 更高画质 + 免费) ==========
    const { isCobaltConfigured, downloadViaCobalt } = require('../services/cobalt');
    let cobaltResult = null;
    if (isCobaltConfigured()) {
      try {
        logger.info(`[task] ${taskId} youtube trying cobalt first...`);
        cobaltResult = await downloadViaCobalt(url, taskId, {
          onProgress: (percent) => store.update(taskId, {
            status: percent < 90 ? TASK_STATUS.DOWNLOADING : TASK_STATUS.PROCESSING,
            progress: percent
          }),
          options: {
            videoQuality,
            youtubeVideoCodec: 'h264',
            filenameStyle: 'basic'
          }
        });
      } catch (cobaltErr) {
        logger.warn(`[task] ${taskId} cobalt failed: ${cobaltErr.message}, trying TikHub...`);
      }
    }

    // Cobalt 成功
    if (cobaltResult) {
      const cobaltUpdate = {
        status: TASK_STATUS.COMPLETED,
        height: 1080,
        quality: cobaltResult.cobaltFilename || '1080p',
        progress: 100,
        downloadUrl: cobaltResult.downloadUrl,
        filePath: cobaltResult.filePath,
        ext: cobaltResult.ext
      };
      fileRefManager.addRef(cobaltResult.filePath.split('/').pop());
      store.update(taskId, cobaltUpdate);

      await finalizeTask(taskId);
      logger.info(`[task] ${taskId} youtube completed via cobalt`);
      return;
    }

    // ========== TikHub v2 API Fallback ==========
    let result = null;
    try {
      const { parseYouTubeV2 } = require('../services/tikhub');
      result = await parseYouTubeV2(url, taskId, (percent, downloaded, total) => {
        store.update(taskId, {
          status: percent < 30 ? TASK_STATUS.PARSING : TASK_STATUS.DOWNLOADING,
          progress: percent,
          downloadedBytes: downloaded || 0,
          totalBytes: total || 0
        });
      }, quality);
    } catch (tikhubErr) {
      logger.warn(`[task] ${taskId} TikHub failed: ${tikhubErr.message}, trying yt-dlp...`);
    }

    if (result) {
      const update = {
        status: TASK_STATUS.COMPLETED,
        width: result.width,
        height: result.height,
        quality: result.quality || `${result.height}p`,
        progress: 100,
        title: result.title,
        thumbnailUrl: result.thumbnailUrl,
        downloadUrl: `/download/${taskId}.mp4`,
        filePath: result.filePath,
        ext: 'mp4'
      };
      fileRefManager.addRef(`${taskId}.mp4`);
      store.update(taskId, update);

      await finalizeTask(taskId);
      logger.info(`[task] ${taskId} youtube completed via TikHub v2 (${result.quality})`);
      return;
    }

    // ========== Yout.com API (解决 Vultr IP 被 Google 封锁问题) ==========
    const { isYoutConfigured, downloadViaYout } = require('../services/yout');
    if (isYoutConfigured()) {
      try {
        logger.info(`[task] ${taskId} youtube trying yout.com API...`);
        
        // 先获取视频信息（标题）
        let videoTitle = 'YouTube Video';
        try {
          const infoRes = await axios.post(`${API_BASE}/video-info`, { url }, { timeout: 15000 });
          videoTitle = infoRes.data.data?.title || videoTitle;
        } catch (e) {
          logger.warn(`[task] ${taskId} failed to get video title: ${e.message}`);
        }

        const youtResult = await downloadViaYout(url, taskId, videoQuality, (percent, speed, eta) => {
          store.update(taskId, {
            status: percent < 90 ? TASK_STATUS.DOWNLOADING : TASK_STATUS.PROCESSING,
            progress: percent,
            speed: speed ? `${Math.round(speed / 1024)}KB/s` : '',
            eta: eta ? `${Math.round(eta)}s` : ''
          });
        });

        const youtUpdate = {
          status: TASK_STATUS.COMPLETED,
          height: videoQuality === 'max' ? 2160 : (parseInt(videoQuality) || 1080),
          quality: videoQuality === 'max' ? '4K' : videoQuality,
          progress: 100,
          title: videoTitle,
          downloadUrl: `/download/${youtResult.filename}`,
          filePath: youtResult.filePath,
          ext: 'mp4'
        };
        fileRefManager.addRef(youtResult.filename);
        store.update(taskId, youtUpdate);

        await finalizeTask(taskId);
        logger.info(`[task] ${taskId} youtube completed via yout.com`);
        return;
      } catch (youtErr) {
        logger.warn(`[task] ${taskId} yout.com failed: ${youtErr.message}, trying yt-dlp...`);
      }
    }

    // ========== yt-dlp 最终兜底 ==========
    logger.info(`[task] ${taskId} youtube trying yt-dlp...`);
    const ytdlp = require('../services/yt-dlp');
    store.update(taskId, { status: TASK_STATUS.PARSING, progress: 5 });

    const ytdlpResult = await ytdlp.download(url, taskId, (percent, speed, eta, downloaded, total) => {
      store.update(taskId, {
        status: percent < 90 ? TASK_STATUS.DOWNLOADING : TASK_STATUS.PROCESSING,
        progress: Math.round(percent),
        downloadedBytes: downloaded || 0,
        totalBytes: total || 0,
        speed: speed || '',
        eta: eta || ''
      });
    });

    const update = {
      status: TASK_STATUS.COMPLETED,
      height: ytdlpResult.height || 720,
      quality: ytdlpResult.ext || 'mp4',
      progress: 100,
      title: ytdlpResult.title || 'YouTube Video',
      thumbnailUrl: ytdlpResult.thumbnailUrl || '',
      downloadUrl: `/download/${taskId}.mp4`,
      filePath: ytdlpResult.filePath,
      ext: ytdlpResult.ext || 'mp4'
    };
    fileRefManager.addRef(`${taskId}.mp4`);
    store.update(taskId, update);

    await finalizeTask(taskId);
    logger.info(`[task] ${taskId} youtube completed via yt-dlp`);
  } catch (error) {
    logger.error(`[task] ${taskId} YouTube failed:`, error);
    store.update(taskId, { status: TASK_STATUS.ERROR, error: error.message });
  } finally {
    // 释放任务锁
    taskLock.release(taskId);
  }
}

/**
 * 处理 TikTok 下载 (TikHub API)
 */
async function processTikTok(taskId, url, needAsr, options = ['video'], quality = null) {
  // 获取任务锁
  if (!taskLock.tryAcquire(taskId)) {
    logger.warn(`[task] ${taskId} is already being processed`);
    store.update(taskId, { 
      status: TASK_STATUS.ERROR, 
      error: 'Task is already in progress' 
    });
    return;
  }

  try {
    store.update(taskId, { status: TASK_STATUS.PARSING, progress: 5 });

    // 从 URL 提取视频 ID
    let videoId = null;

    // 直接从 URL 匹配 /video/123456
    const idMatch = url.match(/\/video\/(\d+)/);
    if (idMatch) videoId = idMatch[1];

    // 短链:先 resolve 获取真实 URL
    if (!videoId) {
      try {
        // 方法1: HEAD 请求跟踪重定向
        const headResp = await axios.head(url, { maxRedirects: 5, timeout: TIMEOUT.API_REQUEST });
        const redirectUrl = headResp.request?.res?.responseUrl || headResp.headers?.location || '';
        const redirectMatch = redirectUrl.match(/\/video\/(\d+)/);
        if (redirectMatch) videoId = redirectMatch[1];
      } catch (e) {}

      // 方法2: GET 请求从 HTML 提取
      if (!videoId) {
        try {
          const resp = await axios.get(url, {
            maxRedirects: 5,
            timeout: TIMEOUT.API_REQUEST,
            headers: { 'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X)' }
          });
          const finalUrl = resp.request?.res?.responseUrl || '';
          const finalMatch = finalUrl.match(/\/video\/(\d+)/);
          if (finalMatch) videoId = finalMatch[1];
          if (!videoId) {
            const html = typeof resp.data === 'string' ? resp.data : '';
            const match = html.match(/"aweme_id":"(\d+)"/) || html.match(/video\/(\d+)/);
            if (match) videoId = match[1] || match[0].match(/\d+/)?.[0];
          }
        } catch (e) {}
      }
    }

    if (!videoId) {
      throw new Error('无法提取 TikTok 视频ID');
    }

    store.update(taskId, { progress: 15 });

    // 调用 TikHub TikTok App V3 API(用抖音 API key)
    const data = await tikhubRequest(
      '/api/v1/tiktok/app/v3/fetch_one_video?aweme_id=' + videoId,
      API_KEY_DOUYIN
    );

    const detail = data?.aweme_detail || {};
    const video = detail.video || {};
    const title = detail.desc || 'TikTok Video';

    // 获取下载链接(优先高画质 bit_rate)
    let videoUrl = null;
    const bitrates = video.bit_rate || [];
    if (bitrates.length > 0) {
      // 取最高画质
      const best = bitrates.sort((a, b) =>
        (b.play_addr?.height || 0) - (a.play_addr?.height || 0)
      )[0];
      videoUrl = best?.play_addr?.url_list?.[0];
    }
    if (!videoUrl && video.play_addr?.url_list?.[0]) {
      videoUrl = video.play_addr.url_list[0];
    }
    if (!videoUrl && video.download_addr?.url_list?.[0]) {
      videoUrl = video.download_addr.url_list[0];
    }

    if (!videoUrl) {
      throw new Error('无法获取 TikTok 视频下载链接');
    }

    store.update(taskId, { status: TASK_STATUS.DOWNLOADING, progress: 30 });

    // 下载视频到服务器
    const filename = taskId + '.mp4';
    const outputPath = path.join(__dirname, '../../downloads', filename);
    await downloadToStream(videoUrl, outputPath, TIMEOUT.DOWNLOAD);

    // 获取封面
    const coverUrl = video.cover?.url_list?.[0] || video.origin_cover?.url_list?.[0] || '';

    const update = {
      status: TASK_STATUS.COMPLETED,
      progress: 100,
      title: title,
      duration: video.duration ? Math.floor(video.duration / 1000) : 0,
      thumbnailUrl: coverUrl,
      coverUrl: coverUrl,
      downloadUrl: '/download/' + filename,
      filePath: outputPath,
      ext: 'mp4',
      copyText: title
    };

    fileRefManager.addRef(filename);

    // 纯音频
    const wantsAudioOnly = options.includes('audio') && !options.includes('video');
    if (wantsAudioOnly) {
      try {
        const audioPath = path.join(__dirname, '../../downloads', taskId + '.mp3');
        const { spawn } = require('child_process');
        await new Promise((resolve, reject) => {
          const ff = spawn('ffmpeg', ['-i', outputPath, '-vn', '-acodec', 'libmp3lame', '-b:a', '128k', '-y', audioPath]);
          const timer = setTimeout(() => { ff.kill('SIGKILL'); reject(new Error('timeout')); }, TIMEOUT.FFMPEG);
          ff.on('close', code => { clearTimeout(timer); code === 0 ? resolve() : reject(new Error('ffmpeg exit ' + code)); });
          ff.on('error', err => { clearTimeout(timer); reject(err); });
        });
        update.downloadUrl = '/download/' + taskId + '.mp3';
        update.filePath = audioPath;
        update.ext = 'mp3';
        update.audioUrl = '/download/' + taskId + '.mp3';
        fileRefManager.addRef(taskId + '.mp3');
        await asyncFs.safeUnlink(outputPath);
      } catch (e) {
        logger.error('[tiktok audio] extract failed:', e.message);
      }
    }

    store.update(taskId, update);

    // ASR 语音转文字
    if (needAsr && update.filePath) {
      const asrResult = await handleAsr(taskId, update.filePath, 'zh');
      if (asrResult?.text) { const upd = { status: TASK_STATUS.COMPLETED, asrText: asrResult.text, asrTxtUrl: asrResult.txtUrl }; if (asrResult.translatedText) { upd.translatedText = asrResult.translatedText; upd.translatedTxtUrl = asrResult.translatedTxtUrl; } store.update(taskId, upd); }
    }

    await finalizeTask(taskId);
    logger.info(`[task] ${taskId} tiktok completed`);
  } catch (error) {
    logger.error(`[task] ${taskId} tiktok failed:`, error);
    store.update(taskId, {
      status: TASK_STATUS.ERROR,
      progress: 0,
      error: error.message || 'TikTok 下载失败'
    });
  } finally {
    taskLock.release(taskId);
  }
}

/**
 * 处理小红书下载 (TikHub API)
 */
async function processXiaohongshu(taskId, url, needAsr, options = ['video']) {
  // 获取任务锁
  if (!taskLock.tryAcquire(taskId)) {
    logger.warn(`[task] ${taskId} is already being processed`);
    store.update(taskId, { 
      status: TASK_STATUS.ERROR, 
      error: 'Task is already in progress' 
    });
    return;
  }

  try {
    const { parseXiaohongshu } = require('../services/tikhub');
    store.update(taskId, { status: TASK_STATUS.PARSING, progress: 5 });

    const result = await parseXiaohongshu(url, taskId, (percent) => {
      store.update(taskId, {
        status: percent < 20 ? TASK_STATUS.PARSING : TASK_STATUS.DOWNLOADING,
        progress: percent
      });
    });

    const update = {
      status: TASK_STATUS.COMPLETED,
      width: result.width,
      height: result.height,
      quality: result.quality,
      progress: 100,
      title: result.title,
      thumbnailUrl: result.thumbnailUrl,
    };

    if (result.filePath) {
      update.filePath = result.filePath;
      update.ext = result.ext;
      update.downloadUrl = `/download/${path.basename(result.filePath)}`;
      fileRefManager.addRef(path.basename(result.filePath));
    }

    if (result.isNote && result.imageFiles) {
      update.isNote = true;
      update.imageFiles = result.imageFiles;
    }

    store.update(taskId, update);

    await finalizeTask(taskId);
    logger.info(`[task] ${taskId} xiaohongshu completed`);
  } catch (error) {
    logger.error(`[task] ${taskId} xiaohongshu failed:`, error);
    store.update(taskId, { status: TASK_STATUS.ERROR, error: error.message });
  } finally {
    taskLock.release(taskId);
  }
}

/**
 * 处理 Instagram 下载（TikHub API）
 */
async function processInstagram(taskId, url, needAsr, options = ['video']) {
  // 获取任务锁
  if (!taskLock.tryAcquire(taskId)) {
    logger.warn(`[task] ${taskId} is already being processed`);
    store.update(taskId, {
      status: TASK_STATUS.ERROR,
      error: 'Task is already in progress'
    });
    return;
  }

  try {
    store.update(taskId, { status: TASK_STATUS.PARSING, progress: 5 });

    // ========== Cobalt (第一优先 - 更高画质 + 免费) ==========
    let cobaltResult = null;
    const { isCobaltConfigured, downloadViaCobalt } = require('../services/cobalt');

    if (isCobaltConfigured()) {
      try {
        logger.info(`[task] ${taskId} instagram trying cobalt first...`);
        cobaltResult = await downloadViaCobalt(url, taskId, {
          onProgress: (percent) => store.update(taskId, {
            status: percent < 90 ? TASK_STATUS.DOWNLOADING : TASK_STATUS.PROCESSING,
            progress: percent
          }),
          options: {
            videoQuality: 'max',
            filenameStyle: 'basic'
          }
        });
      } catch (cobaltErr) {
        logger.warn(`[task] ${taskId} cobalt failed: ${cobaltErr.message}, trying TikHub...`);
      }
    } else {
      logger.info(`[task] ${taskId} cobalt not configured, skipping to TikHub...`);
    }

    // Cobalt 成功
    if (cobaltResult) {
      if (cobaltResult.isPicker) {
        // 图集：返回第一张
        const first = cobaltResult.images[0];
        const update = {
          status: TASK_STATUS.COMPLETED,
          quality: 'image',
          progress: 100,
          downloadUrl: first.url,
          filePath: first.path,
          ext: 'jpg'
        };
        fileRefManager.addRef(first.filename);
        store.update(taskId, update);
      } else {
        const update = {
          status: TASK_STATUS.COMPLETED,
          quality: cobaltResult.cobaltFilename || 'max',
          progress: 100,
          downloadUrl: cobaltResult.downloadUrl,
          filePath: cobaltResult.filePath,
          ext: cobaltResult.ext
        };
        fileRefManager.addRef(`${taskId}.${cobaltResult.ext}`);
        store.update(taskId, update);
      }

      await finalizeTask(taskId);
      logger.info(`[task] ${taskId} instagram completed via cobalt`);
      return;
    }

    // ========== TikHub Fallback ==========
    logger.info(`[task] ${taskId} instagram trying TikHub...`);
    const { parseInstagram } = require('../services/tikhub');
    store.update(taskId, { status: TASK_STATUS.PARSING, progress: 10 });

    const info = await parseInstagram(url);
    store.update(taskId, { title: info.title, thumbnailUrl: info.thumbnailUrl, progress: 20 });

    const outputPath = path.join(__dirname, '../../downloads', `${taskId}.mp4`);
    store.update(taskId, { status: TASK_STATUS.DOWNLOADING, progress: 30 });

    await downloadToStream(info.videoUrl, outputPath, TIMEOUT.DOWNLOAD);

    const update = {
      status: TASK_STATUS.COMPLETED,
      width: info.width,
      height: info.height,
      quality: `${info.width}x${info.height}`,
      progress: 100,
      title: info.title,
      thumbnailUrl: info.thumbnailUrl,
      downloadUrl: `/download/${taskId}.mp4`,
      filePath: outputPath,
      ext: 'mp4'
    };

    fileRefManager.addRef(`${taskId}.mp4`);
    store.update(taskId, update);

    await finalizeTask(taskId);
    logger.info(`[task] ${taskId} instagram completed via TikHub`);
  } catch (error) {
    logger.error(`[task] ${taskId} instagram failed:`, error);
    store.update(taskId, { status: TASK_STATUS.ERROR, error: error.message });
  } finally {
    // 释放任务锁
    taskLock.release(taskId);
  }
}

/**
 * 查询任务状态
 */
function getStatus(req, res) {
  const { taskId } = req.params;
  const task = store.get(taskId);

  if (!task) {
    return res.json({ code: 404, message: '任务不存在' });
  }

  // 保存下载历史(仅首次完成时)
  if (task.status === 'completed' && !task.historySaved) {
    const userDb = require('../userDb');
    userDb.addHistory({
      userId: task.userId,
      guestIp: task.guestIp,
      taskId: task.taskId,
      url: task.url,
      platform: task.platform,
      title: task.title,
      thumbnailUrl: task.thumbnailUrl,
      duration: task.duration
    }).catch(e => logger.error('[history]', e.message));
    store.update(taskId, { historySaved: true });
  }

  res.json({
    code: 0,
    data: {
      taskId: task.taskId,
      url: task.url,
      status: task.status,
      progress: task.progress || 0,
      title: task.title,
      duration: task.duration,
      platform: task.platform,
      speed: task.speed,
      eta: task.eta,
      thumbnailUrl: task.thumbnailUrl,
      downloadUrl: task.downloadUrl,
      subtitleFiles: task.subtitleFiles || [],
      asrText: task.asrText,
      asrTxtUrl: task.asrTxtUrl,
      translatedText: task.translatedText,
      translatedTxtUrl: task.translatedTxtUrl,
      asrError: task.asrError,
      copyText: task.copyText,
      copyTxtUrl: task.copyTxtUrl,
      coverUrl: task.coverUrl,
      audioUrl: task.audioUrl,
      imageFiles: task.imageFiles,
      isNote: task.isNote,
      error: task.error,
      downloadedBytes: task.downloadedBytes || 0,
      totalBytes: task.totalBytes || 0,
      createdAt: task.createdAt
    }
  });
}

/**
 * 获取历史记录
 */
async function getHistory(req, res) {
  const { limit = 50, offset = 0 } = req.query;

  // 获取用户身份
  let userId = null;
  let guestIp = null;
  let isGuest = true;

  const authHeader = req.headers.authorization;
  if (authHeader && authHeader.startsWith('Bearer ')) {
    try {
      const token = authHeader.slice(7);
      const jwt = require('jsonwebtoken');
      const JWT_SECRET = process.env.JWT_SECRET;
      const payload = jwt.verify(token, JWT_SECRET);
      const userDb = require('../userDb');
      const user = await userDb.getById(payload.sub);
      if (user) {
        isGuest = false;
        userId = user.id;
      }
    } catch (e) {
      // token 无效,继续作为游客
    }
  }

  if (isGuest) {
    guestIp = req.ip || req.headers['x-forwarded-for']?.split(',')[0] || 'unknown';
  }

  // 过滤任务（游客按 guestIp 过滤）
  const allTasks = store.list().filter(task => {
    if (isGuest) {
      return !task.userId && task.guestIp === guestIp;
    } else {
      return task.userId === userId;
    }
  });

  // 查询数据库历史（超出内存清理的旧记录）
  const userDb = require('../userDb');
  let dbHistory = [];
  try {
    dbHistory = await userDb.getHistory(userId, guestIp, parseInt(limit) + parseInt(offset));
  } catch (e) {
    logger.error('[history] DB query failed:', e.message);
  }

  // 合并：内存中的任务 + 数据库历史（去重）
  const taskIds = new Set(allTasks.map(t => t.taskId));
  for (const h of dbHistory) {
    if (!taskIds.has(h.task_id)) {
      allTasks.push({
        taskId: h.task_id,
        url: h.url,
        platform: h.platform,
        title: h.title,
        thumbnailUrl: h.thumbnail_url,
        duration: h.duration,
        status: 'completed',
        createdAt: h.created_at * 1000,
        fromDb: true
      });
    }
  }

  // 按时间倒序
  allTasks.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));

  const tasks = allTasks.slice(parseInt(offset), parseInt(offset) + parseInt(limit));

  res.json({
    code: 0,
    data: {
      tasks,
      total: allTasks.length
    }
  });
}

/**
 * 获取系统状态
 */
function getSystemStatus(req, res) {
  const limiterStatus = getLimiterStatus();
  const tasks = store.list();

  res.json({
    code: 0,
    data: {
      version: '2.0.0',
      concurrency: limiterStatus,
      totalTasks: tasks.length,
      activeTasks: tasks.filter(t =>
        t.status === 'pending' || t.status === 'parsing' ||
        t.status === 'downloading' || t.status === 'asr'
      ).length
    }
  });
}

/**
 * 删除任务
 */
async function deleteTask(req, res) {
  const { taskId } = req.params;
  const task = store.get(taskId);

  if (!task) {
    return res.json({ code: 404, message: '任务不存在' });
  }

  // 检查权限:登录用户只能删自己的任务
  const userId = req.user?.id;
  const guestIp = req.ip || req.headers['x-forwarded-for']?.split(',')[0] || 'unknown';
  const canDelete = (userId && task.userId === userId) || (!task.userId && task.guestIp === guestIp);

  if (!canDelete) {
    return res.json({ code: 403, message: '无权删除此任务' });
  }

  store.removeWithFiles(taskId);
  res.json({ code: 0, message: '删除成功' });
}


async function getAdminStats(req, res) {
  const tasks = store.list();
  const now = Date.now();
  const todayStart = new Date(); todayStart.setHours(0,0,0,0);
  const weekStart = now - 7 * 86400000;

  const userDb = require('../userDb');
  let totalUsers = 0, vipUsers = 0;
  try {
    const userCount = await userDb.db.execute('SELECT COUNT(*) as count FROM users');
    totalUsers = userCount.rows[0]?.count || 0;
    const vipCount = await userDb.db.execute("SELECT COUNT(*) as count FROM users WHERE tier = 'pro'");
    vipUsers = vipCount.rows[0]?.count || 0;
  } catch (e) {}

  let totalDownloads = 0, todayDownloads = 0, weekDownloads = 0;
  try {
    const totalR = await userDb.db.execute('SELECT COUNT(*) as count FROM download_history');
    totalDownloads = totalR.rows[0]?.count || 0;
    const todayR = await userDb.db.execute({ sql: 'SELECT COUNT(*) as count FROM download_history WHERE created_at >= ?', args: [Math.floor(todayStart.getTime() / 1000)] });
    todayDownloads = todayR.rows[0]?.count || 0;
    const weekR = await userDb.db.execute({ sql: 'SELECT COUNT(*) as count FROM download_history WHERE created_at >= ?', args: [Math.floor(weekStart / 1000)] });
    weekDownloads = weekR.rows[0]?.count || 0;
  } catch (e) {}

  const platformCounts = {};
  for (const t of tasks) {
    const p = t.platform || 'unknown';
    platformCounts[p] = (platformCounts[p] || 0) + 1;
  }
  try {
    const platR = await userDb.db.execute('SELECT platform, COUNT(*) as c FROM download_history GROUP BY platform');
    for (const row of platR.rows) {
      const rowPlatform = row.platform || 'unknown';
      platformCounts[rowPlatform] = (platformCounts[rowPlatform] || 0) + Number(row.c || 0);
    }
  } catch (e) {}

  res.json({
    code: 0,
    data: {
      users: { total: totalUsers, vip: vipUsers },
      downloads: { total: totalDownloads, today: todayDownloads, week: weekDownloads },
      memory: {
        totalTasks: tasks.length,
        activeTasks: tasks.filter(t => ['pending','parsing','downloading','asr'].includes(t.status)).length,
        completedTasks: tasks.filter(t => t.status === 'completed').length,
        errorTasks: tasks.filter(t => t.status === 'error').length
      },
      platforms: platformCounts
    }
  });
}

async function adminClearAllHistory(req, res) {
  const userDb = require('../userDb');
  try {
    await userDb.clearAllHistory();
    store.list().forEach(t => store.removeWithFiles(t.taskId));
    res.json({ code: 0, message: 'All history cleared' });
  } catch (e) {
    res.json({ code: 500, message: e.message });
  }
}
function clearHistory(req, res) {
  const userId = req.user?.id;
  const userDb = require('../userDb');
  
  if (userId) {
    const count = store.removeByUserId(userId);
    // 同时清除数据库历史
    userDb.clearHistory(userId, null).catch(() => {});
    res.json({ code: 0, message: `已清除 ${count} 条记录` });
  } else {
    // 游客：清除所有非登录用户的任务
    const guestIp = req.ip || req.headers['x-forwarded-for']?.split(',')[0] || 'unknown';
    const tasks = store.list().filter(t => !t.userId);
    let count = 0;
    for (const t of tasks) {
      store.removeWithFiles(t.taskId);
      count++;
    }
    // 同时清除数据库中该游客的历史
    userDb.clearHistory(null, guestIp).catch(() => {});
    res.json({ code: 0, message: `已清除 ${count} 条记录` });
  }
}

// 使用 LRU 缓存管理器
function getCachedInfo(key, fetcher) {
  return cacheManager.getOrSet(key, fetcher, 'info');
}

/**
 * 获取视频信息和可用画质
 */
async function getVideoInfo(req, res) {
  try {
    const { url } = req.body;
    if (!url) return res.status(400).json({ code: -1, message: 'URL required' });

    const platform = detectPlatform(url);
    const cacheKey = `${platform}:${url}`;

    if (platform === 'youtube') {
      const videoIdMatch = url.match(/(?:v=|youtu\.be\/|shorts\/)([a-zA-Z0-9_-]{11})/);
      if (!videoIdMatch) return res.status(400).json({ code: -1, message: 'Invalid YouTube URL' });

      const videoId = videoIdMatch[1];

      let qualities = [];
      let title = 'YouTube Video';
      let thumbnail = '';
      let duration = 0;

      // 1. Try TikHub API first (1080p/2K/4K)
      try {
        const { tikhubRequest } = require('../services/tikhub');
        const YT_KEY = process.env.TIKHUB_API_KEY_YT;
        const cacheKeyTik = `yt-tikhub:${videoId}`;
        const data = await getCachedInfo(cacheKeyTik, async () => {
          return await tikhubRequest(
            `/api/v1/youtube/web/get_video_info?video_id=${videoId}&need_format=true`,
            YT_KEY
          );
        }, 'info');

        title = data.title || title;
        duration = data.lengthSeconds ? parseInt(data.lengthSeconds) : 0;
        const thumbs = data.thumbnails || [];
        thumbnail = thumbs.length > 0 ? thumbs[0].url : '';

        const videos = data.videos?.items || [];
        if (videos.length > 0) {
          const seen = new Set();
          qualities = videos
            .filter(v => v.url && v.height)
            .map(v => {
              const h = v.height || 0;
              return {
                quality: heightToLabel(h),
                format: v.extension || 'mp4',
                width: v.width || 0,
                height: h,
                hasVideo: true,
                hasAudio: v.hasAudio === undefined ? true : v.hasAudio,
                size: v.size || 0
              };
            })
            .filter(q => q.height > 0 && !seen.has(q.height) && seen.add(q.height))
            .sort((a, b) => b.height - a.height);
        }
      } catch (e) {
        logger.warn(`[video-info] YouTube TikHub failed for ${url}: ${e.message}`);
      }

      // 2. Fallback: yt-dlp if TikHub failed
      if (qualities.length === 0) {
        try {
          const ytdlp = require('../services/yt-dlp');
          const cacheKeyYt = `yt-dlp:${videoId}`;
          const ytInfo = await getCachedInfo(cacheKeyYt, async () => {
            return await ytdlp.getInfo(url);
          }, 'info');

          title = ytInfo.title || title;
          thumbnail = ytInfo.thumbnail || thumbnail;
          duration = ytInfo.duration || duration;

          if (ytInfo.formats && Array.isArray(ytInfo.formats)) {
            const seen = new Set();
            qualities = ytInfo.formats
              .filter(f => f.vcodec !== 'none' && f.height)
              .map(f => ({
                quality: heightToLabel(f.height),
                format: f.ext || 'mp4',
                width: f.width || 0,
                height: f.height,
                hasVideo: true,
                hasAudio: f.acodec !== 'none',
                size: f.filesize || f.filesize_approx || 0,
                formatId: f.format_id
              }))
              .filter(q => !seen.has(q.height) && seen.add(q.height))
              .sort((a, b) => (b.height || 0) - (a.height || 0));
          }
        } catch (e) {
          logger.warn(`[video-info] yt-dlp failed for ${url}: ${e.message}`);
        }
      }

      if (qualities.length === 0) {
        qualities = [{ quality: 'Best Available', format: 'mp4', width: 0, height: 720, hasVideo: true, hasAudio: true }];
      }

      return res.json({
        code: 0,
        data: { title, thumbnail, duration, platform: 'youtube', qualities }
      });
    }
    // For Douyin: use TikHub for 1080p/2K/4K, iesdouyin fallback for 720p
    if (platform === 'douyin') {
      try {
        let qualities = [];
        let title = 'Video';
        let thumbnail = '';
        let duration = 0;

        // 1. Try TikHub API first (1080p/2K/4K)
        try {
          const { getDouyinQualities } = require('../services/tikhub');
          const tikhubInfo = await getCachedInfo('douyin-tikhub:' + url, async () => {
            return await getDouyinQualities(url);
          }, 'info');
          if (tikhubInfo.qualities?.length > 0) {
            qualities = tikhubInfo.qualities;
            title = tikhubInfo.title || title;
            thumbnail = tikhubInfo.thumbnail || thumbnail;
            duration = tikhubInfo.duration || duration;
          }
        } catch (e) {
          logger.warn('[video-info] Douyin TikHub error:', e.message);
        }

        // 2. Fallback: iesdouyin for 720p if TikHub failed or returned no qualities
        if (qualities.length === 0) {
          const { getDouyinVideoInfo } = require('../services/douyin');
          const douyinInfo = await getCachedInfo('douyin:' + url, async () => {
            return await getDouyinVideoInfo(url);
          }, 'info');
          qualities = douyinInfo.qualities || [];
          title = douyinInfo.title || title;
          thumbnail = douyinInfo.thumbnail || thumbnail;
          duration = douyinInfo.duration || duration;
        }

        if (qualities.length === 0) {
          qualities = [{ quality: 'Best Available', format: 'mp4', width: 1280, height: 720, hasVideo: true, hasAudio: true }];
        }

        return res.json({
          code: 0,
          data: { title, thumbnail, duration, platform: 'douyin', qualities }
        });
      } catch (e) {
        logger.warn('[video-info] Douyin error:', e.message);
      }
    }

    // For TikTok, try TikHub API
    if (platform === 'tiktok') {
      try {
        const { parseDouyin } = require('../services/tikhub');
        const awemeIdMatch = url.match(/\/video\/(\d+)|\/note\/(\d+)/);
        if (awemeIdMatch) {
          const awemeId = awemeIdMatch[1] || awemeIdMatch[2];
          const data = await getCachedInfo('tk:' + awemeId, async () => {
            return await tikhubRequest('/api/v1/tiktok/app/v3/fetch_one_video?aweme_id=' + awemeId, API_KEY_DOUYIN);
          }, 'info');
          const detail = data?.aweme_detail || {};
          const video = detail.video || {};
          const bitrates = video.bit_rate || [];
          const tkDuration = video.duration ? Math.floor(video.duration / 1000) : 0;
          const qualities = bitrates
            .filter(br => br.play_addr?.url_list?.[0])
            .map(br => {
              const bitrate = br.bit_rate || 0;
              const estSize = tkDuration && bitrate ? Math.round(tkDuration * bitrate / 8) : 0;
              return {
                quality: heightToLabel(br.play_addr?.height || 0),
                format: 'video/mp4',
                width: br.play_addr?.width || 0,
                height: br.play_addr?.height || 0,
                hasVideo: true,
                hasAudio: true,
                size: estSize
              };
            })
            .sort((a, b) => (b.height || 0) - (a.height || 0));
          const unique = [];
          const seen = new Set();
          for (const q of qualities) {
            if (!seen.has(q.height)) { seen.add(q.height); unique.push(q); }
          }
          return res.json({
            code: 0,
            data: {
              title: detail.desc || 'TikTok Video',
              thumbnail: video.cover?.url_list?.[0] || '',
              duration: video.duration ? Math.floor(video.duration / 1000) : 0,
              platform: 'tiktok',
              qualities: unique.length > 0 ? unique : [{ quality: '720p', format: 'mp4', width: 1280, height: 720, hasVideo: true, hasAudio: true }]
            }
          });
        }
      } catch (e) {
        logger.warn('[video-info] TikTok error:', e.message);
      }
    }

    // For Xiaohongshu, get quality options from TikHub h264 array
    if (platform === 'xiaohongshu' || /xiaohongshu\.com|xhslink\.com/i.test(url)) {
      try {
        const { tikhubRequest: xhsReq } = require('../services/tikhub');
        const xhsData = await getCachedInfo('xhs:' + url, async () => {
          return await xhsReq('/api/v1/xiaohongshu/web_v2/fetch_feed_notes_v3?short_url=' + encodeURIComponent(url));
        }, 'info');
        const note = xhsData.note || xhsData.data?.note || {};
        const xhsVideo = note.video || {};
        const media = xhsVideo.media || {};
        const stream = media.stream || {};
        const h264 = stream.h264 || [];

        if (h264.length > 0) {
          const validStreams = h264.filter(s => s.masterUrl).sort((a, b) => (b.avgBitrate || 0) - (a.avgBitrate || 0));
          const qualityMap = new Map();
          const qualities = [];

          for (const s of validStreams) {
            let h = s.height || 0;
            if (!h && s.definition) {
              const defMatch = String(s.definition).match(/(\d+)p?/i);
              if (defMatch) h = parseInt(defMatch[1]);
            }
            if (!h && s.avgBitrate) {
              const br = s.avgBitrate;
              if (br > 8000000) h = 2160;
              else if (br > 4000000) h = 1440;
              else if (br > 2000000) h = 1080;
              else if (br > 800000) h = 720;
              else h = 480;
            }
            if (h > 0 && !qualityMap.has(h)) {
              qualityMap.set(h, {
                quality: heightToLabel(h),
                format: 'mp4',
                width: s.width || Math.round(h * 9 / 16),
                height: h,
                hasVideo: true,
                hasAudio: true,
                size: (s.avgBitrate || 0) * (xhsVideo.capa?.duration || 10) / 8
              });
            }
          }

          const sorted = [...qualityMap.values()].sort((a, b) => b.height - a.height);
          for (const q of sorted) qualities.push(q);

          if (qualities.length <= 1) {
            const maxHeight = qualities.length > 0 ? qualities[0].height : 1080;
            const presets = [540, 720, 1080, 1440, 2160].filter(h => h <= maxHeight);
            for (const h of presets) {
              if (!qualityMap.has(h)) {
                qualities.push({
                  quality: heightToLabel(h),
                  format: 'mp4',
                  width: Math.round(h * 9 / 16),
                  height: h,
                  hasVideo: true,
                  hasAudio: true,
                  size: 0
                });
              }
            }
            qualities.sort((a, b) => b.height - a.height);
          }

          return res.json({
            code: 0,
            data: {
              title: note.title || 'Xiaohongshu Note',
              thumbnail: xhsVideo.image?.thumbnailFileid ? 'https://ci.xiaohongshu.com/' + xhsVideo.image.thumbnailFileid : '',
              duration: xhsVideo.capa?.duration || 0,
              platform: 'xiaohongshu',
              qualities: qualities.length > 0 ? qualities : [{ quality: 'Best', format: 'mp4', width: 0, height: 0, hasVideo: true, hasAudio: true }]
            }
          });
        }
      } catch (e) {
        logger.warn('[video-info] Xiaohongshu error:', e.message);
      }
    }

    // For platforms without multi-quality support, return single "Best" option
    if (platform === 'x') {
      return res.json({
        code: 0,
        data: {
          title: 'X/Twitter Video',
          thumbnail: '',
          duration: 0,
          platform: 'x',
          qualities: [
            { quality: 'Best Available', format: 'mp4', width: 1280, height: 720, hasVideo: true, hasAudio: true }
          ]
        }
      });
    }

    const defaultQualities = [
      { quality: 'Best Available', format: 'mp4', width: 1280, height: 720, hasVideo: true, hasAudio: true }
    ];

    return res.json({
      code: 0,
      data: {
        title: 'Video',
        thumbnail: '',
        duration: 0,
        platform: platform || 'auto',
        qualities: defaultQualities
      }
    });
  } catch (e) {
    logger.error('[video-info] Error:', e.message);
    return res.status(HTTP_STATUS.INTERNAL_ERROR).json({ code: RESPONSE_CODE.ERROR, message: e.message });
  }
}

// ============ 微信视频号 ============

const { downloadWechat } = require('../services/tikhub');

async function processWechat(taskId, url, needAsr, options = ['video']) {
  // 获取任务锁
  if (!taskLock.tryAcquire(taskId)) {
    logger.warn(`[task] ${taskId} is already being processed`);
    store.update(taskId, { status: TASK_STATUS.ERROR, error: 'Task is already in progress' });
    return;
  }

  try {
    logger.info('[processWechat] CALLED for task:', taskId, 'url:', url);
    const path = require('path');

    store.update(taskId, { status: TASK_STATUS.PARSING, progress: 5 });

    const result = await downloadWechat(url, taskId, (percent, downloaded, total) => {
      store.update(taskId, {
        status: TASK_STATUS.DOWNLOADING,
        progress: percent,
        downloadedBytes: downloaded || 0,
        totalBytes: total || 0
      });
    });

    // 更新任务状态
    const update = {
      status: TASK_STATUS.COMPLETED,
      progress: 100,
      filePath: result.filePath,
      downloadUrl: `/download/${path.basename(result.filePath)}`,
      width: result.width,
      height: result.height,
      quality: result.quality,
      title: result.description
    };

    store.update(taskId, update);

    logger.info(`[task] ${taskId} wechat completed: ${result.width}x${result.height} ${result.quality}`);

  } catch (err) {
    logger.error(`[task] ${taskId} wechat error:`, err.message);
    store.update(taskId, { status: TASK_STATUS.ERROR, progress: 0, error: err.message });
  } finally {
    taskLock.release(taskId);
  }
}

module.exports = {
  createDownload,
  getInfo,
  getStatus,
  getHistory,
  getSystemStatus,
  getAdminStats,
  deleteTask,
  clearHistory,
  adminClearAllHistory,
  detectPlatform,
  getVideoInfo
};
// force redeploy Thu Mar 26 13:57:07 CST 2026

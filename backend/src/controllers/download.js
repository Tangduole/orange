/**
 * 下载控制器 v3
 * 
 * v3 改进：
 * 1. 自动识别平台（前端驱动，后端兼容）
 * 2. 支持 options 数组：video/copywriting/cover/asr/subtitle
 * 3. 支持 saveTarget: phone/pc
 * 4. 支持 copywriting（提取描述）、cover（封面下载）、subtitle（字幕下载）
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

const API_KEY_DOUYIN = process.env.TIKHUB_API_KEY_DOUYIN;

/**
 * 流式下载文件到磁盘（避免 OOM）
 */
async function downloadToStream(url, destPath, timeout = 120000) {
  const writer = fs.createWriteStream(destPath);
  const response = await axios.get(url, { responseType: 'stream', timeout });
  return new Promise((resolve, reject) => {
    response.data.pipe(writer);
    writer.on('finish', resolve);
    writer.on('error', (err) => {
      fs.unlink(destPath, () => {});
      reject(err);
    });
  });
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

    let { url, platform, needAsr = false, options = ['video'], saveTarget = 'phone', quality = null, asrLanguage = 'zh' } = req.body;

    // 从分享文本中提取 URL
    const { extractUrl } = require('../utils/validator');
    const extracted = extractUrl(url);
    if (extracted) url = extracted;

    // 平台自动识别
    const detectedPlatform = detectPlatform(url);
    const finalPlatform = platform || detectedPlatform || 'auto';

    // 兼容：前端 'audio' 和 'audio_only' 选项
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
          
          isVip = user.tier === 'pro' && (user.subscription_status === 'active' || user.subscription_status === 'past_due');
          const usage = await userDb.getUsage(userId);
          if (!usage.isPro && usage.remaining <= 0) {
            return res.json({
              code: 403,
              message: `今日下载次数已用完（${usage.dailyLimit}次/天）。升级 Pro 解锁无限制下载`
            });
          }
          // 增加登录用户下载计数
          await userDb.incrementDownloads(userId);
        }
      } catch (e) {
        // token 无效，继续作为游客
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
          code: 403,
          message: `今日下载次数已用完（${guestUsage.limit}次/天）。注册账号获得更多下载次数`
        });
      }
      // 增加游客下载计数
      await userDb.incrementGuestDownload(guestIp);
    }
    
    // ========== 画质VIP限制检查 ==========
    // 如果用户选择了1080p以上画质，检查是否为VIP
    if (quality) {
      const heightMatch = quality.match(/height<=(\d+)/i);
      const selectedHeight = heightMatch ? parseInt(heightMatch[1]) : 99999;
      
      if (selectedHeight > 720 && !isVip) {
        // 免费用户允许试用1次高清画质
        const userDb = require('../userDb');
        const trialUsed = await userDb.useHdTrial(userId);
        if (!trialUsed) {
          return res.json({
            code: 403,
            message: `720p以上画质为会员专享。试用次数已用完，请升级Pro解锁高清下载。`
          });
        }
        // 试用成功，继续下载（不报错）
        console.log(`[task] HD trial used for user ${userId}`);
      }
    }
    // ========== 画质VIP限制检查结束 ==========

    const limitStatus = getLimiterStatus();
    if (limitStatus.queued >= 10) {
      return res.json({ code: 429, message: '任务队列已满，请稍后再试' });
    }

    const taskId = uuidv4();
    const task = {
      taskId,
      url: url.trim(),
      platform: finalPlatform,
      needAsr: wantsAsr,
      options: normalizedOptions,
      saveTarget,
      status: 'pending',
      progress: 0,
      createdAt: Date.now(),
      userId: isGuest ? null : userId,
      guestIp: isGuest ? guestIp : null
    };

    store.save(task);

    // 抖音链接：走专用下载器（不依赖 yt-dlp）
    const { isDouyinUrl } = require('../services/douyin');
    if (isDouyinUrl(url)) {
      // 非VIP用户限制画质为720p，VIP用户不限制（最高画质）
      const maxQuality = isVip ? null : 'height<=720';
      processDouyin(taskId, url, wantsAsr, normalizedOptions, quality, asrLanguage).catch(err => {
        console.error(`[task] ${taskId} douyin failed:`, err);
        store.update(taskId, { status: 'error', progress: 0, error: err.message });
      });
      return res.json({ code: 0, data: { taskId, status: 'pending', platform: finalPlatform } });
    }

    // X/Twitter 链接：走专用下载器
    const { isXUrl } = require('../services/x-download');
    if (isXUrl(url)) {
      processX(taskId, url, wantsAsr, normalizedOptions).catch(err => {
        console.error(`[task] ${taskId} x failed:`, err);
        store.update(taskId, { status: 'error', progress: 0, error: err.message });
      });
      return res.json({ code: 0, data: { taskId, status: 'pending', platform: finalPlatform } });
    }

    // TikTok 链接：走 TikHub API
    if (/tiktok\.com|tiktok\.cn/i.test(url)) {
      processTikTok(taskId, url, wantsAsr, normalizedOptions, quality).catch(err => {
        console.error(`[task] ${taskId} tiktok failed:`, err);
        store.update(taskId, { status: 'error', progress: 0, error: err.message });
      });
      return res.json({ code: 0, data: { taskId, status: 'pending', platform: 'tiktok' } });
    }

    // YouTube 链接：走 TikHub API（直接链接）
    if (/youtube\.com|youtu\.be/i.test(url)) {
      // VIP用户不传quality限制，后端自动使用最高画质
      const ytQuality = isVip ? null : quality;
      processYouTube(taskId, url, wantsAsr, normalizedOptions, ytQuality).catch(err => {
        console.error(`[task] ${taskId} youtube failed:`, err);
        store.update(taskId, { status: 'error', progress: 0, error: err.message });
      });
      return res.json({ code: 0, data: { taskId, status: 'pending', platform: 'youtube' } });
    }

    // 小红书链接：走 TikHub API
    if (/xiaohongshu\.com|xhslink\.com/i.test(url)) {
      processXiaohongshu(taskId, url, wantsAsr, normalizedOptions).catch(err => {
        console.error(`[task] ${taskId} xiaohongshu failed:`, err);
        store.update(taskId, { status: 'error', progress: 0, error: err.message });
      });
      return res.json({ code: 0, data: { taskId, status: 'pending', platform: 'xiaohongshu' } });
    }

    // 快手链接：暂不支持
    if (/kuaishou\.com|v\.kuaishou\.com/i.test(url)) {
      store.update(taskId, { status: 'error', progress: 0, error: '快手平台暂不支持，请使用其他平台链接' });
      return res.json({ code: 0, data: { taskId, status: 'error', platform: 'kuaishou', message: '快手平台暂不支持' } });
    }

    // Bilibili 链接：走 yt-dlp（待完善）
    if (/bilibili\.com|b23\.tv/i.test(url)) {
      processDownload(taskId, url, wantsAsr, normalizedOptions, quality).catch(err => {
        console.error(`[task] ${taskId} bilibili failed:`, err);
        store.update(taskId, { status: 'error', progress: 0, error: err.message });
      });
      return res.json({ code: 0, data: { taskId, status: 'pending', platform: 'bilibili' } });
    }

    // 其他平台：走 yt-dlp
    processDownload(taskId, url, wantsAsr, normalizedOptions, quality).catch(err => {
      console.error(`[task] ${taskId} failed:`, err);
      store.update(taskId, {
        status: 'error',
        progress: 0,
        error: err.message
      });
    });

    res.json({
      code: 0,
      data: {
        taskId,
        status: 'pending',
        platform: finalPlatform
      }
    });
  } catch (e) {
    console.error('[createDownload] Error:', e);
    res.json({ code: 500, message: e.message });
  }
}

/**
 * 获取视频信息（不下载）
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
 * 处理下载任务（异步）
 */
async function processDownload(taskId, url, needAsr, options = ['video'], quality = null) {
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
    store.update(taskId, { status: 'parsing', progress: 5 });

    let result = null;

    // 2. 需要实际下载的情况
    if (wantsVideo || wantsCover || wantsSubtitle || wantsAudio || wantsAudioOnly || wantsCopywriting || needAsr) {
      store.update(taskId, { status: 'downloading', progress: 10 });

      const isYouTube = /youtube\.com|youtu\.be/i.test(url);

      // 如果只想要音频（不想要视频/字幕/封面）
      const wantsOnlyAudio = wantsAudioOnly && !wantsVideo && !wantsCover && !wantsSubtitle;

      result = await downloadWithLimit(async () => {
        try {
          // 如果只想要音频，使用专门的音频下载
          if (wantsOnlyAudio) {
            return await ytdlp.downloadAudio(url, taskId, (percent, speed, eta) => {
              store.update(taskId, {
                status: 'downloading',
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
                status: 'downloading',
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
            console.log(`[task] ${taskId} yt-dlp failed, trying Invidious...`);
            store.update(taskId, { progress: 5 });
            return await ytdlp.downloadViaInvidious(url, taskId, (percent) => {
              store.update(taskId, {
                status: 'downloading',
                progress: percent,
              });
            });
          }
          throw err;
        }
      });

      const update = {
        status: 'completed',
      width: result.width,
      height: result.height,
      quality: result.quality,
        progress: 100,
        title: result.title,
        duration: result.duration || 0,
        thumbnailUrl: result.thumbnailUrl,
      };

      // 音频下载链接（只想要音频的情况）
      if (wantsOnlyAudio) {
        update.audioUrl = `/download/${path.basename(result.filePath)}`;
      }

      // 视频下载链接
      if (wantsVideo) {
        update.filePath = result.filePath;
        update.ext = result.ext;
        update.downloadUrl = `/download/${path.basename(result.filePath)}`;
      }

      // 封面（总是返回，供显示和下载）
      const coverImage = result.thumbnailUrl || result.coverUrl;
      if (coverImage) {
        update.thumbnailUrl = coverImage;
        update.coverUrl = coverImage;
      }

      // 文案（总是提取标题和描述）
      if (result.title) {
        update.copyText = result.title;
        console.log(`[task] ${taskId} set copyText=${result.title?.substring(0, 50)}`);
      }

      // 原声音频
      if (wantsAudio) {
        try {
          const audioPath = path.join(path.dirname(result.filePath), `${taskId}_audio.mp3`);
          await ytdlp.extractAudio(result.filePath, audioPath);
          update.audioUrl = `/download/${path.basename(audioPath)}`;
        } catch (audioErr) {
          console.error(`[audio] ${taskId} extract failed:`, audioErr);
        }
      }

      // 字幕
      if (wantsSubtitle && result.subtitleFiles && result.subtitleFiles.length > 0) {
        update.subtitleFiles = result.subtitleFiles;
      }

      store.update(taskId, update);
    } else if (wantsCopywriting) {
      // 仅文案：获取信息不下载
      const info = await ytdlp.getInfo(url);
      store.update(taskId, {
        status: 'completed',
        width: 0,
        height: 0,
        quality: 'N/A',
        progress: 100,
        title: info.title,
        duration: info.duration,
        copyText: info.description || `标题: ${info.title}`,
      });
    }

    // 3. ASR（可选）
    if (needAsr && result) {
      store.update(taskId, { status: 'asr', progress: 100 });

      try {
        const audioPath = path.join(
          path.dirname(result.filePath),
          `${taskId}.mp3`
        );
        await ytdlp.extractAudio(result.filePath, audioPath);
        const text = await asr.transcribe(audioPath, asrLanguage);

        store.update(taskId, {
          status: 'completed',
      width: result.width,
      height: result.height,
      quality: result.quality,
          asrText: text
        });

        if (fs.existsSync(audioPath)) fs.unlinkSync(audioPath);
      } catch (asrError) {
        console.error(`[ASR] ${taskId} failed:`, asrError);
        store.update(taskId, { asrError: asrError.message });
      }
    }

    console.log(`[task] ${taskId} completed`);
  } catch (error) {
    console.error(`[task] ${taskId} failed:`, error);
    store.update(taskId, { status: 'error', error: error.message });
  }
}

/**
 * 处理抖音下载（视频/图文，不依赖 yt-dlp）
 */
async function processDouyin(taskId, url, needAsr, options = ['video'], quality = null, asrLanguage = 'zh', requestedQuality = null) {
  try {
    const { parseDouyin } = require('../services/tikhub');

    // 保存用户请求的画质参数
    store.update(taskId, { status: 'parsing', progress: 5, requestedQuality });

    const result = await parseDouyin(url, taskId, (percent, downloaded, total) => {
      store.update(taskId, {
        status: percent < 30 ? 'parsing' : 'downloading',
        progress: percent,
        downloadedBytes: downloaded || 0,
        totalBytes: total || 0
      });
    }, quality);

    // 获取用户请求的画质
    const task = store.get(taskId) || {};
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
      status: 'completed',
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
          const timer = setTimeout(() => { ff.kill('SIGKILL'); reject(new Error('timeout')); }, 30000);
          ff.on('close', code => { clearTimeout(timer); code === 0 ? resolve() : reject(new Error('ffmpeg exit ' + code)); });
          ff.on('error', err => { clearTimeout(timer); reject(err); });
        });
        update.downloadUrl = `/download/${taskId}.mp3`;
        update.filePath = audioPath;
        update.ext = 'mp3';
        update.audioUrl = `/download/${taskId}.mp3`;
        // 删除视频文件
        try { fs.unlinkSync(result.filePath); } catch {}
      } catch (e) {
        console.error(`[audio] ${taskId} extract failed:`, e.message);
      }
    }

    // 处理 ASR
    if (needAsr && result.filePath) {
      try {
        store.update(taskId, { status: 'asr', progress: 100 });
        const asr = require('../services/asr');
        const audioPath = path.join(path.dirname(result.filePath), `${taskId}.mp3`);
        
        // 提取音频
        const ffmpeg = require('fluent-ffmpeg');
        await new Promise((resolve, reject) => {
          ffmpeg(result.filePath)
            .noVideo()
            .audioCodec('libmp3lame')
            .audioBitrate('128k')
            .output(audioPath)
            .on('end', resolve)
            .on('error', reject)
            .run();
        });

        // ASR 转文字
        const text = await asr.transcribe(audioPath, asrLanguage);
        update.asrText = text;
      } catch (asrError) {
        console.error(`[ASR] ${taskId} failed:`, asrError);
        update.asrError = asrError.message;
      }
    }

    store.update(taskId, update);
    console.log(`[task] ${taskId} douyin completed`);
  } catch (error) {
    console.error(`[task] ${taskId} douyin failed:`, error);
    store.update(taskId, { status: 'error', error: error.message });
  }
}

/**
 * 处理 X/Twitter 下载
 */
async function processX(taskId, url, needAsr, options = ['video']) {
  try {
    const { downloadX } = require('../services/x-download');
    store.update(taskId, { status: 'parsing', progress: 5 });
    const result = await downloadX(url, taskId, (percent, msg) => {
      store.update(taskId, {
        status: percent < 30 ? 'parsing' : 'downloading',
        progress: percent
      });
    });
    
    // 检查是否有可用的下载链接
    if (!result.downloadUrl && (!result.images || result.images.length === 0)) {
      throw new Error('X/Twitter 视频解析失败，无法下载');
    }
    
    const update = {
      status: 'completed',
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
          const timer = setTimeout(() => { ff.kill('SIGKILL'); reject(new Error('timeout')); }, 30000);
          ff.on('close', code => { clearTimeout(timer); code === 0 ? resolve() : reject(new Error('ffmpeg exit ' + code)); });
          ff.on('error', err => { clearTimeout(timer); reject(err); });
        });
        update.downloadUrl = '/download/' + taskId + '.mp3';
        update.filePath = audioPath;
        update.ext = 'mp3';
        try { fs.unlinkSync(result.filePath); } catch {}
      } catch (e) {
        console.error('[x audio] extract failed:', e.message);
      }
    }
    
    store.update(taskId, update);
    console.log(`[task] ${taskId} x completed`);
  } catch (error) {
    console.error(`[task] ${taskId} x failed:`, error);
    store.update(taskId, { status: 'error', error: error.message || 'X/Twitter 下载失败' });
  }
}

/**
 * 处理 YouTube 下载 (TikHub API)
 */
async function processYouTube(taskId, url, needAsr, options = ['video'], quality = null) {
  try {
    const axios = require('axios');
    const path = require('path');
    const fs = require('fs');
    const { spawn } = require('child_process');
    const ytdlp = require('../services/yt-dlp');
    
    store.update(taskId, { status: 'parsing', progress: 5 });
    
    // 获取视频 ID
    const videoIdMatch = url.match(/(?:v=|youtu\.be\/|shorts\/)([a-zA-Z0-9_-]{11})/);
    if (!videoIdMatch) throw new Error('Invalid YouTube URL');
    const videoId = videoIdMatch[1];
    
    // 解析用户选择的画质
    let maxHeight = 99999; // 默认无限制（VIP）
    if (quality) {
      const heightMatch = quality.match(/height<=?(\d+)/i);
      if (heightMatch) {
        maxHeight = parseInt(heightMatch[1]);
      }
    }
    // 保存用户请求的画质参数
    store.update(taskId, { requestedQuality: quality });
    
    // ========== 方案1: TikHub API ==========
    try {
      const API_KEY_YT = process.env.TIKHUB_API_KEY_YT;
      const { data } = await axios.get(
        `https://api.tikhub.io/api/v1/youtube/web/get_video_info?video_id=${videoId}&need_format=true`,
        { headers: { Authorization: `Bearer ${API_KEY_YT}` }, timeout: 30000 }
      );
      
      if (data.code === 200) {
        const videoData = data.data;
        const title = videoData.title || 'YouTube Video';
        const videos = videoData.videos?.items || [];
        const audios = videoData.audios?.items || [];
        
        // 1. 先找符合画质要求且有音频的视频
        let bestVideoWithAudio = null;
        for (const v of videos) {
          if (v.url && v.mimeType?.startsWith('video/') && v.hasAudio) {
            const vHeight = v.height || 0;
            if (vHeight <= maxHeight) {
              if (!bestVideoWithAudio || vHeight > (bestVideoWithAudio.height || 0)) {
                bestVideoWithAudio = v;
              }
            }
          }
        }
        
        // 2. 如果没有带音频的，找最高的视频准备合并音频
        let bestVideoNoAudio = null;
        let bestVideoHeight = 0;
        for (const v of videos) {
          if (v.url && v.mimeType?.startsWith('video/') && !v.hasAudio) {
            const vHeight = v.height || 0;
            if (vHeight <= maxHeight && vHeight > bestVideoHeight) {
              bestVideoNoAudio = v;
              bestVideoHeight = vHeight;
            }
          }
        }
        
        // 选择最佳方案
        let finalVideo = bestVideoWithAudio || bestVideoNoAudio;
        
        if (finalVideo && finalVideo.url) {
          const outputPath = path.join(__dirname, '../../downloads', `${taskId}.mp4`);
          
          // 如果视频没有音频，需要下载并合并音频
          if (!finalVideo.hasAudio && audios.length > 0) {
            console.log(`[task] ${taskId} video has no audio, need to merge with audio`);
            
            // 获取最佳音频 (mp4 格式优先)
            const bestAudio = audios.find(a => a.mimeType?.includes('mp4')) || audios[0];
            const videoPath = path.join(__dirname, '../../downloads', `${taskId}_video.mp4`);
            const audioPath = path.join(__dirname, '../../downloads', `${taskId}_audio.mp3`);
            
            // 下载视频
            store.update(taskId, { status: 'downloading', progress: 10 });
            
            // 流式下载视频（避免 OOM）
            await downloadToStream(finalVideo.url, videoPath, 120000);
            store.update(taskId, { progress: 50 });
            
            // 流式下载音频
            await downloadToStream(bestAudio.url, audioPath, 60000);
            store.update(taskId, { progress: 70 });
            
            // 使用 ffmpeg 合并
            await new Promise((resolve, reject) => {
              const ffmpeg = spawn('ffmpeg', [
                '-i', videoPath,
                '-i', audioPath,
                '-c:v', 'copy',
                '-c:a', 'aac',
                '-y',
                outputPath
              ]);
              
              ffmpeg.on('close', (code) => {
                if (code === 0) {
                  // 删除临时文件
                  fs.unlinkSync(videoPath);
                  fs.unlinkSync(audioPath);
                  resolve();
                } else {
                  reject(new Error(`ffmpeg exited with code ${code}`));
                }
              });
              ffmpeg.on('error', reject);
            });
            
            store.update(taskId, {
              status: 'completed',
              width: finalVideo.width || 0,
              height: finalVideo.height || 0,
              quality: `${finalVideo.width || 0}x${finalVideo.height || 0}`,
              progress: 100,
              title: title,
              thumbnailUrl: videoData.thumbnails?.[0]?.url || '',
              downloadUrl: `/download/${taskId}.mp4`,
              filePath: outputPath,
              ext: 'mp4'
            });
            console.log(`[task] ${taskId} youtube completed via TikHub with audio merge`);
            return;
          }
          
          // 视频本身有音频，先下载到服务器再返回代理链接（避免API Key暴露）
          const videoPath = path.join(__dirname, '../../downloads', `${taskId}.mp4`);
          try {
            await downloadToStream(finalVideo.url, videoPath, 120000);
            
            store.update(taskId, {
              status: 'completed',
              width: finalVideo.width || 0,
              height: finalVideo.height || 0,
              quality: `${finalVideo.width || 0}x${finalVideo.height || 0}`,
              progress: 100,
              title: title,
              thumbnailUrl: videoData.thumbnails?.[0]?.url || '',
              downloadUrl: `/download/${taskId}.mp4`,
              filePath: videoPath,
              ext: finalVideo.extension || 'mp4'
            });
            console.log(`[task] ${taskId} youtube completed via TikHub (proxied)`);
            return;
          } catch (downloadErr) {
            console.error(`[task] ${taskId} TikHub URL failed (${downloadErr.message}), falling back to yt-dlp...`);
            // Fallthrough to yt-dlp fallback below
          }
        }
      }
    } catch (tikhubErr) {
      console.log(`[task] ${taskId} TikHub failed: ${tikhubErr.message}, trying yt-dlp...`);
    }
    
    // ========== 方案2: yt-dlp 直接下载 ==========
    console.log(`[task] ${taskId} using yt-dlp fallback for YouTube`);
    const outputPath = path.join(__dirname, '../../downloads', `${taskId}.mp4`);
    
    // yt-dlp 自动处理视频+音频合并
    await ytdlp.download(url, taskId, (percent, speed, eta, downloaded, total) => {
      store.update(taskId, {
        status: 'downloading',
        progress: percent,
        speed,
        eta,
        downloadedBytes: downloaded || 0,
        totalBytes: total || 0
      });
    }, quality);
    
    // 获取视频信息
    const info = await ytdlp.getInfo(url);
    
    store.update(taskId, {
      status: 'completed',
      width: info.width || 0,
      height: info.height || 0,
      quality: info.quality || '1080p',
      progress: 100,
      title: info.title || 'YouTube Video',
      duration: info.duration || 0,
      thumbnailUrl: info.thumbnail || '',
      downloadUrl: `/download/${taskId}.mp4`,
      filePath: outputPath,
      ext: 'mp4'
    });
    
    console.log(`[task] ${taskId} youtube completed via yt-dlp`);
  } catch (error) {
    console.error(`[task] ${taskId} youtube failed:`, error);
    store.update(taskId, { status: 'error', error: error.message });
  }
}

/**
 * 处理 TikTok 下载 (TikHub API)
 */
async function processTikTok(taskId, url, needAsr, options = ['video'], quality = null) {
  try {
    store.update(taskId, { status: 'parsing', progress: 5 });

    // 从 URL 提取视频 ID
    let videoId = null;

    // 直接从 URL 匹配 /video/123456
    const idMatch = url.match(/\/video\/(\d+)/);
    if (idMatch) videoId = idMatch[1];

    // 短链：先 resolve 获取真实 URL
    if (!videoId) {
      try {
        // 方法1: HEAD 请求跟踪重定向
        const headResp = await axios.head(url, { maxRedirects: 5, timeout: 10000 });
        const redirectUrl = headResp.request?.res?.responseUrl || headResp.headers?.location || '';
        const redirectMatch = redirectUrl.match(/\/video\/(\d+)/);
        if (redirectMatch) videoId = redirectMatch[1];
      } catch (e) {}
      
      // 方法2: GET 请求从 HTML 提取
      if (!videoId) {
        try {
          const resp = await axios.get(url, {
            maxRedirects: 5,
            timeout: 15000,
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

    // 调用 TikHub TikTok App V3 API（用抖音 API key）
    const data = await tikhubRequest(
      '/api/v1/tiktok/app/v3/fetch_one_video?aweme_id=' + videoId,
      API_KEY_DOUYIN
    );

    const detail = data?.aweme_detail || {};
    const video = detail.video || {};
    const title = detail.desc || 'TikTok Video';

    // 获取下载链接（优先高画质 bit_rate）
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

    store.update(taskId, { status: 'downloading', progress: 30 });

    // 下载视频到服务器
    const filename = taskId + '.mp4';
    const outputPath = path.join(__dirname, '../../downloads', filename);
    await downloadToStream(videoUrl, outputPath, 120000);

    // 获取封面
    const coverUrl = video.cover?.url_list?.[0] || video.origin_cover?.url_list?.[0] || '';

    const update = {
      status: 'completed',
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

    // 纯音频
    const wantsAudioOnly = options.includes('audio') && !options.includes('video');
    if (wantsAudioOnly) {
      try {
        const audioPath = path.join(__dirname, '../../downloads', taskId + '.mp3');
        const { spawn } = require('child_process');
        await new Promise((resolve, reject) => {
          const ff = spawn('ffmpeg', ['-i', outputPath, '-vn', '-acodec', 'libmp3lame', '-b:a', '128k', '-y', audioPath]);
          const timer = setTimeout(() => { ff.kill('SIGKILL'); reject(new Error('timeout')); }, 30000);
          ff.on('close', code => { clearTimeout(timer); code === 0 ? resolve() : reject(new Error('ffmpeg exit ' + code)); });
          ff.on('error', err => { clearTimeout(timer); reject(err); });
        });
        update.downloadUrl = '/download/' + taskId + '.mp3';
        update.filePath = audioPath;
        update.ext = 'mp3';
        update.audioUrl = '/download/' + taskId + '.mp3';
        try { fs.unlinkSync(outputPath); } catch {}
      } catch (e) {
        console.error('[tiktok audio] extract failed:', e.message);
      }
    }

    store.update(taskId, update);

    console.log('[task] ' + taskId + ' tiktok completed');
  } catch (error) {
    console.error('[task] ' + taskId + ' tiktok failed:', error);
    store.update(taskId, {
      status: 'error',
      progress: 0,
      error: error.message || 'TikTok 下载失败'
    });
  }
}

/**
 * 处理小红书下载 (TikHub API)
 */
async function processXiaohongshu(taskId, url, needAsr, options = ['video']) {
  try {
    const { parseXiaohongshu } = require('../services/tikhub');
    store.update(taskId, { status: 'parsing', progress: 5 });

    const result = await parseXiaohongshu(url, taskId, (percent) => {
      store.update(taskId, {
        status: percent < 20 ? 'parsing' : 'downloading',
        progress: percent
      });
    });

    const update = {
      status: 'completed',
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
    }

    if (result.isNote && result.imageFiles) {
      update.isNote = true;
      update.imageFiles = result.imageFiles;
    }

    store.update(taskId, update);
    console.log(`[task] ${taskId} xiaohongshu completed`);
  } catch (error) {
    console.error(`[task] ${taskId} xiaohongshu failed:`, error);
    store.update(taskId, { status: 'error', error: error.message });
  }
}

/**
 * 平台自动识别
 */
function detectPlatform(url) {
  const patterns = {
    douyin: /douyin\.com|douyin\.cn|iesdouyin\.com/,
    tiktok: /tiktok\.com|tiktok\.cn/,
    x: /twitter\.com|x\.com/,
    youtube: /youtube\.com|youtu\.be/,

    kuaishou: /kuaishou\.com|v\.kuaishou\.com/
  };

  for (const [platform, pattern] of Object.entries(patterns)) {
    if (pattern.test(url)) {
      return platform;
    }
  }

  return null;
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
      asrError: task.asrError,
      copyText: task.copyText,
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
      // token 无效，继续作为游客
    }
  }
  
  if (isGuest) {
    guestIp = req.ip || req.headers['x-forwarded-for']?.split(',')[0] || 'unknown';
  }
  
  // 过滤任务
  const allTasks = store.list().filter(task => {
    if (isGuest) {
      // 临时：测试环境禁用 IP 过滤，避免 Railway IP 不稳定问题
      // TODO: 生产环境应改用 cookie/session 而非 IP
      return task.guestIp === guestIp;
    } else {
      return task.userId === userId;
    }
  });
  
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
  
  // 检查权限：登录用户只能删自己的任务
  const userId = req.user?.id;
  const guestIp = req.ip || req.headers['x-forwarded-for']?.split(',')[0] || 'unknown';
  const canDelete = (userId && task.userId === userId) || (!task.userId && task.guestIp === guestIp);
  
  if (!canDelete) {
    return res.json({ code: 403, message: '无权删除此任务' });
  }

  store.removeWithFiles(taskId);
  res.json({ code: 0, message: '删除成功' });
}

function clearHistory(req, res) {
  const userId = req.user.id;
  const count = store.removeByUserId(userId);
  res.json({ code: 0, message: `已清除 ${count} 条记录` });
}

// TikHub API 简单内存缓存（5分钟 TTL）
const infoCache = new Map();
const INFO_CACHE_TTL = 5 * 60 * 1000; // 5分钟

function getCachedInfo(key, fetcher) {
  const cached = infoCache.get(key);
  if (cached && Date.now() - cached.ts < INFO_CACHE_TTL) {
    console.log(`[cache] HIT: ${key}`);
    return Promise.resolve(cached.data);
  }
  console.log(`[cache] MISS: ${key}`);
  return fetcher().then(data => {
    infoCache.set(key, { data, ts: Date.now() });
    return data;
  });
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
      
      const API_KEY_YT = process.env.TIKHUB_API_KEY_YT;
      const axios = require('axios');
      const ytUrl = `https://api.tikhub.io/api/v1/youtube/web/get_video_info?video_id=${videoIdMatch[1]}&need_format=true`;
      
      // 使用缓存避免重复请求 TikHub API
      const data = await getCachedInfo(`yt:${videoIdMatch[1]}`, async () => {
        const response = await axios.get(ytUrl, { headers: { Authorization: `Bearer ${API_KEY_YT}` }, timeout: 30000 });
        return response.data;
      });
      
      const videos = data.videos?.items || [];
      const qualities = videos
        .filter(v => v.url)
        .map(v => {
          const w = v.width || 0
          const h = v.height || 0
          // Generate quality label from height
          let qualityLabel = v.qualityLabel || ''
          if (!qualityLabel && h > 0) {
            if (h >= 2160) qualityLabel = '4K'
            else if (h >= 1440) qualityLabel = '2K'
            else if (h >= 1080) qualityLabel = '1080p'
            else if (h >= 720) qualityLabel = '720p'
            else if (h >= 480) qualityLabel = '480p'
            else if (h >= 360) qualityLabel = '360p'
            else qualityLabel = `${h}p`
          }
          return {
            quality: qualityLabel || 'unknown',
            format: v.mimeType?.split(';')[0] || 'video/mp4',
            width: w,
            height: h,
            hasVideo: v.hasVideo !== false,
            hasAudio: v.hasAudio !== false,
            size: v.contentLength || 0
          }
        })
        .sort((a, b) => (b.height || 0) - (a.height || 0));
      
      // Add audio-only option if available
      const audioOnly = videos.filter(v => !v.hasVideo && v.url);
      if (audioOnly.length > 0) {
        qualities.push({
          quality: 'Audio Only',
          format: 'audio/mp4',
          width: 0,
          height: 0,
          hasVideo: false,
          hasAudio: true,
          size: audioOnly[0].contentLength || 0
        });
      }
      
      return res.json({
        code: 0,
        data: {
          title: data.title || 'YouTube Video',
          thumbnail: data.thumbnails?.[0]?.url || '',
          duration: data.lengthSeconds ? parseInt(data.lengthSeconds) : 0,
          platform: 'youtube',
          qualities
        }
      });
    }
    // For Douyin, get actual qualities from bit_rate
    if (platform === 'douyin' || platform === 'tiktok') {
      try {
        const { parseDouyin } = require('../services/tikhub');
        const awemeIdMatch = url.match(/\/video\/(\d+)|\/note\/(\d+)/);
        if (awemeIdMatch) {
          const awemeId = awemeIdMatch[1] || awemeIdMatch[2];
          // 使用缓存避免重复请求 TikHub API
          const data = await getCachedInfo(`dy:${awemeId}`, async () => {
            return await tikhubRequest(`/api/v1/douyin/web/fetch_one_video?aweme_id=${awemeId}`, API_KEY_DOUYIN);
          });
          const detail = data.aweme_detail || {};
          const video = detail.video || {};
          const bitrates = video.bit_rate || [];
          
          // Build qualities from bit_rate array
          const qualities = bitrates
            .filter(br => br.play_addr?.url_list?.[0])
            .map(br => {
              const h = br.play_addr?.height || 0;
              const w = br.play_addr?.width || 0;
              let qualityLabel = '';
              if (h >= 2160) qualityLabel = '4K';
              else if (h >= 1440) qualityLabel = '2K';
              else if (h >= 1080) qualityLabel = '1080p';
              else if (h >= 720) qualityLabel = '720p';
              else if (h >= 480) qualityLabel = '480p';
              else if (h >= 360) qualityLabel = '360p';
              else qualityLabel = `${h}p`;
              return {
                quality: qualityLabel,
                format: 'video/mp4',
                width: w,
                height: h,
                hasVideo: true,
                hasAudio: true
              };
            })
            .sort((a, b) => (b.height || 0) - (a.height || 0));
          
          // Remove duplicates with same height, keep highest bitrate
          const unique = [];
          const seen = new Set();
          for (const q of qualities) {
            if (!seen.has(q.height)) {
              seen.add(q.height);
              unique.push(q);
            }
          }
          
          return res.json({
            code: 0,
            data: {
              title: detail.desc || '抖音作品',
              thumbnail: video.cover?.url_list?.[0] || '',
              duration: video.duration ? Math.floor(video.duration / 1000) : 0,
              platform: 'douyin',
              qualities: unique.length > 0 ? unique : [{ quality: '720p', format: 'video/mp4', width: 1280, height: 720, hasVideo: true, hasAudio: true }]
            }
          });
        }
      } catch (e) {
        console.error('[video-info] Douyin error:', e.message);
      }
    }
    
    // For other platforms, return default quality
    return res.json({
      code: 0,
      data: {
        title: 'Video',
        thumbnail: '',
        duration: 0,
        platform: platform || 'auto',
        qualities: [
          { quality: 'Best', format: 'video/mp4', width: 0, height: 0, hasVideo: true, hasAudio: true }
        ]
      }
    });
  } catch (e) {
    console.error('[video-info] Error:', e.message);
    return res.status(500).json({ code: -1, message: e.message });
  }
}

module.exports = {
  createDownload,
  getInfo,
  getStatus,
  getHistory,
  getSystemStatus,
  deleteTask,
  clearHistory,
  detectPlatform,
  getVideoInfo
};
// force redeploy Thu Mar 26 13:57:07 CST 2026

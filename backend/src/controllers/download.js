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
const { validateInput, validateUrl, extractUrl } = require('../utils/validator');
const { executeWithRetry, downloadWithLimit, getLimiterStatus } = require('../utils/limiter');
const { tikhubRequest } = require('../services/tikhub');
const path = require('path');
const fs = require('fs');
const axios = require('axios');
const crypto = require('crypto');

// 新增工具导入
const taskLock = require('../utils/taskLock');
const asyncFs = require('../utils/asyncFs');
const fileRefManager = require('../utils/fileRefManager');
const { signTaskDownloadFields } = require('../utils/downloadToken');
const { isPrivateHost } = require('../utils/httpGet');
const { spawn } = require('child_process');
const logger = require('../utils/logger');
const { heightToLabel, formatSize, detectPlatform } = require('../utils/media');
const { getAiCopywriteMonthlyLimit, monthStartUnix, retentionSummaryForUser } = require('../utils/entitlements');
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
const MAX_STREAM_DOWNLOAD_BYTES = parseInt(process.env.MAX_STREAM_DOWNLOAD_BYTES || String(500 * 1024 * 1024), 10);

// 获取客户端 IP
const getClientIp = (req) => req.ip || (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || 'unknown';

function canAccessTask(req, task) {
  if (!task) return false;
  if (req.user?.id) return task.userId === req.user.id;
  return !task.userId && task.guestIp === getClientIp(req);
}

function signTaskResponse(data) {
  return signTaskDownloadFields(data);
}

function buildAiCacheKey(feature, payload) {
  const hash = crypto
    .createHash('sha256')
    .update(JSON.stringify(payload || {}))
    .digest('hex');
  return `${feature}:${hash}`;
}

async function getCachedAiResult(feature, payload) {
  try {
    const userDb = require('../userDb');
    const cacheKey = buildAiCacheKey(feature, payload);
    const cached = await userDb.getAiCache(cacheKey);
    if (cached !== null && cached !== undefined) {
      logger.info(`[ai-cache] hit feature=${feature}`);
      return cached;
    }
    return null;
  } catch (e) {
    logger.warn(`[ai-cache] read failed feature=${feature}: ${e.message}`);
    return null;
  }
}

async function setCachedAiResult(feature, payload, result) {
  try {
    const userDb = require('../userDb');
    const cacheKey = buildAiCacheKey(feature, payload);
    await userDb.setAiCache(cacheKey, feature, result);
  } catch (e) {
    logger.warn(`[ai-cache] write failed feature=${feature}: ${e.message}`);
  }
}

function summarizeAiUsage(rows, feature, monthlyLimit) {
  const row = (rows || []).find(item => item.feature === feature) || {};
  const used = Number(row.requests || 0);
  return {
    feature,
    used,
    limit: monthlyLimit,
    remaining: monthlyLimit < 0 ? -1 : Math.max(0, monthlyLimit - used),
    inputChars: Number(row.input_chars || 0),
    outputItems: Number(row.output_items || 0)
  };
}

async function buildAsrCorrectionContext(task, language = 'auto') {
  if (!task) return '';
  const parts = [];
  if (task.title) parts.push(`视频标题：${task.title}`);
  if (task.platform) parts.push(`平台：${task.platform}`);
  if (task.userId) {
    try {
      const userDb = require('../userDb');
      const rows = await userDb.getAsrLexicon(task.userId, language || 'auto');
      const terms = rows.map(row => row.term).filter(Boolean).slice(0, 80);
      const replacements = [];
      const customTerms = [];
      for (const term of terms) {
        const [wrong, correct] = term.split('=').map(item => item.trim());
        if (wrong && correct) replacements.push(`${wrong} => ${correct}`);
        else customTerms.push(term);
      }
      if (customTerms.length) parts.push(`用户专有词：${customTerms.join('、')}`);
      if (replacements.length) parts.push(`ASR纠错映射（必须按此替换）：${replacements.join('；')}`);
    } catch (e) {
      logger.warn('[ASR] load lexicon failed:', e.message);
    }
  }
  return parts.join('\n');
}

async function getCopywriteUsageOrBlock(user, taskId) {
  const userDb = require('../userDb');
  const monthStart = monthStartUnix();
  const monthlyLimit = getAiCopywriteMonthlyLimit(user);
  const usageRows = await userDb.getAiUsage(user.id, monthStart);
  const usage = summarizeAiUsage(usageRows, 'copywrite', monthlyLimit);
  if (monthlyLimit >= 0 && usage.remaining <= 0) {
    const err = new Error(`本月 AI 文案额度已用完（${usage.used}/${monthlyLimit}）`);
    err.statusCode = 403;
    err.data = { usage, periodStart: monthStart, taskId };
    throw err;
  }
  return { usage, periodStart: monthStart };
}

async function saveCopywriteResult({ taskId, task, user, transcript, analysis }) {
  const userDb = require('../userDb');
  store.update(taskId, {
    copywriteAnalysis: analysis,
    copywriteTranscript: transcript,
    commerceCardStatus: 'completed',
    tags: analysis?.tags || task.tags || []
  });
  await userDb.updateHistoryMeta({
    userId: user.id,
    taskId,
    tags: analysis?.tags || [],
    aiAnalysis: analysis
  });
  await userDb.recordAiUsage({
    userId: user.id,
    taskId,
    feature: 'copywrite',
    inputChars: transcript?.length || 0,
    outputItems: Array.isArray(analysis?.tags) ? analysis.tags.length : 0
  });
}

async function generateCommerceCardForTask(taskId, user, outputLanguage = null, industry = 'general') {
  if (!user) throw new Error('请先登录');
  const userDb = require('../userDb');
  if (!userDb.isVip(user) && !userDb.isBasic(user)) {
    const err = new Error('带货素材卡为 Basic/Pro 会员功能');
    err.statusCode = 403;
    throw err;
  }

  let task = store.get(taskId);
  if (!task) {
    const historyItem = await userDb.getHistoryItem(user.id, null, taskId);
    if (!historyItem) throw new Error('任务不存在或文件已过期');
    task = store.save({
      taskId,
      userId: user.id,
      url: historyItem.url,
      platform: historyItem.platform,
      title: historyItem.title,
      thumbnailUrl: historyItem.thumbnail_url,
      duration: historyItem.duration,
      status: TASK_STATUS.COMPLETED,
      progress: 100,
      tags: safeJsonArray(historyItem.tags),
      notes: historyItem.notes || '',
      groupName: historyItem.group_name || '',
      copywriteAnalysis: safeJsonObject(historyItem.ai_analysis),
      historySaved: true,
      createdAt: Number(historyItem.created_at || Math.floor(Date.now() / 1000)) * 1000
    });
  } else if (task.userId !== user.id) {
    const err = new Error('无权操作该任务');
    err.statusCode = 403;
    throw err;
  }
  if (task.status !== TASK_STATUS.COMPLETED) {
    const err = new Error('任务尚未完成，无法分析文案');
    err.statusCode = 400;
    throw err;
  }
  await getCopywriteUsageOrBlock(user, taskId);

  store.update(taskId, { commerceCardStatus: 'processing' });
  let transcript = task.asrText || task.copywriteTranscript || '';
  let analysis = null;

  const language = outputLanguage || task.outputLanguage || 'zh';
  if (transcript && transcript.length >= 5) {
    const { analyzeWithAI } = require('../services/ai-copywrite');
    analysis = await analyzeWithAI(transcript, language, industry);
  } else {
    const { extractCopywrite } = require('../services/ai-copywrite');
    const result = await extractCopywrite(taskId, task.platform || '', language, industry);
    transcript = result.transcript;
    analysis = result.analysis;
  }

  await saveCopywriteResult({ taskId, task, user, transcript, analysis });
  return { transcript, analysis };
}

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
  let parsed;
  try { parsed = new URL(url); } catch { throw new Error('Invalid download URL'); }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('Only http/https download URLs are allowed');
  }
  if (isPrivateHost(parsed.hostname)) {
    throw new Error('Refused to download from private host');
  }
  const writer = fs.createWriteStream(destPath);
  const response = await axios.get(url, { responseType: 'stream', timeout, maxRedirects: 5 });
  const finalUrl = response.request?.res?.responseUrl;
  if (finalUrl) {
    const finalParsed = new URL(finalUrl);
    if (isPrivateHost(finalParsed.hostname)) {
      writer.close();
      await asyncFs.safeUnlink(destPath);
      throw new Error('Refused redirect to private host');
    }
  }

  // 检查 Content-Type，防止下载到 HTML 错误页
  const contentType = response.headers['content-type'] || '';
  if (contentType.includes('text/html') || contentType.includes('application/json')) {
    writer.close();
    await asyncFs.safeUnlink(destPath);
    throw new Error('Video link expired or blocked');
  }
  const contentLength = Number(response.headers['content-length'] || 0);
  if (contentLength > MAX_STREAM_DOWNLOAD_BYTES) {
    writer.close();
    await asyncFs.safeUnlink(destPath);
    throw new Error('File too large');
  }

  return new Promise((resolve, reject) => {
    let downloaded = 0;
    response.data.on('data', async (chunk) => {
      downloaded += chunk.length;
      if (downloaded > MAX_STREAM_DOWNLOAD_BYTES) {
        response.data.destroy(new Error('File too large'));
      }
    });
    response.data.pipe(writer);
    response.data.on('error', async (err) => {
      await asyncFs.safeUnlink(destPath);
      reject(err);
    });
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

    // 下载成功后扣除 HD 试用次数（避免失败时浪费试用）
    if (task.hdTrialPending && task.userId) {
      try {
        const userDb = require('../userDb');
        await userDb.useHdTrial(task.userId);
        logger.info(`[finalize] HD trial deducted for user ${task.userId}`);
      } catch (e) { logger.error('[finalize] HD trial deduct failed:', e.message); }
    }

    // 记录实际文件大小到缓存
    try {
      const { recordSizes } = require('../services/sizeCache');
      const fs = require('fs');
      const path = require('path');
      const DOWNLOAD_DIR = path.join(__dirname, '../../downloads');
      const files = fs.readdirSync(DOWNLOAD_DIR).filter(f => 
        f.startsWith(taskId) && (f.endsWith('.mp4') || f.endsWith('.mkv') || f.endsWith('.webm'))
      );
      if (files.length > 0) {
        const filePath = path.join(DOWNLOAD_DIR, files[0]);
        const realSize = fs.statSync(filePath).size;
        recordSizes(task.url, { _default: realSize });
      }
    } catch (e) {
      // 缓存记录失败不影响主流程
    }
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

    let { url, platform, needAsr = false, options = ['video'], saveTarget = 'phone', quality = null, asrLanguage = 'zh', targetLang = null, outputLanguage = 'zh' } = req.body;

    // 从分享文本中提取 URL
    const { extractUrl } = require('../utils/validator');
    const extracted = extractUrl(url);
    if (extracted) url = extracted;

    // 平台自动识别
    const detectedPlatform = detectPlatform(url);
    const finalPlatform = platform || detectedPlatform || 'auto';

    // 兼容:前端 'audio' 和 'audio_only' 选项
    const rawOptions = Array.isArray(options) ? options : [options];
    const normalizedOptions = rawOptions.map(
      o => o === 'asr' || o === 'audio_only' ? 'audio' : o
    );

    const wantsAsr = !!needAsr || rawOptions.some(o => ['asr', 'ai_summary', 'translate_subtitle', 'copywriting'].includes(o));

    // ========== 用户限额检查（auth.optional 中间件已设置 req.user） ==========
    const userDb = require('../userDb');
    const isGuest = !req.user;
    const userId = req.user ? req.user.id : null;
    const isVip = req.user ? userDb.isVip(req.user) : false;
    const wantsProAiTool = rawOptions.some(o => ['ai_summary', 'translate_subtitle', 'copywriting'].includes(o));
    if (wantsProAiTool && !isVip) {
      return res.status(403).json({ code: 403, message: 'AI 工具为 Pro 会员功能' });
    }

    if (!isGuest) {
      // 检查邮箱是否已验证
      if (req.user.email_verified !== 1) {
        return res.json({
          code: 403,
          message: '请先验证邮箱后再下载。查收注册邮箱点击验证链接。'
        });
      }

      const usage = await userDb.getUsage(userId);
      if (!usage.isPro && usage.remaining <= 0) {
        return res.json({
          code: RESPONSE_CODE.FORBIDDEN,
          message: `今日下载次数已用完(${usage.dailyLimit}次/天)。升级 Pro 解锁无限制下载`
        });
      }
      // 注意：不在这里增加计数，等下载成功后再增加
    }

    // 游客每日下载限制
    let guestIp = null;
    if (isGuest) {
      guestIp = getClientIp(req);
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
    let hdTrialPending = false;
    if (quality) {
      const heightMatch = quality.match(/height<=(\d+)/i);
      const selectedHeight = heightMatch ? parseInt(heightMatch[1]) : 99999;

      if (selectedHeight > QUALITY.HD_THRESHOLD && !isVip) {
        // 免费用户允许试用1次高清画质
        const userDb = require('../userDb');
        const trialAvailable = await userDb.checkHdTrial(userId);
        if (!trialAvailable) {
          return res.json({
            code: RESPONSE_CODE.FORBIDDEN,
            message: `${QUALITY.HD_THRESHOLD}p以上画质为会员专享。试用次数已用完,请升级Pro解锁高清下载。`
          });
        }
        // 仅标记待扣除，实际扣除在 finalizeTask（下载成功后）
        hdTrialPending = true;
        logger.info(`[task] HD trial pending for user ${userId}`);
      }
    }
    // ========== 画质VIP限制检查结束 ==========

    // ========== Pro 原画每日限流（30次/天，防滥用） ==========
    if (isVip && quality) {
      const hMatch = quality.match(/height<=(\d+)/i);
      const qHeight = hMatch ? parseInt(hMatch[1]) : 0;
      if (qHeight >= 1440 || qHeight >= 99999) {
        const userDb = require('../userDb');
        const todayOriginal = await userDb.getTodayOriginalDownloads(userId);
        if (todayOriginal >= 30) {
          quality = `bestvideo[height<=1080]+bestaudio/best[height<=1080]`;
          logger.info(`[task] User ${userId} exceeded daily original limit (30), downgrading to 1080p`);
        }
      }
    }
    // ========== 原画限流结束 ==========

    // ========== 免费用户画质强制限制 720p ==========
    // 对所有平台生效：非VIP用户下载画质不得超过720p（除非使用了HD试用）
    const FREE_MAX_HEIGHT = QUALITY.HD_THRESHOLD; // 720
    let safeQuality = quality;
    if (!isVip && !hdTrialPending) {
      if (!safeQuality) {
        // 未指定画质：默认限制 720p
        safeQuality = `bestvideo[height<=${FREE_MAX_HEIGHT}]+bestaudio/best[height<=${FREE_MAX_HEIGHT}]`;
      } else {
        const hMatch = safeQuality.match(/height<=(\d+)/i);
        if (hMatch && parseInt(hMatch[1]) > FREE_MAX_HEIGHT) {
          // 用户选了1080p+但非VIP: 替换为720p
          safeQuality = safeQuality.replace(/height<=\d+/gi, `height<=${FREE_MAX_HEIGHT}`);
          logger.info(`[download] Non-VIP quality capped: ${quality} → ${safeQuality}`);
        } else if (!hMatch) {
          // 画质字符串中没有height<=: 添加限制
          safeQuality = safeQuality.replace(/bestvideo/gi, `bestvideo[height<=${FREE_MAX_HEIGHT}]`);
          logger.info(`[download] Non-VIP quality constrained: ${quality} → ${safeQuality}`);
        }
      }
    }
    // ========== 免费用户画质强制限制结束 ==========

    const limitStatus = getLimiterStatus();
    if (limitStatus.queued >= LIMITS.MAX_QUEUE) {
      return res.json({ code: HTTP_STATUS.TOO_MANY_REQUESTS, message: '任务队列已满,请稍后再试' });
    }

    const taskId = uuidv4();

    // 去重：同一用户30秒内相同URL不重复创建任务
    const existingTasks = store.list().filter(t => {
      const isSame = (isGuest ? t.guestIp === guestIp : t.userId === userId);
      return isSame && t.url === url.trim() && (Date.now() - (t.createdAt || 0) < 30000);
    });
    if (existingTasks.length > 0) {
      logger.info(`[download] Duplicate request, returning existing task: ${existingTasks[0].taskId}`);
      return res.json({ code: RESPONSE_CODE.SUCCESS, data: { taskId: existingTasks[0].taskId, status: existingTasks[0].status, platform: finalPlatform } });
    }

    const task = {
      taskId,
      url: url.trim(),
      platform: finalPlatform,
      needAsr: wantsAsr,
      targetLang,
      outputLanguage,
      asrLanguage,
      options: normalizedOptions,
      saveTarget,
      status: 'pending',
      progress: 0,
      createdAt: Date.now(),
      userId: isGuest ? null : userId,
      guestIp: isGuest ? guestIp : null,
      hdTrialPending: hdTrialPending || false,
      quality: safeQuality
    };

    store.save(task);

    // 抖音链接:走专用下载器(不依赖 yt-dlp)
    // VIP 不限画质（默认 1080p），免费用户最高 720p
    const { isDouyinUrl } = require('../services/douyin');
    if (isDouyinUrl(url)) {
      const douyinQuality = safeQuality || (isVip ? null : `bestvideo[height<=${FREE_MAX_HEIGHT}]+bestaudio/best[height<=${FREE_MAX_HEIGHT}]`);
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
      processTikTok(taskId, url, wantsAsr, normalizedOptions, safeQuality).catch(err => {
        logger.error(`[task] ${taskId} tiktok failed:`, err);
        store.update(taskId, { status: TASK_STATUS.ERROR, progress: 0, error: err.message });
      });
      return res.json({ code: RESPONSE_CODE.SUCCESS, data: { taskId, status: TASK_STATUS.PENDING, platform: PLATFORM.TIKTOK } });
    }

    // YouTube 链接:走 TikHub API(直接链接)
    if (/youtube\.com|youtu\.be/i.test(url)) {
      // VIP用户不传quality限制,后端自动使用最高画质；免费用户使用safeQuality(已限制720p)
      processYouTube(taskId, url, wantsAsr, normalizedOptions, isVip ? null : safeQuality).catch(err => {
        logger.error(`[task] ${taskId} youtube failed:`, err);
        store.update(taskId, { status: TASK_STATUS.ERROR, progress: 0, error: err.message });
      });
      return res.json({ code: RESPONSE_CODE.SUCCESS, data: { taskId, status: TASK_STATUS.PENDING, platform: PLATFORM.YOUTUBE } });
    }

    // Bilibili 链接:走 TikHub API
    if (/bilibili\.com|b23\.tv/i.test(url)) {
      processBilibili(taskId, url, wantsAsr, normalizedOptions, safeQuality).catch(err => {
        logger.error(`[task] ${taskId} bilibili failed:`, err);
        store.update(taskId, { status: TASK_STATUS.ERROR, progress: 0, error: err.message });
      });
      return res.json({ code: RESPONSE_CODE.SUCCESS, data: { taskId, status: TASK_STATUS.PENDING, platform: PLATFORM.BILIBILI } });
    }

    // 小红书链接:走 TikHub API
    if (/xiaohongshu\.com|xhslink\.com/i.test(url)) {
      processXiaohongshu(taskId, url, wantsAsr, normalizedOptions, safeQuality).catch(err => {
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

    // 红果短剧:分享页 HTML 内含 MP4 直链
    const { isHongguoUrl } = require('../services/hongguo');
    if (isHongguoUrl(url)) {
      processHongguo(taskId, url, wantsAsr, normalizedOptions).catch(err => {
        logger.error(`[task] ${taskId} hongguo failed:`, err);
        store.update(taskId, { status: TASK_STATUS.ERROR, progress: 0, error: err.message });
      });
      return res.json({ code: RESPONSE_CODE.SUCCESS, data: { taskId, status: TASK_STATUS.PENDING, platform: PLATFORM.HONGGUO } });
    }

    // Instagram 链接:走 TikHub API
    if (/instagram\.com|instagr\.am/i.test(url)) {
      processInstagram(taskId, url, wantsAsr, normalizedOptions, safeQuality).catch(err => {
        logger.error(`[task] ${taskId} instagram failed:`, err);
        store.update(taskId, { status: TASK_STATUS.ERROR, progress: 0, error: err.message });
      });
      return res.json({ code: RESPONSE_CODE.SUCCESS, data: { taskId, status: TASK_STATUS.PENDING, platform: PLATFORM.INSTAGRAM } });
    }

    // Bilibili 已在上面 TikHub 分支处理，此处不再重复

    // 其他/隐藏兼容平台:优先尝试 HTML 内嵌视频直链,失败再走 yt-dlp
    processUnknownDownload(taskId, url, wantsAsr, normalizedOptions, safeQuality).catch(err => {
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
    let { url } = req.query;
    if (!url) {
      return res.json({ code: 400, message: '请提供 url 参数' });
    }
    url = extractUrl(String(url)) || String(url).trim();
    const validation = validateUrl(url, 'auto');
    if (!validation.valid) {
      return res.json({ code: 400, message: validation.message });
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
 * 生成 SRT 字幕文件 + 烧录到视频中
 */
async function burnSubtitlesIntoVideo(taskId, videoPath, subtitleText, targetLang, segments = [], segmentTranslations = []) {
  const downloadDir = path.join(__dirname, '../../downloads');
  const srtPath = path.join(downloadDir, taskId + '_subs.srt');
  const outputPath = path.join(downloadDir, taskId + '_subbed.mp4');

  // 生成 SRT — 优先用 ASR 时间戳，否则按时长均分
  let srt = '';
  let videoDuration = 0;
  try {
    const { spawnSync } = require('child_process');
    const probe = spawnSync('ffprobe', ['-v', 'quiet', '-show_entries', 'format=duration', '-of', 'csv=p=0', videoPath]);
    videoDuration = parseFloat(probe.stdout.toString().trim()) || 60;
  } catch { videoDuration = 60; }

  const timedSegments = (segments || []).filter(s =>
    s &&
    typeof s.start === 'number' &&
    typeof s.end === 'number' &&
    s.end > s.start &&
    s.start < videoDuration
  );

  if (timedSegments.length > 0) {
    const fallbackTexts = splitSubtitleTextForCues(subtitleText, timedSegments.length, targetLang);
    let cueIndex = 0;
    for (let i = 0; i < segments.length; i++) {
      const s = segments[i];
      if (!s || typeof s.start !== 'number' || typeof s.end !== 'number' || s.end <= s.start || s.start >= videoDuration) continue;
      const start = Math.max(0, s.start);
      const end = Math.min(Math.max(s.end, start + 0.8), videoDuration);
      const cueText = formatSubtitleCue(segmentTranslations[i] || fallbackTexts[cueIndex] || s.text || '', targetLang);
      if (cueText) {
        cueIndex++;
        srt += `${cueIndex}\n${formatSrtTime(start)} --> ${formatSrtTime(end)}\n${cueText}\n\n`;
      }
    }
  } else {
    // 无时间戳 → 按句子均分（每段最多 80 字，时间按比例）
    const chunks = splitSubtitleTextForCues(subtitleText, Math.ceil(videoDuration / 3), targetLang);
    const chunkDur = videoDuration / Math.max(chunks.length, 1);
    for (let i = 0; i < chunks.length; i++) {
      const start = i * chunkDur;
      const end = Math.min((i + 1) * chunkDur, videoDuration);
      srt += `${i + 1}\n${formatSrtTime(start)} --> ${formatSrtTime(end)}\n${formatSubtitleCue(chunks[i], targetLang)}\n\n`;
    }
  }
  await asyncFs.safeWriteFile(srtPath, srt, 'utf-8');

  // ffmpeg 烧录字幕 — 底部居中，一行一行显示
  await new Promise((resolve, reject) => {
    const { spawn } = require('child_process');
    const fontStyle = "Alignment=2,MarginV=42,FontSize=18,Outline=1,Shadow=0,BorderStyle=1,WrapStyle=2";
    const args = ['-i', videoPath, '-vf', `subtitles=${srtPath}:force_style='${fontStyle}'`, '-c:a', 'copy', '-y', outputPath];
    const ff = spawn('ffmpeg', args);
    let stderr = '';
    ff.stderr.on('data', d => { stderr += d.toString(); });
    ff.on('error', err => reject(err));
    const timer = setTimeout(() => { ff.kill('SIGKILL'); reject(new Error('subtitle burn timeout')); }, 300000);
    ff.on('close', code => { clearTimeout(timer); code === 0 ? resolve() : reject(new Error('ffmpeg exit ' + code + ': ' + stderr.substring(0,200))); });
  });

  // 清理 SRT 文件
  await asyncFs.safeUnlink(srtPath);
  return outputPath;
}

function formatSrtTime(seconds) {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  const ms = Math.floor((seconds % 1) * 1000);
  return `${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')},${String(ms).padStart(3,'0')}`;
}

function splitSubtitleTextForCues(text, targetCount = 1, language = '') {
  const cleaned = String(text || '').replace(/\s+/g, ' ').trim();
  if (!cleaned) return [];
  const maxChars = isCjkLanguage(language) ? 18 : 42;
  const sentences = cleaned
    .split(/(?<=[.!?。！？；;])\s*/)
    .map(item => item.trim())
    .filter(Boolean);

  const chunks = [];
  let current = '';
  for (const sentence of sentences.length ? sentences : [cleaned]) {
    if ((current + sentence).length > maxChars * 2 && current) {
      chunks.push(current.trim());
      current = sentence;
    } else {
      current += (current ? ' ' : '') + sentence;
    }
  }
  if (current.trim()) chunks.push(current.trim());

  const expanded = [];
  for (const chunk of chunks) {
    if (chunk.length <= maxChars * 2) {
      expanded.push(chunk);
      continue;
    }
    for (let i = 0; i < chunk.length; i += maxChars * 2) {
      expanded.push(chunk.slice(i, i + maxChars * 2));
    }
  }

  if (targetCount > 0 && expanded.length < targetCount) {
    while (expanded.length < targetCount) expanded.push('');
  }
  return targetCount > 0 ? expanded.slice(0, targetCount) : expanded;
}

function formatSubtitleCue(text, language = '') {
  const cleaned = String(text || '').replace(/\s+/g, ' ').trim();
  if (!cleaned) return '';
  const maxLineChars = isCjkLanguage(language) ? 18 : 42;
  const maxCueChars = maxLineChars * 2;
  const clipped = cleaned.length > maxCueChars ? cleaned.slice(0, maxCueChars - 1) + '…' : cleaned;
  const lines = [];
  for (let i = 0; i < clipped.length && lines.length < 2; i += maxLineChars) {
    lines.push(clipped.slice(i, i + maxLineChars).trim());
  }
  return lines.filter(Boolean).join('\n');
}

function isCjkLanguage(language = '') {
  return /^(zh|ja|ko)/i.test(String(language || ''));
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

    // ASR 转文字（含时间戳）
    const asrResult = await asr.transcribe(audioPath, asrLanguage);
    let text = typeof asrResult === 'string' ? asrResult : asrResult.text;
    const rawText = text;
    const asrSegments = typeof asrResult === 'object' ? (asrResult.segments || []) : [];
    const task = store.get(taskId);
    const correctionContext = await buildAsrCorrectionContext(task, asrLanguage);

    // AI 同音纠错（自动，失败不影响 ASR）
    if (text && text.length >= 10) {
      try {
        const { correctWithDeepSeek } = require('../services/summarize');
        const correctionCachePayload = {
          owner: task?.userId ? `user:${task.userId}` : `guest:${task?.guestIp || 'anonymous'}`,
          language: asrLanguage,
          context: correctionContext,
          text
        };
        let corrected = await getCachedAiResult('asr-correction', correctionCachePayload);
        if (!corrected) {
          corrected = await correctWithDeepSeek(text, asrLanguage, correctionContext);
          await setCachedAiResult('asr-correction', correctionCachePayload, corrected || text);
        }
        if (corrected && corrected !== text) {
          text = corrected;
          logger.info('[ASR] Text corrected (homophone fix)');
        }
      } catch (e) {
        logger.warn('[ASR] Correction failed:', e.message);
      }
    }

    // AI 摘要（自动生成，失败不影响 ASR）
    let summary = null;
    if (text && text.length >= 50) {
      try {
        const { summarizeText, videoSummary: videoSum } = require('../services/summarize');
        summary = await summarizeText(text, asrLanguage);
        // VIP 自动生成视频总结（DeepSeek）
        if (task?.userId) {
          const userDb = require('../userDb');
          const user = await userDb.getById(task.userId);
          if (user && userDb.isVip(user)) {
            const fullSummary = await videoSum(text, task?.title || '', asrLanguage);
            if (fullSummary) summary = { ...summary, ...fullSummary };
          }
        }
      } catch (e) {
        logger.warn(`[summarize] ${taskId} failed: ${e.message}`);
      }
    }

    // 翻译(如果指定了目标语言) + AI 润色
    const tLang = targetLang || task?.targetLang;
    logger.info(`[ASR] ${taskId} targetLang=${targetLang}, task.targetLang=${task?.targetLang}, tLang=${tLang}`);
    let translatedText = null;
    let translatedSegments = [];
    if (tLang && text) {
      try {
        const sourceLang = asrLanguage === 'auto' ? 'zh' : asrLanguage;
        logger.info(`[ASR] ${taskId} translating: ${sourceLang} -> ${tLang}, textLen=${text.length}`);
        // 高质量优先：只走 DeepSeek 单路径，并缓存同文本同参数结果，避免 M2M + DeepSeek 双重调用。
        const { translateWithDeepSeek, translateSubtitleSegments } = require('../services/summarize');
        if (asrSegments.length > 0) {
          const segmentCachePayload = {
            sourceLang,
            targetLang: tLang,
            context: correctionContext,
            segments: asrSegments.map(segment => String(segment.text || '').trim()).filter(Boolean)
          };
          translatedSegments = await getCachedAiResult('subtitle-translation', segmentCachePayload);
          if (!Array.isArray(translatedSegments)) {
            translatedSegments = await translateSubtitleSegments(
              asrSegments,
              sourceLang,
              tLang,
              correctionContext
            ) || [];
            await setCachedAiResult('subtitle-translation', segmentCachePayload, translatedSegments);
          }
        }
        if (translatedSegments.length > 0) {
          translatedText = translatedSegments.filter(Boolean).join('\n');
        } else {
          const textCachePayload = {
            sourceLang,
            targetLang: tLang,
            context: correctionContext,
            text
          };
          translatedText = await getCachedAiResult('text-translation', textCachePayload);
          if (!translatedText) {
            translatedText = await translateWithDeepSeek(text, sourceLang, tLang);
            await setCachedAiResult('text-translation', textCachePayload, translatedText || '');
          }
        }
      } catch (e) {
        logger.error(`[ASR] Translation failed: ${e.message}`);
      }
    }

    // 保存为 txt 文件
    const txtUrl = await saveTextFile(taskId, text, 'subtitle');
    const translatedTxtUrl = translatedText ? await saveTextFile(taskId, translatedText, 'translation') : null;

    let copywriteResult = null;
    if (task?.options?.includes('copywriting') && task?.userId) {
      try {
        const userDb = require('../userDb');
        const user = await userDb.getById(task.userId);
        if (user && userDb.isVip(user)) {
          const { analyzeWithAI } = require('../services/ai-copywrite');
          const analysis = await analyzeWithAI(text, task.outputLanguage || 'zh');
          await saveCopywriteResult({ taskId, task, user, transcript: text, analysis });
          copywriteResult = { transcript: text, analysis };
          logger.info(`[copywrite] ${taskId} commerce card generated from corrected ASR`);
        }
      } catch (e) {
        logger.warn(`[copywrite] ${taskId} automatic commerce card failed: ${e.message}`);
        store.update(taskId, { commerceCardStatus: 'error', commerceCardError: e.message });
      }
    }

    // 翻译字幕烧录到视频中（VIP 专属）
    let subbedVideoUrl = null;
    if (translatedText && tLang) {
      try {
        const subbedPath = await burnSubtitlesIntoVideo(taskId, filePath, translatedText, tLang, asrSegments, translatedSegments);
        subbedVideoUrl = '/download/' + path.basename(subbedPath);
        fileRefManager.addRef(path.basename(subbedPath));
        logger.info(`[ASR] ${taskId} subtitles burned into video`);
      } catch (e) {
        logger.warn(`[ASR] ${taskId} subtitle burn failed: ${e.message}`);
      }
    }

    // 清理临时音频
    await asyncFs.safeUnlink(audioPath);

    return { text, rawText, txtUrl, translatedText, translatedTxtUrl, summary, subbedVideoUrl, copywriteResult };
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
    const rawOptions = Array.isArray(options) ? options : [options];
    const normalizedOptions = rawOptions.map(
      o => o === 'asr' || o === 'audio_only' ? 'audio' : o
    );
    const wantsVideo = normalizedOptions.includes('video');
    const wantsAudioOnly = rawOptions.includes('audio_only') || (normalizedOptions.includes('audio') && !wantsVideo);
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
          // 解析画质参数
          let videoQuality = 'max';
          if (quality && quality.includes('height<=')) {
            const m = quality.match(/height<=(\d+)/);
            if (m) videoQuality = m[1] + 'p';
          }
          logger.info(`[task] ${taskId} trying cobalt first (generic platform, quality: ${videoQuality})...`);
          store.update(taskId, { status: TASK_STATUS.PARSING, progress: 5 });
          const cobaltResult = await downloadViaCobalt(url, taskId, {
            onProgress: (percent) => store.update(taskId, {
              status: percent < 90 ? TASK_STATUS.DOWNLOADING : TASK_STATUS.PROCESSING,
              progress: percent
            }),
            options: {
              videoQuality,
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
          logger.warn(`[task] ${taskId} cobalt failed: ${cobaltErr.message}, falling back...`);
        }
      }

      // ========== TikHub Reddit 兜底 ==========
      if (!cobaltResult && /reddit\.com|redd\.it|v\.redd\.it/i.test(url)) {
        try {
          logger.info(`[task] ${taskId} trying TikHub Reddit API...`);
          const { parseReddit } = require('../services/tikhub');
          const redditResult = await parseReddit(url, taskId, (percent) => store.update(taskId, { status: TASK_STATUS.DOWNLOADING, progress: percent }));
          if (redditResult) {
            result = { title: redditResult.title, filePath: redditResult.filePath, ext: 'mp4', downloadUrl: `/download/${taskId}.mp4`, thumbnailUrl: redditResult.thumbnailUrl, width: redditResult.width, height: redditResult.height, quality: redditResult.quality };
            fileRefManager.addRef(`${taskId}.mp4`);
          }
        } catch (e) {
          logger.warn(`[task] ${taskId} TikHub Reddit failed: ${e.message}`);
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
          if (asrResult.rawText && asrResult.rawText !== asrResult.text) update.asrRawText = asrResult.rawText;
          update.asrTxtUrl = asrResult.txtUrl;
          if (asrResult.summary) update.summaryText = asrResult.summary;
          if (asrResult.copywriteResult) {
            update.copywriteAnalysis = asrResult.copywriteResult.analysis;
            update.copywriteTranscript = asrResult.copywriteResult.transcript;
            update.commerceCardStatus = 'completed';
          }
          if (asrResult.translatedText) { update.translatedText = asrResult.translatedText; update.translatedTxtUrl = asrResult.translatedTxtUrl; }
          if (asrResult.subbedVideoUrl) update.subbedVideoUrl = asrResult.subbedVideoUrl;
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

    // 判断是否需要高清直通 TikHub
    // iesdouyin 只能提供 ≤1080p 的源，VIP 选 ≥2K 时 iesdouyin 拿不到，直接走 TikHub 付费
    // 1080p 以下优先走 iesdouyin 免费方案，失败才调 TikHub（省成本）
    let skipIesdouyin = false;
    let requestedHeight = 99999;
    if (quality && typeof quality === 'string') {
      const m = quality.match(/height\s*<=\s*(\d+)/i);
      if (m) requestedHeight = parseInt(m[1]);
    }
    const hasTikHubKey = API_KEY_DOUYIN && API_KEY_DOUYIN.length > 10;
    if (isVip && requestedHeight >= 1440 && hasTikHubKey) {
      skipIesdouyin = true;
      logger.info(`[task] ${taskId} VIP + ${requestedHeight}p, iesdouyin can't handle, using TikHub`);
    } else if (isVip && requestedHeight >= 1440 && !hasTikHubKey) {
      logger.warn(`[task] ${taskId} VIP + ${requestedHeight}p but no TikHub key, falling back to iesdouyin`);
    }

    // Step 1: 尝试 iesdouyin.com（免费方案）
    let iesdouyinError = skipIesdouyin ? 'VIP高清直通TikHub' : null;
    if (!skipIesdouyin) {
      try {
        store.update(taskId, { status: TASK_STATUS.PARSING, progress: 5 });
        result = await downloadDouyin(url, taskId, (percent, msg) => {
          store.update(taskId, {
            status: percent < 90 ? TASK_STATUS.DOWNLOADING : TASK_STATUS.PROCESSING,
            progress: percent,
          });
        }, { quality, isVip });
        logger.info(`[task] ${taskId} iesdouyin.com succeeded (quality=${result.quality}, watermarked=${!!result.watermarked})`);
      } catch (e) {
        iesdouyinError = e.message;
        logger.warn(`[task] ${taskId} iesdouyin.com failed: ${e.message}, trying TikHub...`);
      }
    }

    if (!result) {

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

        // VIP 4K 直通 TikHub 失败 → 回退 iesdouyin 拿 1080p（比完全失败强）
        if (skipIesdouyin) {
          logger.info(`[task] ${taskId} VIP HQ path failed, falling back to iesdouyin (1080p)...`);
          try {
            store.update(taskId, { status: TASK_STATUS.PARSING, progress: 5 });
            result = await downloadDouyin(url, taskId, (percent, msg) => {
              store.update(taskId, {
                status: percent < 90 ? TASK_STATUS.DOWNLOADING : TASK_STATUS.PROCESSING,
                progress: percent,
              });
            }, { quality, isVip });
            logger.info(`[task] ${taskId} iesdouyin fallback succeeded (quality=${result.quality})`);
            // 标记降级，前端可以提示
            result.qualityDowngraded = true;
          } catch (iesdouyinFallbackErr) {
            iesdouyinError = iesdouyinFallbackErr.message;
            logger.warn(`[task] ${taskId} iesdouyin fallback also failed: ${iesdouyinFallbackErr.message}`);
          }
        }

        // Step 3: yt-dlp 最后的兜底（仅当 iesdouyin fallback 也没拿到时）
        if (!result) {
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
          const iesdouyinMsg = iesdouyinError || 'unknown';
          throw new Error(`抖音解析失败: iesdouyin(${iesdouyinMsg}) → TikHub(${tikhubErr.message}) → yt-dlp(${ytdlpErr.message})`);
        }
        } // if (!result) yt-dlp guard
      }
    }

    // 获取用户请求的画质
    let task = store.get(taskId) || {};
    const reqQ = task.requestedQuality || requestedQuality;

    // 计算画质调整提示（用短边，竖屏视频高宽颠倒）
    let qualityAdjusted = null;
    if (reqQ && result.height) {
      const reqMatch = reqQ.match(/height<=(\d+)/i);
      if (reqMatch) {
        const reqHeight = parseInt(reqMatch[1]);
        const actualShortEdge = Math.min(result.width || 0, result.height || 0);
        if (actualShortEdge < reqHeight) {
          qualityAdjusted = 'downgrade'; // 降级(无更高画质源)
        } else if (actualShortEdge > reqHeight) {
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

        // ASR 转文字 + AI 纠错
        const asrResult = await asr.transcribe(audioPath, asrLanguage);
        let text = typeof asrResult === 'string' ? asrResult : asrResult.text;
        const rawText = text;
        const asrSegments = typeof asrResult === 'object' ? (asrResult.segments || []) : [];
        if (text && text.length >= 10) {
          try {
            const summarize = require('../services/summarize');
            const task = store.get(taskId);
            const correctionContext = await buildAsrCorrectionContext(task, asrLanguage);
            const deepCorrected = await summarize.correctWithDeepSeek(text, asrLanguage, correctionContext);
            const corrected = deepCorrected !== text ? deepCorrected : await summarize.correctAsrText(text, asrLanguage, correctionContext);
            if (corrected && corrected !== text) text = corrected;
            // VIP AI 视频总结
            if (task?.userId && text.length >= 50) {
              try {
                const userDb = require('../userDb');
                const user = await userDb.getById(task.userId);
                if (user && userDb.isVip(user)) {
                  const fullSummary = await summarize.videoSummary(text, task.title || '', asrLanguage);
                  if (fullSummary) update.summaryText = fullSummary;
                }
              } catch {}
            }
          } catch (e) {
            console.error('[ASR-douyin] Correction error:', e.message);
          }
        }
        if (text) {
          update.asrText = text;
          if (rawText && rawText !== text) update.asrRawText = rawText;
          update.asrTxtUrl = await saveTextFile(taskId, text, 'subtitle');
        }

        if (options.includes('copywriting') && text) {
          try {
            const userDb = require('../userDb');
            const user = task?.userId ? await userDb.getById(task.userId) : null;
            if (user && userDb.isVip(user)) {
              const { analyzeWithAI } = require('../services/ai-copywrite');
              const analysis = await analyzeWithAI(text, task.outputLanguage || 'zh');
              await saveCopywriteResult({ taskId, task, user, transcript: text, analysis });
              update.copywriteAnalysis = analysis;
              update.copywriteTranscript = text;
              update.commerceCardStatus = 'completed';
              logger.info(`[copywrite] ${taskId} douyin commerce card generated`);
            }
          } catch (e) {
            update.commerceCardStatus = 'error';
            update.commerceCardError = e.message;
            logger.warn(`[copywrite] ${taskId} douyin commerce card failed: ${e.message}`);
          }
        }

        // 翻译
        let task = store.get(taskId);
        console.error(`[DEBUG-ASR] targetLang=${task?.targetLang}, hasText=${!!text}`);
        if (task?.targetLang && text) {
          try {
            const summarize = require('../services/summarize');
            const correctionContext = await buildAsrCorrectionContext(task, asrLanguage);
            const translatedSegments = asrSegments.length > 0
              ? (await summarize.translateSubtitleSegments(asrSegments, asrLanguage === 'auto' ? 'zh' : asrLanguage, task.targetLang, correctionContext) || [])
              : [];
            const translated = await asr.translateText(text, asrLanguage === 'auto' ? 'zh' : asrLanguage, task.targetLang)
              || await summarize.translateWithDeepSeek(text, asrLanguage === 'auto' ? 'zh' : asrLanguage, task.targetLang)
              || translatedSegments.filter(Boolean).join('\n');
            if (translated) {
              update.translatedText = translated;
              update.translatedTxtUrl = await saveTextFile(taskId, translated, 'translation');
              // 烧录字幕到视频
              try {
                console.error(`[DEBUG-BURN] ${taskId} burning subtitles: file=${result.filePath}, textLen=${translated.length}, lang=${task.targetLang}`);
                const subbedPath = await burnSubtitlesIntoVideo(taskId, result.filePath, translated, task.targetLang, asrSegments, translatedSegments);
                console.error(`[DEBUG-BURN] ${taskId} OK: ${subbedPath}`);
                update.subbedVideoUrl = '/download/' + path.basename(subbedPath);
                fileRefManager.addRef(path.basename(subbedPath));
              } catch (burnErr) {
                console.error(`[DEBUG-BURN] ${taskId} FAILED: ${burnErr.message}`);
              }
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
    store.update(taskId, { status: TASK_STATUS.PARSING, progress: 5 });

    let result = null;

    // ========== Cobalt 优先（自托管 + 免费） ==========
    const { isCobaltConfigured, downloadViaCobalt } = require('../services/cobalt');
    if (isCobaltConfigured()) {
      try {
        logger.info(`[task] ${taskId} x/twitter trying cobalt first...`);
        const cobaltResult = await downloadViaCobalt(url, taskId, {
          onProgress: (percent) => store.update(taskId, {
            status: percent < 90 ? TASK_STATUS.DOWNLOADING : TASK_STATUS.PROCESSING,
            progress: percent
          }),
          options: { videoQuality: 'max', filenameStyle: 'basic' }
        });
        if (cobaltResult && !cobaltResult.isPicker) {
          // 提取标题：优先 Cobalt 文件名，否则 yt-dlp 兜底
          let xTitle = cobaltResult.cobaltFilename || '';
          if (!xTitle || xTitle === 'X Video') {
            try {
              const ytdlp = require('../services/yt-dlp');
              const info = await ytdlp.getInfo(url);
              xTitle = (info?.title || '').replace(/\.\w+$/, '');
            } catch {}
          }
          result = {
            title: xTitle || 'X Video',
            filePath: cobaltResult.filePath,
            ext: cobaltResult.ext || 'mp4',
            downloadUrl: cobaltResult.downloadUrl,
            thumbnailUrl: cobaltResult.thumbnailUrl || '',
            width: cobaltResult.width || 0,
            height: cobaltResult.height || 0,
            quality: cobaltResult.quality || 'hd',
          };
          fileRefManager.addRef(path.basename(cobaltResult.filePath));
          logger.info(`[task] ${taskId} x/twitter cobalt succeeded`);
        }
      } catch (e) {
        logger.warn(`[task] ${taskId} x/twitter cobalt failed: ${e.message}`);
      }
    }

    // ========== vxtwitter/fxtwitter 兜底 ==========
    if (!result) {
    const { downloadX } = require('../services/x-download');
    result = await downloadX(url, taskId, (percent, msg) => {
      store.update(taskId, {
        status: percent < 30 ? TASK_STATUS.PARSING : TASK_STATUS.DOWNLOADING,
        progress: percent
      });
    });
    }

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
      if (asrResult?.text) { const upd = { status: TASK_STATUS.COMPLETED, asrText: asrResult.text, asrTxtUrl: asrResult.txtUrl }; if (asrResult.rawText && asrResult.rawText !== asrResult.text) upd.asrRawText = asrResult.rawText; if (asrResult.summary) upd.summaryText = asrResult.summary; if (asrResult.translatedText) { upd.translatedText = asrResult.translatedText; upd.translatedTxtUrl = asrResult.translatedTxtUrl; } if (asrResult.subbedVideoUrl) upd.subbedVideoUrl = asrResult.subbedVideoUrl; store.update(taskId, upd); }
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
 * 处理红果短剧下载（分享页 HTML 内直接包含 MP4 play_url）
 */
async function processHongguo(taskId, url, needAsr, options = ['video']) {
  if (!taskLock.tryAcquire(taskId)) {
    logger.warn(`[task] ${taskId} is already being processed`);
    store.update(taskId, {
      status: TASK_STATUS.ERROR,
      error: 'Task is already in progress'
    });
    return;
  }

  try {
    const rawOptions = Array.isArray(options) ? options : [options];
    const normalizedOptions = rawOptions.map(o => o === 'asr' || o === 'audio_only' ? 'audio' : o);
    const wantsVideo = normalizedOptions.includes('video') || needAsr;
    const wantsAudioOnly = rawOptions.includes('audio_only') || (normalizedOptions.includes('audio') && !wantsVideo);
    if (wantsAudioOnly && !wantsVideo) {
      throw new Error('红果短剧暂不支持仅音频下载');
    }

    store.update(taskId, { status: TASK_STATUS.PARSING, progress: 5 });
    const { parseHongguo } = require('../services/hongguo');
    const { downloadFile } = require('../services/tikhub');
    const { DOWNLOAD_DIR } = require('../services/yt-dlp');
    const info = await parseHongguo(url);
    const outputPath = path.join(DOWNLOAD_DIR, `${taskId}.mp4`);

    store.update(taskId, { status: TASK_STATUS.DOWNLOADING, progress: 10 });
    await downloadFile(info.videoUrl, outputPath, (percent, downloaded, total) => {
      store.update(taskId, {
        status: percent < 95 ? TASK_STATUS.DOWNLOADING : TASK_STATUS.PROCESSING,
        progress: percent,
        downloadedBytes: downloaded || 0,
        totalBytes: total || 0
      });
    }, {
      Referer: url,
      Origin: 'https://www.novelquickapp.com',
      Accept: 'video/*,*/*;q=0.8'
    }, { timeoutMs: 120000 });

    const update = {
      status: TASK_STATUS.COMPLETED,
      width: 0,
      height: 0,
      quality: 'source',
      progress: 100,
      title: info.title || '红果短剧',
      platform: PLATFORM.HONGGUO,
      filePath: outputPath,
      ext: 'mp4',
      downloadUrl: `/download/${path.basename(outputPath)}`
    };
    fileRefManager.addRef(path.basename(outputPath));
    store.update(taskId, update);

    if (needAsr && outputPath) {
      const task = store.get(taskId);
      const asrResult = await handleAsr(taskId, outputPath, task?.asrLanguage || 'zh');
      if (asrResult?.text) {
        const asrUpdate = { status: TASK_STATUS.COMPLETED, asrText: asrResult.text, asrTxtUrl: asrResult.txtUrl };
        if (asrResult.rawText && asrResult.rawText !== asrResult.text) asrUpdate.asrRawText = asrResult.rawText;
        if (asrResult.summary) asrUpdate.summaryText = asrResult.summary;
        if (asrResult.translatedText) {
          asrUpdate.translatedText = asrResult.translatedText;
          asrUpdate.translatedTxtUrl = asrResult.translatedTxtUrl;
        }
        if (asrResult.subbedVideoUrl) asrUpdate.subbedVideoUrl = asrResult.subbedVideoUrl;
        store.update(taskId, asrUpdate);
      }
    }

    await finalizeTask(taskId);
    logger.info(`[task] ${taskId} hongguo completed`);
  } catch (error) {
    logger.error(`[task] ${taskId} hongguo failed:`, error);
    store.update(taskId, { status: TASK_STATUS.ERROR, error: error.message || '红果短剧下载失败' });
  } finally {
    taskLock.release(taskId);
  }
}

async function processHtmlVideo(taskId, url, needAsr, options = ['video'], info) {
  if (!taskLock.tryAcquire(taskId)) {
    logger.warn(`[task] ${taskId} is already being processed`);
    store.update(taskId, {
      status: TASK_STATUS.ERROR,
      error: 'Task is already in progress'
    });
    return;
  }

  try {
    const rawOptions = Array.isArray(options) ? options : [options];
    const normalizedOptions = rawOptions.map(o => o === 'asr' || o === 'audio_only' ? 'audio' : o);
    const wantsVideo = normalizedOptions.includes('video') || needAsr || normalizedOptions.includes('copywriting');
    const wantsAudioOnly = rawOptions.includes('audio_only') || (normalizedOptions.includes('audio') && !wantsVideo);
    if (wantsAudioOnly && !wantsVideo) {
      throw new Error('该网页直链暂不支持仅音频下载');
    }

    const { downloadFile } = require('../services/tikhub');
    const { DOWNLOAD_DIR } = require('../services/yt-dlp');
    const videoPath = new URL(info.videoUrl).pathname;
    const extMatch = videoPath.match(/\.(mp4|m4v|mov|webm)$/i);
    const ext = extMatch ? extMatch[1].toLowerCase() : 'mp4';
    const outputPath = path.join(DOWNLOAD_DIR, `${taskId}.${ext}`);

    store.update(taskId, { status: TASK_STATUS.DOWNLOADING, progress: 10 });
    await downloadFile(info.videoUrl, outputPath, (percent, downloaded, total) => {
      store.update(taskId, {
        status: percent < 95 ? TASK_STATUS.DOWNLOADING : TASK_STATUS.PROCESSING,
        progress: percent,
        downloadedBytes: downloaded || 0,
        totalBytes: total || 0
      });
    }, {
      Referer: url,
      Origin: new URL(url).origin,
      Accept: 'video/*,*/*;q=0.8'
    }, { timeoutMs: 120000 });

    const update = {
      status: TASK_STATUS.COMPLETED,
      width: 0,
      height: 0,
      quality: 'source',
      progress: 100,
      title: info.title || '网页视频',
      platform: PLATFORM.AUTO,
      filePath: outputPath,
      ext,
      downloadUrl: `/download/${path.basename(outputPath)}`
    };
    fileRefManager.addRef(path.basename(outputPath));
    store.update(taskId, update);

    if (needAsr && outputPath) {
      const task = store.get(taskId);
      const asrResult = await handleAsr(taskId, outputPath, task?.asrLanguage || 'zh');
      if (asrResult?.text) {
        const asrUpdate = { status: TASK_STATUS.COMPLETED, asrText: asrResult.text, asrTxtUrl: asrResult.txtUrl };
        if (asrResult.rawText && asrResult.rawText !== asrResult.text) asrUpdate.asrRawText = asrResult.rawText;
        if (asrResult.summary) asrUpdate.summaryText = asrResult.summary;
        if (asrResult.translatedText) {
          asrUpdate.translatedText = asrResult.translatedText;
          asrUpdate.translatedTxtUrl = asrResult.translatedTxtUrl;
        }
        if (asrResult.subbedVideoUrl) asrUpdate.subbedVideoUrl = asrResult.subbedVideoUrl;
        store.update(taskId, asrUpdate);
      }
    }

    await finalizeTask(taskId);
    logger.info(`[task] ${taskId} html-video completed`);
  } catch (error) {
    logger.error(`[task] ${taskId} html-video failed:`, error);
    store.update(taskId, { status: TASK_STATUS.ERROR, error: error.message || '网页视频下载失败' });
  } finally {
    taskLock.release(taskId);
  }
}

async function processUnknownDownload(taskId, url, needAsr, options = ['video'], quality = null) {
  const rawOptions = Array.isArray(options) ? options : [options];
  const normalizedOptions = rawOptions.map(o => o === 'asr' || o === 'audio_only' ? 'audio' : o);
  const canUseHtmlVideo =
    normalizedOptions.includes('video') ||
    normalizedOptions.includes('copywriting') ||
    needAsr;

  if (canUseHtmlVideo) {
    try {
      store.update(taskId, { status: TASK_STATUS.PARSING, progress: 5 });
      const { parseHtmlVideo } = require('../services/html-video');
      const info = await parseHtmlVideo(url);
      logger.info(`[task] ${taskId} using hidden html-video fallback`);
      return processHtmlVideo(taskId, url, needAsr, options, info);
    } catch (error) {
      logger.info(`[task] ${taskId} html-video fallback skipped: ${error.message}`);
    }
  }

  return processDownload(taskId, url, needAsr, options, quality);
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
    // 原画模式跳过 Cobalt，直接用 Yout.com 拿最高码率
    const isOriginalQuality = quality && quality.includes('height<=99999');
    const { isCobaltConfigured, downloadViaCobalt } = require('../services/cobalt');
    let cobaltResult = null;
    if (isCobaltConfigured() && !isOriginalQuality) {
      try {
        logger.info(`[task] ${taskId} youtube trying cobalt first...`);
        cobaltResult = await downloadViaCobalt(url, taskId, {
          onProgress: (percent) => store.update(taskId, {
            status: percent < 90 ? TASK_STATUS.DOWNLOADING : TASK_STATUS.PROCESSING,
            progress: percent
          }),
          options: {
            videoQuality,
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
        width: cobaltResult.width || 0,
        height: cobaltResult.height || 1080,
        quality: cobaltResult.cobaltFilename || '1080p',
        progress: 100,
        title: cobaltResult.title || 'YouTube Video',
        downloadUrl: cobaltResult.downloadUrl,
        filePath: cobaltResult.filePath,
        ext: cobaltResult.ext
      };
      const refName = cobaltResult.filePath.split('/').pop();
      fileRefManager.addRef(refName);
      store.update(taskId, cobaltUpdate);

      // 处理 ASR（Cobalt 成功后）
      if (needAsr && cobaltResult.filePath) {
        const asrResult = await handleAsr(taskId, cobaltResult.filePath, 'zh');
        if (asrResult?.text) {
          const upd = { status: TASK_STATUS.COMPLETED, asrText: asrResult.text, asrTxtUrl: asrResult.txtUrl };
          if (asrResult.rawText && asrResult.rawText !== asrResult.text) upd.asrRawText = asrResult.rawText;
          if (asrResult.summary) upd.summaryText = asrResult.summary;
          if (asrResult.translatedText) {
            upd.translatedText = asrResult.translatedText;
            upd.translatedTxtUrl = asrResult.translatedTxtUrl;
          }
          store.update(taskId, upd);
        }
      }

      await finalizeTask(taskId);
      logger.info(`[task] ${taskId} youtube completed via cobalt`);
      return;
    }

    // ========== TikHub v2 API Fallback (跳过原画模式) ==========
    let result = null;
    if (!isOriginalQuality) {
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
    } // end if (!isOriginalQuality)

    // ========== Invidious 免费兜底 ==========
    if (!result) {
      try {
        logger.info(`[task] ${taskId} youtube trying Invidious (free)...`);
        const invidiousResult = await ytdlp.downloadViaInvidious(url, taskId, (percent) => {
          store.update(taskId, {
            status: percent < 90 ? TASK_STATUS.DOWNLOADING : TASK_STATUS.PROCESSING,
            progress: percent
          });
        });
        if (invidiousResult) {
          const update = {
            status: TASK_STATUS.COMPLETED,
            height: 720,
            quality: '720p',
            progress: 100,
            title: invidiousResult.title || 'YouTube Video',
            thumbnailUrl: invidiousResult.thumbnailUrl || '',
            downloadUrl: `/download/${taskId}.mp4`,
            filePath: invidiousResult.filePath,
            ext: 'mp4'
          };
          fileRefManager.addRef(`${taskId}.mp4`);
          store.update(taskId, update);
          await finalizeTask(taskId);
          logger.info(`[task] ${taskId} youtube completed via Invidious`);
          return;
        }
      } catch (e) {
        logger.warn(`[task] ${taskId} Invidious failed: ${e.message}`);
      }
    }

    // ========== Yout.com API (解决 Vultr IP 被 Google 封锁问题) ==========
    const { isYoutConfigured, downloadViaYout } = require('../services/yout');
    if (isYoutConfigured()) {
      try {
        logger.info(`[task] ${taskId} youtube trying yout.com API...`);
        
        // 先获取视频标题（通过 yt-dlp）
        let videoTitle = 'YouTube Video';
        try {
          const ytdlp = require('../services/yt-dlp');
          const info = await ytdlp.getInfo(url);
          videoTitle = info?.title || videoTitle;
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

    let update; // shared: Cobalt or TikHub will fill this

    // Step 1: Cobalt (免费自托管)
    let usedCobalt = false;
    let usedYtdlp = false;
    let resolvedTikTokUrl = url;
    const { isCobaltConfigured, downloadViaCobalt } = require('../services/cobalt');
    if (isCobaltConfigured()) {
      // Cobalt 不支持 TikTok 短链，先展开
      if (/vm\.tiktok\.com|vt\.tiktok\.com|tiktok\.com\/t\//i.test(url)) {
        try {
          const resp = await axios.head(url, { maxRedirects: 5, timeout: 10000 });
          const redirectUrl = resp.request?.res?.responseUrl || '';
          if (redirectUrl && /tiktok\.com\/@?\w+\/video\/\d+/i.test(redirectUrl)) {
            resolvedTikTokUrl = redirectUrl;
            logger.info(`[task] ${taskId} TikTok short link resolved for Cobalt`);
          }
        } catch (e) { /* keep original URL */ }
      }
      try {
        // 解析画质参数
        let videoQuality = 'max';
        if (quality && quality.includes('height<=')) {
          const m = quality.match(/height<=(\d+)/);
          if (m) videoQuality = m[1] + 'p';
        }
        const cobaltResult = await downloadViaCobalt(resolvedTikTokUrl, taskId, {
          onProgress: (percent, msg) => {
            store.update(taskId, {
              status: percent < 90 ? TASK_STATUS.DOWNLOADING : TASK_STATUS.PROCESSING,
              progress: percent
            });
          },
          options: { videoQuality, filenameStyle: 'basic', downloadMode: 'auto' }
        });
        if (cobaltResult && !cobaltResult.isPicker) {
          // Cobalt 不返回标题/时长，通过 yt-dlp --dump-json 补全
          let metaTitle = 'TikTok Video';
          let metaDuration = 0;
          let metaThumb = '';
          try {
            const ytdlp = require('../services/yt-dlp');
            const info = await ytdlp.getInfo(url);
            if (info?.title) metaTitle = info.title;
            if (info?.duration) metaDuration = Math.round(info.duration);
            if (info?.thumbnail) metaThumb = info.thumbnail;
            logger.info(`[task] ${taskId} TikTok metadata from yt-dlp: title="${metaTitle.substring(0,40)}...", dur=${metaDuration}s`);
          } catch (e) {
            logger.warn(`[task] ${taskId} TikTok metadata fetch failed: ${e.message}`);
          }
          update = {
            status: TASK_STATUS.COMPLETED,
            progress: 100,
            title: cobaltResult.title || metaTitle,
            duration: cobaltResult.duration || metaDuration,
            thumbnailUrl: cobaltResult.thumbnailUrl || metaThumb,
            downloadUrl: cobaltResult.downloadUrl,
            filePath: cobaltResult.filePath,
            ext: cobaltResult.ext || 'mp4',
            width: cobaltResult.width || 0,
            height: cobaltResult.height || 0,
            quality: cobaltResult.quality || 'hd',
            copyText: cobaltResult.title || metaTitle || ''
          };
          fileRefManager.addRef(`${taskId}.${cobaltResult.ext || 'mp4'}`);
          usedCobalt = true;

          // 处理纯音频提取（Cobalt 路径）
          const wantsAudioOnly = options.includes('audio') && !options.includes('video');
          if (wantsAudioOnly && update.filePath) {
            try {
              const audioPath = path.join(__dirname, '../../downloads', taskId + '.mp3');
              const { spawn } = require('child_process');
              await new Promise((resolve, reject) => {
                const ff = spawn('ffmpeg', ['-i', update.filePath, '-vn', '-acodec', 'libmp3lame', '-b:a', '128k', '-y', audioPath]);
                const timer = setTimeout(() => { ff.kill('SIGKILL'); reject(new Error('timeout')); }, TIMEOUT.FFMPEG);
                ff.on('close', code => { clearTimeout(timer); code === 0 ? resolve() : reject(new Error('ffmpeg exit ' + code)); });
                ff.on('error', err => { clearTimeout(timer); reject(err); });
              });
              update.downloadUrl = '/download/' + taskId + '.mp3';
              update.filePath = audioPath;
              update.ext = 'mp3';
              update.audioUrl = '/download/' + taskId + '.mp3';
              fileRefManager.addRef(taskId + '.mp3');
              await asyncFs.safeUnlink(cobaltResult.filePath);
            } catch (e) {
              logger.error('[tiktok cobalt audio] extract failed:', e.message);
            }
          }

          logger.info(`[task] ${taskId} TikTok Cobalt succeeded`);
        }
      } catch (e) {
        logger.warn(`[task] ${taskId} TikTok Cobalt failed: ${e.message}`);
      }
    }

    // Step 2: TikHub API (Cobalt 失败时)
    if (!usedCobalt) {
    try {

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
    let data;
    try {
      data = await tikhubRequest(
        '/api/v1/tiktok/app/v3/fetch_one_video?aweme_id=' + videoId,
        API_KEY_DOUYIN
      );
    } catch (e) {
      throw new Error(`TikTok 解析失败：${e.message}`);
    }

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

    update = {
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

    } catch (tikhubErr) {
      logger.warn(`[task] ${taskId} TikTok TikHub failed: ${tikhubErr.message}, trying yt-dlp...`);
      try {
        const ytdlp = require('../services/yt-dlp');
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
        update = {
          status: TASK_STATUS.COMPLETED,
          progress: 100,
          title: ytdlpResult.title || 'TikTok Video',
          duration: ytdlpResult.duration || 0,
          thumbnailUrl: ytdlpResult.thumbnailUrl || '',
          downloadUrl: ytdlpResult.downloadUrl || `/download/${taskId}.${ytdlpResult.ext || 'mp4'}`,
          filePath: ytdlpResult.filePath,
          ext: ytdlpResult.ext || 'mp4',
          copyText: ytdlpResult.title || ''
        };
        fileRefManager.addRef(`${taskId}.${ytdlpResult.ext || 'mp4'}`);
        usedYtdlp = true;
        logger.info(`[task] ${taskId} TikTok yt-dlp succeeded`);
      } catch (ytdlpErr) {
        throw new Error(`TikTok 解析失败: Cobalt → TikHub(${tikhubErr.message}) → yt-dlp(${ytdlpErr.message})`);
      }
    }

    } // if (!usedCobalt)

    store.update(taskId, update);

    // ASR 语音转文字
    if (needAsr && update.filePath) {
      const asrResult = await handleAsr(taskId, update.filePath, 'zh');
      if (asrResult?.text) { const upd = { status: TASK_STATUS.COMPLETED, asrText: asrResult.text, asrTxtUrl: asrResult.txtUrl }; if (asrResult.rawText && asrResult.rawText !== asrResult.text) upd.asrRawText = asrResult.rawText; if (asrResult.summary) upd.summaryText = asrResult.summary; if (asrResult.translatedText) { upd.translatedText = asrResult.translatedText; upd.translatedTxtUrl = asrResult.translatedTxtUrl; } if (asrResult.subbedVideoUrl) upd.subbedVideoUrl = asrResult.subbedVideoUrl; store.update(taskId, upd); }
    }

    await finalizeTask(taskId);
    logger.info(`[task] ${taskId} tiktok completed (${usedCobalt ? 'cobalt' : (usedYtdlp ? 'yt-dlp' : 'tikhub')})`);
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
/**
 * 处理 Bilibili 下载 (TikHub API)
 */
async function processBilibili(taskId, url, needAsr, options = ['video'], quality) {
  if (!taskLock.tryAcquire(taskId)) {
    logger.warn(`[task] ${taskId} is already being processed`);
    store.update(taskId, { status: TASK_STATUS.ERROR, error: 'Task is already in progress' });
    return;
  }

  try {
    const { parseBilibili } = require('../services/tikhub');
    store.update(taskId, { status: TASK_STATUS.PARSING, progress: 5 });

    const result = await parseBilibili(url, taskId, (percent) => {
      store.update(taskId, {
        status: percent < 20 ? TASK_STATUS.PARSING : TASK_STATUS.DOWNLOADING,
        progress: percent
      });
    }, quality);

    const update = {
      status: TASK_STATUS.COMPLETED,
      width: result.width,
      height: result.height,
      quality: result.quality,
      progress: 100,
      title: result.title,
      thumbnailUrl: result.thumbnailUrl,
    };

    if (result.clientDownload) {
      // B站 CDN 被封锁，传 URL 给前端客户端下载
      update.clientDownload = result.clientDownload;
    } else if (result.filePath) {
      update.filePath = result.filePath;
      update.ext = result.ext;
      update.downloadUrl = `/download/${path.basename(result.filePath)}`;
      fileRefManager.addRef(path.basename(result.filePath));
    }

    store.update(taskId, update);

    // ASR
    if (needAsr && update.filePath) {
      const asrResult = await handleAsr(taskId, update.filePath, 'zh');
      if (asrResult?.text) { const upd = { status: TASK_STATUS.COMPLETED, asrText: asrResult.text, asrTxtUrl: asrResult.txtUrl }; if (asrResult.rawText && asrResult.rawText !== asrResult.text) upd.asrRawText = asrResult.rawText; if (asrResult.summary) upd.summaryText = asrResult.summary; if (asrResult.translatedText) { upd.translatedText = asrResult.translatedText; upd.translatedTxtUrl = asrResult.translatedTxtUrl; } if (asrResult.subbedVideoUrl) upd.subbedVideoUrl = asrResult.subbedVideoUrl; store.update(taskId, upd); }
    }

    await finalizeTask(taskId);
    logger.info(`[task] ${taskId} bilibili completed`);
  } catch (error) {
    // TikHub CDN 可能被 B站封锁(403)，回退到 Cobalt
    logger.error(`[task] ${taskId} bilibili TikHub failed: ${error.message}, trying cobalt fallback...`);
    try {
      const { downloadViaCobalt, isCobaltConfigured } = require('../services/cobalt');
      if (isCobaltConfigured()) {
        store.update(taskId, { status: TASK_STATUS.PARSING, progress: 5 });
        const cobaltResult = await downloadViaCobalt(url, taskId, {
          onProgress: (p) => store.update(taskId, { status: p < 90 ? TASK_STATUS.DOWNLOADING : TASK_STATUS.PROCESSING, progress: p })
        });
        if (cobaltResult) {
          const update = {
            status: TASK_STATUS.COMPLETED,
            width: cobaltResult.width || 0,
            height: cobaltResult.height || 0,
            quality: cobaltResult.quality || null,
            progress: 100,
            title: cobaltResult.title || 'Bilibili Video',
            thumbnailUrl: cobaltResult.thumbnailUrl || '',
          };
          if (cobaltResult.filePath) {
            update.filePath = cobaltResult.filePath;
            update.ext = path.extname(cobaltResult.filePath).replace('.', '') || 'mp4';
            update.downloadUrl = `/download/${path.basename(cobaltResult.filePath)}`;
            fileRefManager.addRef(path.basename(cobaltResult.filePath));
          }
          store.update(taskId, update);
          if (needAsr && update.filePath) {
            const asrResult = await handleAsr(taskId, update.filePath, 'zh');
            if (asrResult?.text) { const upd = { status: TASK_STATUS.COMPLETED, asrText: asrResult.text, asrTxtUrl: asrResult.txtUrl }; if (asrResult.rawText && asrResult.rawText !== asrResult.text) upd.asrRawText = asrResult.rawText; if (asrResult.summary) upd.summaryText = asrResult.summary; if (asrResult.translatedText) { upd.translatedText = asrResult.translatedText; upd.translatedTxtUrl = asrResult.translatedTxtUrl; } if (asrResult.subbedVideoUrl) upd.subbedVideoUrl = asrResult.subbedVideoUrl; store.update(taskId, upd); }
          }
          await finalizeTask(taskId);
          logger.info(`[task] ${taskId} bilibili completed via cobalt fallback`);
          return;
        }
      }
    } catch (cobaltErr) {
      logger.error(`[task] ${taskId} bilibili cobalt fallback also failed:`, cobaltErr.message);
    }
    store.update(taskId, { status: TASK_STATUS.ERROR, error: error.message });
  } finally {
    taskLock.release(taskId);
  }
}

async function processXiaohongshu(taskId, url, needAsr, options = ['video'], quality) {
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
    }, quality);

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

    // ASR 语音转文字
    if (needAsr && update.filePath) {
      const asrResult = await handleAsr(taskId, update.filePath, 'zh');
      if (asrResult?.text) {
        const upd = { status: TASK_STATUS.COMPLETED, asrText: asrResult.text, asrTxtUrl: asrResult.txtUrl };
        if (asrResult.rawText && asrResult.rawText !== asrResult.text) upd.asrRawText = asrResult.rawText;
        if (asrResult.summary) upd.summaryText = asrResult.summary;
        if (asrResult.translatedText) {
          upd.translatedText = asrResult.translatedText;
          upd.translatedTxtUrl = asrResult.translatedTxtUrl;
        }
        store.update(taskId, upd);
      }
    }

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
async function processInstagram(taskId, url, needAsr, options = ['video'], quality = null) {
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
        // 解析画质参数
        let videoQuality = 'max';
        if (quality && quality.includes('height<=')) {
          const m = quality.match(/height<=(\d+)/);
          if (m) videoQuality = m[1] + 'p';
        }
        logger.info(`[task] ${taskId} instagram trying cobalt first... (quality: ${videoQuality})`);
        cobaltResult = await downloadViaCobalt(url, taskId, {
          onProgress: (percent) => store.update(taskId, {
            status: percent < 90 ? TASK_STATUS.DOWNLOADING : TASK_STATUS.PROCESSING,
            progress: percent
          }),
          options: {
            videoQuality,
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
          title: cobaltResult.title || 'Instagram Video',
          quality: cobaltResult.cobaltFilename || 'max',
          progress: 100,
          downloadUrl: cobaltResult.downloadUrl,
          filePath: cobaltResult.filePath,
          ext: cobaltResult.ext
        };
        fileRefManager.addRef(`${taskId}.${cobaltResult.ext}`);
        store.update(taskId, update);

        // 处理 ASR（Cobalt 成功后）
        if (needAsr && cobaltResult.filePath) {
          const asrResult = await handleAsr(taskId, cobaltResult.filePath, 'zh');
          if (asrResult?.text) {
            const upd = { status: TASK_STATUS.COMPLETED, asrText: asrResult.text, asrTxtUrl: asrResult.txtUrl };
            if (asrResult.rawText && asrResult.rawText !== asrResult.text) upd.asrRawText = asrResult.rawText;
            if (asrResult.summary) upd.summaryText = asrResult.summary;
            if (asrResult.translatedText) {
              upd.translatedText = asrResult.translatedText;
              upd.translatedTxtUrl = asrResult.translatedTxtUrl;
            }
            store.update(taskId, upd);
          }
        }
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
  if (!canAccessTask(req, task)) {
    return res.status(403).json({ code: 403, message: '无权访问此任务' });
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
    data: signTaskResponse({
      taskId: task.taskId,
      url: task.url,
      status: task.status,
      progress: task.progress || 0,
      needAsr: task.needAsr,
      options: task.options || [],
      title: task.title,
      duration: task.duration,
      platform: task.platform,
      speed: task.speed,
      eta: task.eta,
      thumbnailUrl: task.thumbnailUrl,
      downloadUrl: task.downloadUrl,
      subtitleFiles: task.subtitleFiles || [],
      asrText: task.asrText,
      summaryText: task.summaryText,
      asrTxtUrl: task.asrTxtUrl,
      translatedText: task.translatedText,
      translatedTxtUrl: task.translatedTxtUrl,
      subbedVideoUrl: task.subbedVideoUrl,
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
    })
  });
}

/**
 * 获取历史记录
 */
async function getHistory(req, res) {
  const { limit = 50, offset = 0, page, pageSize, search, status, platform, group, tag, favorite, aiOnly, publishPackOnly, needsPublishPack } = req.query;

  const isGuest = !req.user;
  const userId = req.user ? req.user.id : null;
  const guestIp = isGuest ? (getClientIp(req)) : null;

  // 有筛选条件时使用服务端分页
  const hasFilters = search || platform || group || tag || favorite || aiOnly || publishPackOnly || needsPublishPack || page;
  if (hasFilters) {
    try {
      const userDb = require('../userDb');
      const result = await userDb.getHistoryPage(userId, guestIp, {
        page: parseInt(page) || 1,
        pageSize: parseInt(pageSize) || parseInt(limit) || 50,
        search, status, platform, group, tag,
        favorite: favorite === '1' || favorite === 'true',
        aiOnly: aiOnly === '1' || aiOnly === 'true',
        publishPackOnly: publishPackOnly === '1' || publishPackOnly === 'true',
        needsPublishPack: needsPublishPack === '1' || needsPublishPack === 'true',
      });
      const items = (result.items || []).map(h => signTaskResponse({
        taskId: h.task_id,
        url: h.url,
        platform: h.platform,
        title: h.title,
        thumbnailUrl: h.thumbnail_url,
        duration: h.duration,
        isFavorite: h.is_favorite === 1,
        tags: safeJsonArray(h.tags),
        notes: h.notes || '',
        groupName: h.group_name || '',
        aiAnalysis: safeJsonObject(h.ai_analysis),
        createdAt: h.created_at * 1000,
        status: 'completed',
        fromDb: true,
      }));
      return res.json({ code: 0, data: { tasks: items, total: result.total, page: result.page, pageSize: result.pageSize, hasMore: result.hasMore } });
    } catch (e) {
      logger.error('[history] Server-side pagination failed:', e.message);
      // 失败回退到原有逻辑
    }
  }

  // 原有逻辑：内存 + DB 合并
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
        isFavorite: h.is_favorite === 1,
        tags: safeJsonArray(h.tags),
        notes: h.notes || '',
        groupName: h.group_name || '',
        aiAnalysis: safeJsonObject(h.ai_analysis),
        status: 'completed',
        createdAt: h.created_at * 1000,
        fromDb: true
      });
    }
  }

  // 按时间倒序
  allTasks.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));

  const tasks = allTasks
    .slice(parseInt(offset), parseInt(offset) + parseInt(limit))
    .map(task => signTaskResponse(task));

  res.json({
    code: 0,
    data: {
      tasks,
      total: allTasks.length
    }
  });
}

function safeJsonArray(value) {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/**
 * 素材工作台服务端聚合统计
 */
async function getHistoryMeta(req, res) {
  const isGuest = !req.user;
  const userId = req.user ? req.user.id : null;
  const guestIp = isGuest ? getClientIp(req) : null;

  try {
    const userDb = require('../userDb');
    const meta = await userDb.getHistoryMeta(userId, guestIp);
    res.json({ code: 0, data: meta });
  } catch (e) {
    logger.error('[history-meta] Failed:', e.message);
    res.json({ code: 500, message: 'Failed to load history meta' });
  }
}

function safeJsonObject(value) {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

function safeExportName(value, fallback = 'material') {
  return String(value || fallback)
    .replace(/[\\/:*?"<>|]+/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[. ]+$/g, '')
    .slice(0, 80) || fallback;
}

function csvCell(value) {
  return `"${String(value ?? '').replace(/\r?\n/g, ' / ').replace(/"/g, '""')}"`;
}

function formatAnalysisMarkdown(title, analysis) {
  if (!analysis) return '';
  const list = value => Array.isArray(value) ? value : (value ? [value] : []);
  const packs = analysis.rewritePacks && typeof analysis.rewritePacks === 'object'
    ? Object.values(analysis.rewritePacks)
    : [];
  return [
    `# ${title}`,
    '',
    `## AI Material Card`,
    `- Product: ${analysis.productName || ''}`,
    ...list(analysis.openingHook).map(item => `- Hook: ${item}`),
    ...list(analysis.sellingPoints).map(item => `- Selling point: ${item}`),
    ...list(analysis.painPoints).map(item => `- Pain point: ${item}`),
    ...list(analysis.copyScript).map(item => `- Script: ${item}`),
    '',
    `## Publish Packs`,
    ...packs.map(pack => `- ${pack.platform || ''} / ${pack.style || ''}: ${pack.title || ''} | ${pack.caption || ''} | ${(pack.hashtags || []).map(tag => `#${tag}`).join(' ')}`)
  ].join('\n');
}

async function exportHistoryPackage(req, res) {
  try {
    const userDb = require('../userDb');
    const JSZip = require('jszip');
    const taskIds = Array.from(new Set((req.body?.taskIds || []).map(id => String(id || '').trim()).filter(Boolean))).slice(0, userDb.isVip(req.user) ? 100 : 5);
    if (taskIds.length === 0) return res.status(400).json({ code: 400, message: '请选择要导出的素材' });

    const zip = new JSZip();
    const rows = [['task_id', 'title', 'platform', 'group', 'tags', 'source_url', 'has_ai_card', 'publish_pack_count']];
    let addedFiles = 0;
    for (const taskId of taskIds) {
      const history = await userDb.getHistoryItem(req.user.id, null, taskId);
      const task = store.get(taskId);
      if (!history && !task) continue;
      const title = history?.title || task?.title || taskId;
      const folderName = safeExportName(`${history?.platform || task?.platform || 'auto'}_${title}`, taskId);
      const tags = safeJsonArray(history?.tags || task?.tags);
      const analysis = safeJsonObject(history?.ai_analysis) || task?.copywriteAnalysis || task?.aiAnalysis || null;
      const packCount = analysis?.rewritePacks && typeof analysis.rewritePacks === 'object' ? Object.keys(analysis.rewritePacks).length : 0;
      rows.push([taskId, title, history?.platform || task?.platform || '', history?.group_name || task?.groupName || '', tags.join(' #'), history?.url || task?.url || '', analysis ? 'Y' : '', packCount]);

      const markdown = formatAnalysisMarkdown(title, analysis);
      if (markdown) zip.file(`${folderName}/ai-analysis.md`, markdown);

      const mediaPath = task?.filePath && fs.existsSync(task.filePath) ? task.filePath : null;
      if (mediaPath) {
        const ext = path.extname(mediaPath) || '.mp4';
        zip.file(`${folderName}/${safeExportName(title, taskId)}${ext}`, fs.readFileSync(mediaPath));
        addedFiles += 1;
      }
    }
    zip.file('materials.csv', rows.map(row => row.map(csvCell).join(',')).join('\n'));
    zip.file('README.txt', `Orange material export\nItems: ${rows.length - 1}\nMedia files included: ${addedFiles}\nGenerated: ${new Date().toISOString()}\n`);
    const buffer = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="orange-materials-${Date.now()}.zip"`);
    return res.send(buffer);
  } catch (e) {
    logger.error('[history-export] package failed:', e.message);
    return res.status(500).json({ code: 500, message: '素材导出包生成失败' });
  }
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
  const userId = req.user?.id || null;
  const guestIp = userId ? null : getClientIp(req);

  if (task && !canAccessTask(req, task)) {
    return res.json({ code: 403, message: '无权删除此任务' });
  }

  // 从数据库历史中删除，仅删除当前用户/游客自己的记录
  try {
    const userDb = require('../userDb');
    if (userId) {
      await userDb.db.execute({
        sql: 'DELETE FROM download_history WHERE task_id = ? AND user_id = ?',
        args: [taskId, userId]
      });
    } else {
      await userDb.db.execute({
        sql: 'DELETE FROM download_history WHERE task_id = ? AND guest_ip = ?',
        args: [taskId, guestIp]
      });
    }
  } catch (e) {
    logger.warn('[deleteTask] DB delete failed:', e.message);
  }

  // 如果内存中还存在，也清理文件
  if (task) {
    await store.removeWithFiles(taskId);
  }

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
async function clearHistory(req, res) {
  const userId = req.user?.id;
  const userDb = require('../userDb');
  
  if (userId) {
    const count = await store.removeByUserId(userId);
    // 同时清除数据库历史
    await userDb.clearHistory(userId, null).catch(() => {});
    res.json({ code: 0, message: `已清除 ${count} 条记录` });
  } else {
    // 游客：只清除当前 IP 关联的游客任务
    const guestIp = getClientIp(req);
    const tasks = store.list().filter(t => !t.userId && t.guestIp === guestIp);
    let count = 0;
    for (const t of tasks) {
      await store.removeWithFiles(t.taskId);
      count++;
    }
    // 同时清除数据库中该游客的历史
    await userDb.clearHistory(null, guestIp).catch(() => {});
    res.json({ code: 0, message: `已清除 ${count} 条记录` });
  }
}

async function updateHistoryItem(req, res) {
  const { taskId } = req.params;
  const { isFavorite, tags, notes, groupName } = req.body || {};
  const task = store.get(taskId);
  if (task && !canAccessTask(req, task)) {
    return res.status(403).json({ code: 403, message: '无权修改此素材' });
  }

  try {
    const userDb = require('../userDb');
    const userId = req.user?.id || null;
    const guestIp = userId ? null : getClientIp(req);
    await userDb.updateHistoryMeta({ userId, guestIp, taskId, isFavorite, tags, notes, groupName });
    if (task) {
      const updates = {};
      if (typeof isFavorite === 'boolean') updates.isFavorite = isFavorite;
      if (Array.isArray(tags)) updates.tags = tags.slice(0, 20);
      if (typeof notes === 'string') updates.notes = notes.slice(0, 2000);
      if (typeof groupName === 'string') updates.groupName = groupName.trim().slice(0, 80);
      store.update(taskId, updates);
    }
    return res.json({ code: 0, data: { taskId, isFavorite, tags, notes, groupName } });
  } catch (e) {
    logger.error('[history] update meta failed:', e.message);
    return res.status(500).json({ code: 500, message: '素材更新失败' });
  }
}

async function extractCopywriteForTask(req, res) {
  const { taskId, outputLanguage = null, industry = 'general' } = req.body || {};
  if (!taskId) return res.json({ code: 400, message: '缺少 taskId' });

  try {
    const userDb = require('../userDb');
    if (req.user.email_verified !== 1) {
      return res.status(403).json({ code: 403, message: '请先验证邮箱' });
    }
    if (!userDb.isVip(req.user) && !userDb.isBasic(req.user)) {
      return res.status(403).json({ code: 403, message: 'AI 文案提取为 Basic/Pro 会员功能' });
    }
    const result = await generateCommerceCardForTask(taskId, req.user, outputLanguage, industry);
    return res.json({ code: 0, data: result });
  } catch (e) {
    logger.error(`[copywrite] ${taskId} failed:`, e.message);
    return res.status(e.statusCode || 500).json({ code: e.statusCode || 500, message: e.message || 'AI 文案提取失败', data: e.data });
  }
}

async function rewriteCopywriteForTask(req, res) {
  const { taskId, platform = 'tiktok', style = 'seed', outputLanguage = null } = req.body || {};
  if (!taskId) return res.json({ code: 400, message: '缺少 taskId' });

  try {
    const userDb = require('../userDb');
    if (req.user.email_verified !== 1) {
      return res.status(403).json({ code: 403, message: '请先验证邮箱' });
    }
    if (!userDb.isVip(req.user)) {
      return res.status(403).json({ code: 403, message: '平台发布文案包为 Pro 会员功能' });
    }

    const { pack, analysis: nextAnalysis } = await generateRewritePackForTask(taskId, req.user, platform, style, outputLanguage);

    return res.json({ code: 0, data: { pack, analysis: nextAnalysis } });
  } catch (e) {
    logger.error(`[copywrite-rewrite] ${taskId} failed:`, e.message);
    return res.status(e.statusCode || 500).json({ code: e.statusCode || 500, message: e.message || '平台发布文案包生成失败' });
  }
}

async function getTaskForHistoryOwner(taskId, user) {
  const userDb = require('../userDb');
  let task = store.get(taskId);
  if (!task) {
    const historyItem = await userDb.getHistoryItem(user.id, null, taskId);
    if (!historyItem) {
      const err = new Error('任务不存在或文件已过期');
      err.statusCode = 404;
      throw err;
    }
    task = store.save({
      taskId,
      userId: user.id,
      url: historyItem.url,
      platform: historyItem.platform,
      title: historyItem.title,
      thumbnailUrl: historyItem.thumbnail_url,
      duration: historyItem.duration,
      status: TASK_STATUS.COMPLETED,
      progress: 100,
      tags: safeJsonArray(historyItem.tags),
      notes: historyItem.notes || '',
      groupName: historyItem.group_name || '',
      copywriteAnalysis: safeJsonObject(historyItem.ai_analysis),
      historySaved: true,
      createdAt: Number(historyItem.created_at || Math.floor(Date.now() / 1000)) * 1000
    });
  } else if (task.userId !== user.id) {
    const err = new Error('无权访问此任务');
    err.statusCode = 403;
    throw err;
  }
  return task;
}

async function generateRewritePackForTask(taskId, user, platform = 'tiktok', style = 'seed', outputLanguage = null) {
  const userDb = require('../userDb');
  const task = await getTaskForHistoryOwner(taskId, user);
  const analysis = task.copywriteAnalysis || task.aiAnalysis;
  if (!analysis) {
    const err = new Error('请先生成 AI 素材卡');
    err.statusCode = 400;
    throw err;
  }

  await getCopywriteUsageOrBlock(user, taskId);
  const { rewriteCommerceCard } = require('../services/ai-copywrite');
  const pack = await rewriteCommerceCard(analysis, platform, style, outputLanguage || task.outputLanguage || 'zh');
  const rewritePacks = {
    ...(analysis.rewritePacks || {}),
    [`${platform}:${style}`]: pack
  };
  const nextAnalysis = { ...analysis, rewritePacks };

  store.update(taskId, { copywriteAnalysis: nextAnalysis });
  await userDb.updateHistoryMeta({ userId: user.id, taskId, aiAnalysis: nextAnalysis });
  await userDb.recordAiUsage({
    userId: user.id,
    taskId,
    feature: 'copywrite',
    inputChars: JSON.stringify(analysis).length,
    outputItems: Array.isArray(pack.hashtags) ? pack.hashtags.length : 0
  });
  return { pack, analysis: nextAnalysis };
}

const WORKFLOW_REWRITE_PLATFORMS = ['tiktok', 'douyin', 'xiaohongshu', 'youtube_shorts'];
const WORKFLOW_REWRITE_STYLES = ['seed', 'review', 'promo', 'problem', 'live'];

async function runMaterialWorkflow(jobId, userId) {
  const userDb = require('../userDb');
  const job = await userDb.getBatchJob(jobId, userId);
  if (!job) return;
  const user = await userDb.getById(userId);
  if (!user) {
    await userDb.updateBatchJob(jobId, { status: 'failed', error: '用户不存在' });
    return;
  }

  await userDb.updateBatchJob(jobId, { status: 'running' });
  let done = 0;
  let success = 0;
  let failed = 0;
  const options = job.options || {};
  const outputLanguage = options.outputLanguage || 'zh';
  const industry = options.industry || 'general';
  const makeCards = options.makeCards !== false;
  const makePacks = !!options.makePacks;
  const platforms = Array.isArray(options.platforms) && options.platforms.length ? options.platforms : WORKFLOW_REWRITE_PLATFORMS;
  const styles = Array.isArray(options.styles) && options.styles.length ? options.styles : ['seed'];

  for (const item of job.items || []) {
    const taskId = item.task_id;
    try {
      await userDb.updateBatchJobItem(jobId, taskId, { status: 'running', step: 'ai_card' });
      let cardResult = null;
      if (makeCards) {
        cardResult = await generateCommerceCardForTask(taskId, user, outputLanguage, industry);
      }
      if (makePacks) {
        await userDb.updateBatchJobItem(jobId, taskId, { status: 'running', step: 'publish_packs' });
        for (const platform of platforms) {
          for (const style of styles) {
            await generateRewritePackForTask(taskId, user, platform, style, outputLanguage);
          }
        }
      }
      success += 1;
      await userDb.updateBatchJobItem(jobId, taskId, {
        status: 'completed',
        step: 'done',
        result: { hasCard: !!cardResult, packs: makePacks ? platforms.length * styles.length : 0 }
      });
    } catch (error) {
      failed += 1;
      await userDb.updateBatchJobItem(jobId, taskId, {
        status: 'failed',
        step: 'error',
        error: error.message || '处理失败'
      });
      logger.warn(`[workflow] ${jobId} item ${taskId} failed: ${error.message}`);
    } finally {
      done += 1;
      await userDb.updateBatchJob(jobId, {
        done,
        success,
        failed,
        status: done >= job.total ? (failed > 0 ? 'partial_failed' : 'completed') : 'running'
      });
    }
  }
}

async function createMaterialWorkflow(req, res) {
  try {
    const userDb = require('../userDb');
    if (req.user.email_verified !== 1) {
      return res.status(403).json({ code: 403, message: '请先验证邮箱' });
    }
    if (!userDb.isVip(req.user)) {
      return res.status(403).json({ code: 403, message: '批量 AI 工作流为 Pro 会员功能' });
    }
    const taskIds = Array.from(new Set((req.body?.taskIds || []).map(id => String(id || '').trim()).filter(Boolean))).slice(0, 50);
    if (taskIds.length === 0) return res.status(400).json({ code: 400, message: '请选择要处理的素材' });

    const jobId = uuidv4();
    const options = {
      makeCards: req.body?.makeCards !== false,
      makePacks: !!req.body?.makePacks,
      platforms: Array.isArray(req.body?.platforms) ? req.body.platforms : [],
      styles: Array.isArray(req.body?.styles) ? req.body.styles : [],
      outputLanguage: req.body?.outputLanguage || 'zh',
      industry: req.body?.industry || 'general'
    };
    await userDb.createBatchJob({ id: jobId, userId: req.user.id, type: 'material_workflow', total: taskIds.length, options });
    await userDb.addBatchJobItems(jobId, taskIds);
    setImmediate(() => runMaterialWorkflow(jobId, req.user.id).catch(error => {
      logger.error(`[workflow] ${jobId} failed:`, error);
      userDb.updateBatchJob(jobId, { status: 'failed', error: error.message }).catch(() => {});
    }));
    return res.json({ code: 0, data: { jobId, status: 'queued', total: taskIds.length } });
  } catch (e) {
    logger.error('[workflow] create failed:', e.message);
    return res.status(500).json({ code: 500, message: '创建批量 AI 工作流失败' });
  }
}

async function getMaterialWorkflow(req, res) {
  try {
    const userDb = require('../userDb');
    const job = await userDb.getBatchJob(req.params.jobId, req.user.id);
    if (!job) return res.status(404).json({ code: 404, message: '批量任务不存在' });
    return res.json({ code: 0, data: job });
  } catch (e) {
    logger.error('[workflow] get failed:', e.message);
    return res.status(500).json({ code: 500, message: '批量任务查询失败' });
  }
}

async function listMaterialWorkflows(req, res) {
  try {
    const userDb = require('../userDb');
    const jobs = await userDb.listBatchJobs(req.user.id, 'material_workflow', Number(req.query.limit) || 20);
    return res.json({ code: 0, data: { jobs } });
  } catch (e) {
    logger.error('[workflow] list failed:', e.message);
    return res.status(500).json({ code: 500, message: '批量任务列表查询失败' });
  }
}

async function getAiUsageStatus(req, res) {
  try {
    const userDb = require('../userDb');
    const periodStart = monthStartUnix();
    const monthlyLimit = getAiCopywriteMonthlyLimit(req.user);
    const rows = await userDb.getAiUsage(req.user.id, periodStart);
    const copywrite = summarizeAiUsage(rows, 'copywrite', monthlyLimit);
    return res.json({
      code: 0,
      data: {
        period: 'month',
        periodStart,
        copywrite,
        retention: retentionSummaryForUser(req.user)
      }
    });
  } catch (e) {
    logger.error('[ai-usage] failed:', e.message);
    return res.status(500).json({ code: 500, message: 'AI 用量查询失败' });
  }
}

async function getAsrLexicon(req, res) {
  try {
    const userDb = require('../userDb');
    const language = String(req.query.language || 'auto').slice(0, 16);
    const rows = await userDb.getAsrLexicon(req.user.id, language);
    return res.json({
      code: 0,
      data: {
        language,
        terms: rows.map(row => row.term),
        items: rows
      }
    });
  } catch (e) {
    logger.error('[asr-lexicon] get failed:', e.message);
    return res.status(500).json({ code: 500, message: '词库读取失败' });
  }
}

async function updateAsrLexicon(req, res) {
  try {
    const userDb = require('../userDb');
    const language = String(req.body?.language || 'auto').slice(0, 16);
    const rawTerms = Array.isArray(req.body?.terms)
      ? req.body.terms
      : String(req.body?.terms || '').split(/[,，\n]/);
    const rows = await userDb.replaceAsrLexicon(req.user.id, rawTerms, language);
    return res.json({
      code: 0,
      data: {
        language,
        terms: rows.map(row => row.term),
        items: rows
      }
    });
  } catch (e) {
    logger.error('[asr-lexicon] update failed:', e.message);
    return res.status(500).json({ code: 500, message: '词库保存失败' });
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

    fileRefManager.addRef(path.basename(result.filePath));
    store.update(taskId, update);

    await finalizeTask(taskId);
    logger.info(`[task] ${taskId} wechat completed: ${result.width}x${result.height} ${result.quality}`);

  } catch (err) {
    logger.error(`[task] ${taskId} wechat error:`, err.message);
    store.update(taskId, { status: TASK_STATUS.ERROR, progress: 0, error: err.message });
  } finally {
    taskLock.release(taskId);
  }
}

// ========== 批量下载 ==========

const batchStore = new Map();

/**
 * POST /api/download/batch
 * 一次提交多个链接，后端顺序处理，前端可关闭页面
 */
async function createBatchDownload(req, res) {
  const { urls, quality = '', options = ['video'], needAsr = false, asrLanguage = 'zh', targetLang = null, outputLanguage = 'zh' } = req.body || {};

  if (!Array.isArray(urls) || urls.length === 0) {
    return res.json({ code: 400, message: '请提供至少一个链接' });
  }
  if (urls.length > 10) {
    return res.json({ code: 400, message: '单次最多 10 个链接' });
  }

  const userDb = require('../userDb');
  const isVip = req.user ? userDb.isVip(req.user) : false;
  if (!isVip) {
    return res.json({ code: 403, message: '批量下载仅限 Pro 会员使用' });
  }
  if (req.user && req.user.email_verified !== 1) {
    return res.json({ code: 403, message: '请先验证邮箱' });
  }

  const { v4: uuidv4 } = require('uuid');
  const batchId = uuidv4();
  const userId = req.user?.id || null;
  const guestIp = req.user ? null : getClientIp(req);
  const normalizedOptions = (Array.isArray(options) ? options : [options]).map(o => o === 'asr' || o === 'audio_only' ? 'audio' : o);
  const rawOptions = Array.isArray(options) ? options : [options];
  const wantsAsr = !!needAsr || rawOptions.some(o => ['asr', 'ai_summary', 'translate_subtitle', 'copywriting'].includes(o));
  if (rawOptions.some(o => ['ai_summary', 'translate_subtitle', 'copywriting'].includes(o)) && !isVip) {
    return res.json({ code: 403, message: 'AI 工具为 Pro 会员功能' });
  }
  const { extractUrl } = require('../utils/validator');
  const { isDouyinUrl } = require('../services/douyin');
  const { isXUrl } = require('../services/x-download');
  const { parseWechatExportId } = require('../services/tikhub');

  const tasks = urls.map(rawUrl => {
    const extracted = extractUrl(rawUrl) || rawUrl.trim();
    const taskId = uuidv4();
    const detectedPlatform = detectPlatform(extracted);

    const task = {
      taskId,
      url: extracted,
      platform: detectedPlatform || 'auto',
      needAsr: wantsAsr,
      targetLang,
      outputLanguage,
      options: normalizedOptions,
      saveTarget: 'phone',
      status: 'pending',
      progress: 0,
      createdAt: Date.now(),
      userId,
      guestIp,
    };
    store.save(task);
    return { taskId, url: extracted, status: 'pending', platform: detectedPlatform };
  });

  batchStore.set(batchId, { tasks, status: 'processing', progress: 0, userId });

  // 后台顺序处理
  processBatchQueue(batchId, tasks, { quality, options: normalizedOptions, needAsr: wantsAsr, asrLanguage, userId, guestIp, isDouyinUrl, isXUrl, parseWechatExportId });

  res.json({
    code: 0,
    data: { batchId, tasks: tasks.map(t => ({ taskId: t.taskId, url: t.url, status: t.status })) }
  });
}

async function processBatchQueue(batchId, tasks, opts) {
  const { quality, options, needAsr, asrLanguage, userId, guestIp, isDouyinUrl, isXUrl, parseWechatExportId } = opts;

  for (let i = 0; i < tasks.length; i++) {
    const t = tasks[i];
    t.status = 'processing';
    batchStore.set(batchId, { ...batchStore.get(batchId), progress: Math.round((i / tasks.length) * 100) });

    await new Promise((resolve) => {
      const done = () => resolve();

      if (isDouyinUrl(t.url)) {
        processDouyin(t.taskId, t.url, needAsr, options, quality, asrLanguage, quality, true).catch(err => {
          store.update(t.taskId, { status: 'error', error: err.message });
        }).finally(done);
      } else if (/tiktok\.com|tiktok\.cn/i.test(t.url)) {
        processTikTok(t.taskId, t.url, needAsr, options, quality).catch(err => {
          store.update(t.taskId, { status: 'error', error: err.message });
        }).finally(done);
      } else if (/youtube\.com|youtu\.be/i.test(t.url)) {
        processYouTube(t.taskId, t.url, needAsr, options, quality).catch(err => {
          store.update(t.taskId, { status: 'error', error: err.message });
        }).finally(done);
      } else if (/instagram\.com|instagr\.am/i.test(t.url)) {
        processInstagram(t.taskId, t.url, needAsr, options).catch(err => {
          store.update(t.taskId, { status: 'error', error: err.message });
        }).finally(done);
      } else if (isXUrl(t.url)) {
        processX(t.taskId, t.url, needAsr, options).catch(err => {
          store.update(t.taskId, { status: 'error', error: err.message });
        }).finally(done);
      } else if (/xiaohongshu\.com|xhslink\.com/i.test(t.url)) {
        processXiaohongshu(t.taskId, t.url, needAsr, options, quality).catch(err => {
          store.update(t.taskId, { status: 'error', error: err.message });
        }).finally(done);
      } else if (parseWechatExportId(t.url)) {
        processWechat(t.taskId, t.url, needAsr, options).catch(err => {
          store.update(t.taskId, { status: 'error', error: err.message });
        }).finally(done);
      } else if (/bilibili\.com|b23\.tv/i.test(t.url)) {
        processDownload(t.taskId, t.url, needAsr, options, quality).catch(err => {
          store.update(t.taskId, { status: 'error', error: err.message });
        }).finally(done);
      } else {
        processUnknownDownload(t.taskId, t.url, needAsr, options, quality).catch(err => {
          store.update(t.taskId, { status: 'error', error: err.message });
        }).finally(done);
      }
    });

    // 从 store 读取真实状态，避免失败任务被标为 completed
    const actualTask = store.get(t.taskId);
    t.status = actualTask?.status === 'completed' ? 'completed' : (actualTask?.status || 'error');
    logger.info(`[batch] ${batchId.substring(0,8)} task ${i+1}/${tasks.length} done: ${t.taskId} (status=${t.status})`);
  }

  batchStore.set(batchId, { ...batchStore.get(batchId), status: 'completed', progress: 100 });
  logger.info(`[batch] ${batchId.substring(0,8)} all tasks completed`);
}

async function getBatchStatus(req, res) {
  const { batchId } = req.params;
  const batch = batchStore.get(batchId);
  if (!batch) return res.json({ code: 404, message: '批量任务不存在' });
  if (!req.user?.id || batch.userId !== req.user.id) {
    return res.status(403).json({ code: 403, message: '无权访问此批量任务' });
  }

  const taskDetails = batch.tasks.map(t => {
    const detail = store.get(t.taskId);
    return signTaskResponse({
      taskId: t.taskId,
      url: t.url,
      status: detail?.status || t.status,
      title: detail?.title || '',
      downloadUrl: detail?.downloadUrl || '',
      error: detail?.error || '',
    });
  });

  res.json({ code: 0, data: { batchId, status: batch.status, progress: batch.progress, tasks: taskDetails } });
}

module.exports = {
  createDownload,
  createBatchDownload,
  getBatchStatus,
  getInfo,
  getStatus,
  getHistory,
  getHistoryMeta,
  exportHistoryPackage,
  getSystemStatus,
  getAdminStats,
  deleteTask,
  clearHistory,
  updateHistoryItem,
  extractCopywriteForTask,
  rewriteCopywriteForTask,
  createMaterialWorkflow,
  getMaterialWorkflow,
  listMaterialWorkflows,
  getAiUsageStatus,
  getAsrLexicon,
  updateAsrLexicon,
  adminClearAllHistory,
  detectPlatform
};
// force redeploy Tue Jun 9 2026 after GitHub Secrets fix

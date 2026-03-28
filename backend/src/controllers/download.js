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
const path = require('path');
const fs = require('fs');
const axios = require('axios');

/**
 * 创建下载任务
 */
async function createDownload(req, res) {
  try {
    const validation = validateInput(req.body);
    if (!validation.valid) {
      return res.json({ code: 400, message: validation.message });
    }

    let { url, platform, needAsr = false, options = ['video'], saveTarget = 'phone', quality = null } = req.body;

    // 从分享文本中提取 URL
    const { extractUrl } = require('../utils/validator');
    const extracted = extractUrl(url);
    if (extracted) url = extracted;

    // 平台自动识别
    const detectedPlatform = detectPlatform(url);
    const finalPlatform = platform || detectedPlatform || 'auto';

    // 兼容：前端 'audio' 选项
    const normalizedOptions = (Array.isArray(options) ? options : [options]).map(
      o => o === 'asr' ? 'audio' : o
    );

    const wantsAsr = needAsr;

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
      createdAt: Date.now()
    };

    store.save(task);

    // 抖音链接：走专用下载器（不依赖 yt-dlp）
    const { isDouyinUrl } = require('../services/douyin');
    if (isDouyinUrl(url)) {
      processDouyin(taskId, url, wantsAsr, normalizedOptions).catch(err => {
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

    // YouTube 链接：走 TikHub API（直接链接）
    if (/youtube\.com|youtu\.be/i.test(url)) {
      processYouTube(taskId, url, wantsAsr, normalizedOptions, quality).catch(err => {
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

    // Bilibili 链接：走 Bilibili API


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
    const wantsVideo = options.includes('video');
    const wantsCopywriting = options.includes('copywriting');
    const wantsCover = options.includes('cover');
    const wantsAudio = options.includes('audio');
    const wantsSubtitle = options.includes('subtitle');

    // 1. 解析阶段
    store.update(taskId, { status: 'parsing', progress: 5 });

    let result = null;

    // 2. 需要实际下载的情况
    if (wantsVideo || wantsCover || wantsSubtitle || wantsAudio || wantsCopywriting || needAsr) {
      store.update(taskId, { status: 'downloading', progress: 10 });

      const isYouTube = /youtube\.com|youtu\.be/i.test(url);

      result = await downloadWithLimit(async () => {
        try {
          return await executeWithRetry(async () => {
            return await ytdlp.download(url, taskId, (percent, speed, eta) => {
              store.update(taskId, {
                status: 'downloading',
                progress: percent,
                speed,
                eta
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
        progress: 100,
        title: result.title,
        duration: result.duration,
        thumbnailUrl: result.thumbnailUrl,
      };

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
        const text = await asr.transcribe(audioPath);

        store.update(taskId, {
          status: 'completed',
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
async function processDouyin(taskId, url, needAsr, options = ['video']) {
  try {
    const { downloadDouyin } = require('../services/douyin');

    store.update(taskId, { status: 'parsing', progress: 5 });

    const result = await downloadDouyin(url, taskId, (percent, msg) => {
      store.update(taskId, {
        status: percent < 30 ? 'parsing' : 'downloading',
        progress: percent
      });
    });

    const update = {
      status: 'completed',
      progress: 100,
      title: result.title,
      thumbnailUrl: result.thumbnailUrl,
    };

    if (result.isNote && result.images) {
      update.isNote = true;
      update.imageFiles = result.images;
    }
    if (result.downloadUrl) {
      update.filePath = result.filePath;
      update.ext = result.ext;
      update.downloadUrl = result.downloadUrl;
    }
    if (result.audioUrl) {
      update.audioUrl = result.audioUrl;
    }

    store.update(taskId, update);
    console.log(`[task] ${taskId} douyin completed (images=${result.images?.length || 0}, video=${!!result.downloadUrl})`);
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
    const update = {
      status: 'completed',
      progress: 100,
      title: result.title,
      thumbnailUrl: result.thumbnailUrl,
    };
    if (result.downloadUrl) {
      update.filePath = result.filePath;
      update.ext = result.ext;
      update.downloadUrl = result.downloadUrl;
    }
    if (result.images) {
      update.imageFiles = result.images;
    }
    store.update(taskId, update);
    console.log(`[task] ${taskId} x completed`);
  } catch (error) {
    console.error(`[task] ${taskId} x failed:`, error);
    store.update(taskId, { status: 'error', error: error.message });
  }
}

/**
 * 处理 YouTube 下载 (TikHub API)
 */
async function processYouTube(taskId, url, needAsr, options = ['video'], quality = null) {
  try {
    const axios = require('axios');
    store.update(taskId, { status: 'parsing', progress: 5 });
    
    // 获取视频 ID
    const videoIdMatch = url.match(/(?:v=|youtu\.be\/|shorts\/)([a-zA-Z0-9_-]{11})/);
    if (!videoIdMatch) throw new Error('Invalid YouTube URL');
    const videoId = videoIdMatch[1];
    
    // 从 TikHub 获取视频信息
    const API_KEY_YT = 'nbwMHtwa3GuiuW/CKoyvygj8CWGeerdC7CXatWGcWNXgoE6uOCecUg+uLw==';
    const { data } = await axios.get(
      `https://api.tikhub.io/api/v1/youtube/web/get_video_info?video_id=${videoId}`,
      { headers: { Authorization: `Bearer ${API_KEY_YT}` }, timeout: 30000 }
    );
    
    if (data.code !== 200) throw new Error('Failed to get video info');
    
    const videoData = data.data;
    const title = videoData.title || 'YouTube Video';
    const videos = videoData.videos?.items || [];
    
    // 找到最佳画质
    let bestVideo = null;
    for (const v of videos) {
      if (v.url && v.mimeType?.startsWith('video/')) {
        if (!bestVideo || (v.height || 0) > (bestVideo.height || 0)) {
          bestVideo = v;
        }
      }
    }
    
    if (!bestVideo || !bestVideo.url) {
      throw new Error('No download URL found');
    }
    
    // 返回直接下载链接（用户浏览器下载）
    store.update(taskId, {
      status: 'completed',
      progress: 100,
      title: title,
      thumbnailUrl: videoData.thumbnails?.[0]?.url || '',
      downloadUrl: bestVideo.url,
      directLink: true,
      quality: `${bestVideo.width}x${bestVideo.height}`,
      ext: bestVideo.extension || 'mp4'
    });
    
    console.log(`[task] ${taskId} youtube completed (direct link)`);
  } catch (error) {
    console.error(`[task] ${taskId} youtube failed:`, error);
    store.update(taskId, { status: 'error', error: error.message });
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
      createdAt: task.createdAt
    }
  });
}

/**
 * 获取历史记录
 */
function getHistory(req, res) {
  const { limit = 50, offset = 0 } = req.query;
  const allTasks = store.list();
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
function deleteTask(req, res) {
  const { taskId } = req.params;
  const task = store.get(taskId);

  if (!task) {
    return res.json({ code: 404, message: '任务不存在' });
  }

  store.removeWithFiles(taskId);

  res.json({ code: 0, message: '删除成功' });
}

function clearHistory(req, res) {
  const tasks = store.list();
  for (const task of tasks) {
    store.removeWithFiles(task.taskId);
  }
  res.json({ code: 0, message: '已清除所有记录' });
}

/**
 * 获取视频信息和可用画质
 */
async function getVideoInfo(req, res) {
  try {
    const { url } = req.body;
    if (!url) return res.status(400).json({ code: -1, message: 'URL required' });
    
    const platform = detectPlatform(url);
    
    if (platform === 'youtube') {
      const videoIdMatch = url.match(/(?:v=|youtu\.be\/|shorts\/)([a-zA-Z0-9_-]{11})/);
      if (!videoIdMatch) return res.status(400).json({ code: -1, message: 'Invalid YouTube URL' });
      
      const API_KEY_YT = 'lrwNPvEUzE2ph0K5Oces5Q/RNRHRZ5tTzTTogR7aU/mj1li7O0XfZgWPCQ==';
      const axios = require('axios');
      const { data } = await axios.get(
        `https://api.tikhub.io/api/v1/youtube/web/get_video_info?video_id=${videoIdMatch[1]}`,
        { headers: { Authorization: `Bearer ${API_KEY_YT}` }, timeout: 30000 }
      );
      
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

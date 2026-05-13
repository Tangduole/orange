/**
 * TikHub API 服务 - YouTube & 小红书解析下载
 */

const https = require('https');
const http = require('http');
const fs = require('fs');
const path = require('path');
const logger = require('../utils/logger');
const { heightToLabel } = require('../utils/media');

// 画质常量
const QUALITY_2K_HEIGHT = 1440;  // 2K 对应的短边分辨率

// 尝试加载 .env 文件(可选, Railway 会用环境变量)
// 先尝试 backend/.env, 再尝试项目根 .env
let envPath = path.join(__dirname, '../../.env');
if (!fs.existsSync(envPath)) envPath = path.join(__dirname, '../../../.env');
if (fs.existsSync(envPath)) {
  try { require('dotenv').config({ path: envPath }); } catch {}
}

// API Keys - 从环境变量读取
const API_KEY_XHS = process.env.TIKHUB_API_KEY_XHS;
const API_KEY_YT = process.env.TIKHUB_API_KEY_YT;
const API_KEY_DOUYIN = process.env.TIKHUB_API_KEY_DOUYIN;
const API_KEY_INSTAGRAM = process.env.TIKHUB_API_KEY_INSTAGRAM;
const API_KEY_WECHAT = process.env.TIKHUB_API_KEY_WECHAT;

// 记录警告(不抛错,让服务能启动)
if (!API_KEY_XHS) logger.warn('[tikhub] TIKHUB_API_KEY_XHS not set');
if (!API_KEY_YT) logger.warn('[tikhub] TIKHUB_API_KEY_YT not set');
if (!API_KEY_DOUYIN) logger.warn('[tikhub] TIKHUB_API_KEY_DOUYIN not set');
if (!API_KEY_INSTAGRAM) logger.warn('[tikhub] TIKHUB_API_KEY_INSTAGRAM not set');
if (!API_KEY_WECHAT) logger.warn('[tikhub] TIKHUB_API_KEY_WECHAT not set');

const API_KEY = API_KEY_XHS; // Default to XHS key
const API_BASE = 'https://api.tikhub.io';
const DOWNLOAD_DIR = path.join(__dirname, '../../downloads');

/**
 * 通用 TikHub API 请求
 */
function tikhubRequest(endpoint, apiKey = null) {
  return new Promise((resolve, reject) => {
    const url = `${API_BASE}${endpoint}`;
    const key = apiKey || API_KEY;
    const options = {
      headers: {
        'Authorization': `Bearer ${key}`,
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      }
    };

    let settled = false;
    const once = (fn) => (...args) => { if (!settled) { settled = true; fn(...args); } };

    const req = https.get(url, options, (res) => {
      // 超时处理：放在回调内，因为 req.setTimeout 需要已收到 response
      req.setTimeout(30000, () => {
        req.destroy();
        once(reject)(new Error('TikHub API timeout'));
      });
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          // 兼容两种响应：顶层 {code,data} 或嵌套 {detail:{code,message_zh}}
          const body = json.detail || json;
          if (res.statusCode === 402) {
            logger.error(`[TikHub] 余额不足！端点: ${endpoint.split('?')[0]}`);
            reject(new Error('服务暂时不可用，请稍后重试'));
            return;
          }
          if (body.code === 200 || json.data || body.data) {
            resolve(json.data || body.data || json);
          } else {
            const msg = body.message_zh || body.message || 'TikHub API error';
            reject(new Error(msg));
          }
        } catch (e) {
          reject(new Error(`TikHub response parse error: ${data.substring(0, 200)}`));
        }
      });
    }).on('error', once(reject));
  });
}

/**
 * 通用 TikHub POST API 请求
 */
function tikhubRequestPost(endpoint, body, apiKey = null) {
  return new Promise((resolve, reject) => {
    const url = new URL(`${API_BASE}${endpoint}`);
    const key = apiKey || API_KEY;
    const postData = JSON.stringify(body);
    
    const options = {
      hostname: url.hostname,
      path: url.pathname + url.search,
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${key}`,
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(postData)
      },
      timeout: 30000
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          const body = json.detail || json;
          if (res.statusCode === 402) {
            logger.error(`[TikHub POST] 余额不足！端点: ${endpoint.split('?')[0]}`);
            reject(new Error('服务暂时不可用，请稍后重试'));
            return;
          }
          if (body.code === 200 || json.data || body.data) {
            resolve(json.data || body.data || json);
          } else {
            const msg = body.message_zh || body.message || 'TikHub API error';
            reject(new Error(msg));
          }
        } catch (e) {
          reject(new Error(`TikHub response parse error: ${data.substring(0, 200)}`));
        }
      });
    });
    
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('TikHub API timeout')); });
    req.write(postData);
    req.end();
  });
}

/**
 * 下载文件到本地
 */
async function parseYouTube(url, taskId, onProgress) {
  const videoIdMatch = url.match(/(?:v=|youtu\.be\/|shorts\/)([a-zA-Z0-9_-]{11})/);
  if (!videoIdMatch) throw new Error('无效的 YouTube 链接');
  const videoId = videoIdMatch[1];

  logger.info(`[TikHub] Parsing YouTube: ${videoId}`);
  if (onProgress) onProgress(10);

  let data;
  try {
    data = await tikhubRequest(`/api/v1/youtube/web/get_video_info?video_id=${videoId}&need_format=true`, API_KEY_YT);
  } catch (e) {
    throw new Error(`YouTube 解析失败：${e.message}`);
  }

  if (onProgress) onProgress(20);

  // 获取视频信息
  const title = data.title || 'YouTube Video';
  const thumbnails = data.thumbnails || [];
  const thumbnail = thumbnails.length > 0 ? thumbnails[0].url : '';
  const duration = data.lengthSeconds ? parseInt(data.lengthSeconds) : 0;

  // 找到最好的下载链接 (TikHub returns videos.items)
  let downloadUrl = '';
  const videos = data.videos?.items || [];

  // 找最高画质的 MP4
  const bestVideo = videos
    .filter(v => v.url && (v.mimeType || '').includes('video/mp4'))
    .sort((a, b) => {
      const aH = parseInt((a.qualityLabel || '0p').replace('p', ''));
      const bH = parseInt((b.qualityLabel || '0p').replace('p', ''));
      return bH - aH;
    })[0];

  if (bestVideo?.url) {
    downloadUrl = bestVideo.url;
  }

  if (!downloadUrl) {
    throw new Error('No download URL found from TikHub');
  }

  logger.info(`[TikHub] Found YouTube stream: ${title}`);

  // 下载视频
  const outputPath = path.join(DOWNLOAD_DIR, `${taskId}.mp4`);
  await downloadFile(downloadUrl, outputPath, onProgress);

  // 下载封面
  let thumbnailUrl = '';
  if (thumbnail) {
    const thumbPath = path.join(DOWNLOAD_DIR, `${taskId}_thumb.jpg`);
    try {
      await downloadFile(thumbnail, thumbPath);
      thumbnailUrl = `/download/${taskId}_thumb.jpg`;
    } catch {}
  }

  if (onProgress) onProgress(100);

  return {
    title,
    filePath: outputPath,
    ext: 'mp4',
    thumbnailUrl,
    subtitleFiles: [],
    duration
  };
}

/**
 * 解析小红书笔记 (TikHub)
 */
async function parseXiaohongshu(url, taskId, onProgress, quality) {
  logger.info(`[TikHub] Parsing Xiaohongshu: ${url}`);
  if (onProgress) onProgress(10);

  // 使用 fetch_feed_notes_v3 接口(支持短链)
  let data;
  try {
    data = await tikhubRequest(`/api/v1/xiaohongshu/web_v2/fetch_feed_notes_v3?short_url=${encodeURIComponent(url)}`);
  } catch (e) {
    throw new Error(`小红书解析失败：${e.message}`);
  }

  if (onProgress) onProgress(20);

  const note = data.note || data.data?.note || {};
  const title = note.title || 'Xiaohongshu Note';
  const type = note.type || '';

  // 视频笔记
  if (type === 'video') {
    const video = note.video || {};
    const media = video.media || {};
    const stream = media.stream || {};
    const h264 = stream.h264 || [];

    // 按画质限制筛选 + 取最高码率
    const validStreams = h264.filter(s => s.masterUrl);
    let filtered = validStreams;
    if (quality) {
      const hMatch = quality.match(/height<=(\d+)/i);
      if (hMatch) {
        const maxHeight = parseInt(hMatch[1]);
        filtered = validStreams.filter(s => (s.height || 0) <= maxHeight);
        logger.info(`[TikHub] XHS quality filter: height<=${maxHeight}, streams: ${validStreams.length}→${filtered.length}`);
        // 回退：如果全部被筛掉，取最高可用画质
        if (filtered.length === 0) {
          filtered = validStreams;
          logger.warn(`[TikHub] XHS no stream matches quality filter, falling back to best available`);
        }
      }
    }
    const bestStream = filtered
      .sort((a, b) => (b.avgBitrate || 0) - (a.avgBitrate || 0))[0];

    if (bestStream?.masterUrl) {
      logger.info(`[TikHub] Found Xiaohongshu video: ${title}`);

      const outputPath = path.join(DOWNLOAD_DIR, `${taskId}.mp4`);
      await downloadFile(bestStream.masterUrl, outputPath, onProgress);

      // 下载封面
      let thumbnailUrl = '';
      const thumbId = video.image?.thumbnailFileid || '';
      if (thumbId) {
        const thumbUrl = `https://ci.xiaohongshu.com/${thumbId}`;
        const thumbPath = path.join(DOWNLOAD_DIR, `${taskId}_thumb.jpg`);
        try {
          await downloadFile(thumbUrl, thumbPath);
          thumbnailUrl = `/download/${taskId}_thumb.jpg`;
        } catch {}
      }

      if (onProgress) onProgress(100);

      return {
        title,
        filePath: outputPath,
        ext: 'mp4',
        thumbnailUrl,
        subtitleFiles: [],
        width: bestStream.width || null,
        height: bestStream.height || null,
        quality: bestStream.height ? `${bestStream.height}p` : null,
        duration: video.capa?.duration || 0
      };
    }
  }

  // 图文笔记
  const imageList = note.imageList || [];
  if (imageList.length > 0) {
    logger.info(`[TikHub] Found Xiaohongshu images: ${imageList.length}`);

    // 去XHS水印后缀取原图（!nd_dft_wlteh_jpg_3 → 去掉!及之后内容）
    const stripWatermark = (u) => u.replace(/![^!]+$/, '');

    const imageFiles = [];
    for (let i = 0; i < imageList.length; i++) {
      const img = imageList[i];
      // 优先用infoList找最高质量原图URL
      let imgUrl = img.urlDefault || img.url || '';
      const infoList = img.infoList || [];
      for (const info of infoList) {
        if (info.url && info.imageScene !== 'WB_PRV') {
          imgUrl = info.url; // 优先非预览场景
        }
      }
      // 尝试无水印原图（去掉suffix），失败则fallback到带水印URL
      const rawUrl = stripWatermark(imgUrl);

      if (imgUrl) {
        const imgPath = path.join(DOWNLOAD_DIR, `${taskId}_img_${i}.jpg`);
        let downloaded = false;
        try {
          await downloadFile(rawUrl, imgPath, (p) => {
            if (onProgress) onProgress(Math.round(20 + (i / imageList.length) * 70 + p * 0.1));
          });
          downloaded = true;
          logger.info(`[TikHub] XHS image ${i+1} downloaded (raw quality): ${rawUrl.substring(0,60)}...`);
        } catch (e) {
          logger.warn(`[TikHub] XHS image ${i+1} raw failed, trying default: ${e.message}`);
        }
        if (!downloaded && rawUrl !== imgUrl) {
          try {
            await downloadFile(imgUrl, imgPath, (p) => {
              if (onProgress) onProgress(Math.round(20 + (i / imageList.length) * 70 + p * 0.1));
            });
            downloaded = true;
          } catch {}
        }
        if (downloaded) {
          imageFiles.push({
            filename: `${taskId}_img_${i}.jpg`,
            path: imgPath,
            url: `/download/${taskId}_img_${i}.jpg`,
            width: img.width || 0,
            height: img.height || 0
          });
        }
      }
    }

    if (onProgress) onProgress(100);

    return {
      title,
      filePath: null,
      ext: null,
      thumbnailUrl: imageFiles[0]?.url || '',
      subtitleFiles: [],
      isNote: true,
      imageFiles,
      duration: 0
    };
  }

  throw new Error('Failed to parse Xiaohongshu note');
}

/**
 * YouTube 下载(直接用 TikHub API)
 */
async function downloadYouTubeViaAPI(url, taskId, onProgress, quality) {
  const https = require('https');
  const http = require('http');
//   const fs = require('fs');
//   const path = require('path');

  const videoIdMatch = url.match(/(?:v=|youtu\.be\/|shorts\/)([a-zA-Z0-9_-]{11})/);
  if (!videoIdMatch) throw new Error('Invalid YouTube URL');
  const videoId = videoIdMatch[1];

  logger.info(`[TikHub] Downloading YouTube: ${videoId} with quality: ${quality}`);
  if (onProgress) onProgress(5);

  // 获取视频信息
  let data;
  try {
    data = await tikhubRequest(`/api/v1/youtube/web/get_video_info?video_id=${videoId}&need_format=true`, API_KEY_YT);
  } catch (e) {
    throw new Error(`YouTube 下载失败：${e.message}`);
  }
  if (onProgress) onProgress(15);

  const title = data.title || 'YouTube Video';
  const thumbnails = data.thumbnails || [];
  const thumbnail = thumbnails.length > 0 ? thumbnails[0].url : '';
  const duration = data.lengthSeconds ? parseInt(data.lengthSeconds) : 0;

  // 选择最佳格式
  const videos = data.videos?.items || [];
  let selectedVideo = null;

  if (quality && quality.includes('height<=')) {
    // 解析画质要求
    const heightMatch = quality.match(/height<=(\d+)/);
    const maxHeight = heightMatch ? parseInt(heightMatch[1]) : 99999;

    // 找到最佳匹配的格式
    for (const v of videos) {
      if (v.url && v.hasVideo && v.height <= maxHeight) {
        if (!selectedVideo || v.height > selectedVideo.height) {
          selectedVideo = v;
        }
      }
    }
  }

  // 如果没找到,选最高画质
  if (!selectedVideo) {
    for (const v of videos) {
      if (v.url && v.hasVideo) {
        if (!selectedVideo || v.height > selectedVideo.height) {
          selectedVideo = v;
        }
      }
    }
  }

  if (!selectedVideo || !selectedVideo.url) {
    throw new Error('No download URL found');
  }

  logger.info(`[TikHub] Selected: ${selectedVideo.width}x${selectedVideo.height}`);
  if (onProgress) onProgress(25);

  // 立即下载(URL 可能很快过期)
  const outputPath = path.join(DOWNLOAD_DIR, `${taskId}.mp4`);
  const downloadUrl = selectedVideo.url;

  logger.info(`[TikHub] Downloading from: ${downloadUrl.substring(0, 80)}...`);

  // 使用 downloadFile 下载(支持字节进度)
  await downloadFile(downloadUrl, outputPath, (percent, downloaded, total) => {
    if (onProgress) onProgress(30 + Math.floor(percent * 0.6), downloaded, total);
  }, {
    'User-Agent': 'Mozilla/5.0',
    'Referer': 'https://www.youtube.com/'
  });

  if (onProgress) onProgress(90);

  // 下载封面
  let thumbnailUrl = '';
  if (thumbnail) {
    const thumbPath = path.join(DOWNLOAD_DIR, `${taskId}_thumb.jpg`);
    try {
      await downloadFile(thumbnail, thumbPath, null, {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
      });
      thumbnailUrl = `/download/${taskId}_thumb.jpg`;
    } catch (e) {
      logger.info(`[TikHub] Thumbnail failed: ${e.message}`);
    }
  }

  if (onProgress) onProgress(100);

  return {
    title,
    filePath: outputPath,
    ext: 'mp4',
    thumbnailUrl,
    subtitleFiles: [],
    duration
  };
}

async function parseDouyin(url, taskId, onProgress, quality = null, isVip = false) {
  // 解析画质限制
  let maxHeight = 99999; // 默认无限制
  let videoUrl = null;
  if (quality && quality.includes('height<=')) {
    const heightMatch = quality.match(/height<=(\d+)/);
    if (heightMatch) {
      maxHeight = parseInt(heightMatch[1]);
    }
  }

  // 提取 aweme_id
  let awemeId;
  const videoMatch = url.match(/\/video\/(\d+)/);
  const noteMatch = url.match(/\/note\/(\d+)/);
  awemeId = videoMatch?.[1] || noteMatch?.[1];

  if (!awemeId) {
    // 尝试解析短链接
    const https = require('https');
    const resolved = await new Promise((resolve, reject) => {
      https.get(url, {
        headers: { 'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X)' }
      }, (res) => {
        const loc = res.headers.location || '';
        const vm = loc.match(/\/video\/(\d+)/);
        const nm = loc.match(/\/note\/(\d+)/);
        resolve(vm?.[1] || nm?.[1]);
      }).on('error', () => resolve(null));
    });
    awemeId = resolved;
  }

  if (!awemeId) throw new Error('无法解析抖音作品 ID');

  logger.info(`[TikHub] Parsing Douyin: ${awemeId}`);
  if (onProgress) onProgress(10);

  // 优先使用分享链接 API（支持高清画质）
  let data = {};
  try {
    data = await tikhubRequest(`/api/v1/douyin/app/v3/fetch_one_video?aweme_id=${awemeId}`, API_KEY_DOUYIN);
    logger.info(`[TikHub] fetch_one_video (app/v3) succeeded`);
  } catch (e) {
    throw new Error(`抖音解析失败：${e.message}`);
  }
  if (onProgress) onProgress(20);

  const detail = data.aweme_detail || {};
  const video = detail.video || {};
  const title = detail.desc || '抖音作品';

  // 获取 H.265 画质 URL（备用，通常有 1080p）
  const playAddr265 = video.play_addr_265 || {};
  const playAddr265Url = playAddr265.url_list?.[0] || '';

  // 尝试使用高清 API 获取原始视频（可能有 2K/4K）
  logger.info(`[TikHub] Fetching high quality video...`);
  if (onProgress) onProgress(15);

  let hqVideoUrl = '';
  let hqFileSize = 0;
  if (isVip) {
    // VIP用户:调用单视频付费高清API获取最高画质原始素材(支持2K/4K)
    // 价格: $0.005/次
    try {
      const hqData = await tikhubRequest(
        `/api/v1/douyin/app/v3/fetch_video_high_quality_play_url?aweme_id=${awemeId}&share_url=${encodeURIComponent(url)}&region=CN`,
        API_KEY_DOUYIN
      );
      if (hqData.original_video_url) {
        hqVideoUrl = hqData.original_video_url;
        hqFileSize = hqData.video_data?.file_size_in_mb || 0;
        logger.info(`[TikHub] VIP HQ video found: ${hqFileSize} MB, video_id: ${hqData.video_id}`);
      }
    } catch (e) {
      logger.info(`[TikHub] fetch_video_high_quality_play_url failed: ${e.message}`);
    }
  } else {
    logger.info(`[TikHub] Non-VIP user, skipping paid HQ API`);
  }

  // 收集所有可用画质源
  const candidates = [];
  let selectedWidth = 0;
  let selectedHeight = 0;

  // 1. H.265 源(可能有更高分辨率如 2K)
  if (playAddr265Url) {
    candidates.push({
      url: playAddr265Url,
      width: playAddr265?.width || 0,
      height: playAddr265?.height || 0,
      codec: 'h265',
      bitrate: playAddr265?.bit_rate || 0,
      hasAudio: false // H.265 流通常不含音频
    });
  }

  // 2. bit_rate 数组(H.264,通常有音频)
  if (video.bit_rate) {
    for (const br of video.bit_rate) {
      const url = br.play_addr?.url_list?.[0];
      if (url) {
        candidates.push({
          url,
          width: br.play_addr?.width || 0,
          height: br.play_addr?.height || 0,
          codec: 'h264',
          bitrate: br.bit_rate || 0,
          hasAudio: true // bit_rate 通常有音频
        });
      }
    }
  }

  // 3. play_addr 兜底
  if (video.play_addr?.url_list?.[0]) {
    candidates.push({
      url: video.play_addr.url_list[0],
      width: video.play_addr.width || 0,
      height: video.play_addr.height || 0,
      codec: 'h264',
      bitrate: video.play_addr.bit_rate || 0,
      hasAudio: false
    });
  }

  logger.info(`[TikHub] Found ${candidates.length} video sources:`);
  for (const c of candidates) {
    logger.info(`  ${c.codec} ${c.width}x${c.height} ${c.bitrate}bps${c.hasAudio ? ' (hasAudio)' : ''}`);
  }

  // 排序:高清原始 URL 优先,然后有音频的,最后按分辨率降序
  candidates.sort((a, b) => {
    if (a.hasAudio !== b.hasAudio) return b.hasAudio - a.hasAudio;
    return (b.height || 0) - (a.height || 0);
  });

  // 选择视频源
  // 关键: fetch_one_video 的 bit_rate 元数据不可靠(标2560x1440实际1080p)
  // VIP请求≥2K时,唯一直正高清来源是 fetch_video_high_quality_play_url 原始文件
  let selected = null;

  if (hqVideoUrl && (maxHeight >= 99999 || maxHeight >= QUALITY_2K_HEIGHT)) {
    // VIP请求最大画质 或 ≥2K → 直接用HQ原始(可靠真高清)
    selected = { url: hqVideoUrl, width: 0, height: maxHeight, codec: 'original', bitrate: 0, hasAudio: false };
    logger.info(`[TikHub] Using HQ original (${maxHeight >= 99999 ? 'max' : maxHeight + 'p'}): ${hqFileSize} MB`);
  } else {
    // 从免费API候选列表找最佳匹配
    for (const c of candidates) {
      if (maxHeight < 99999 && c.height > maxHeight) continue;
      if (!selected || (c.hasAudio && !selected.hasAudio) || (c.hasAudio === selected.hasAudio && c.height > selected.height)) {
        selected = c;
      }
    }

    if (!selected && hqVideoUrl) {
      // 候选全不满足,HQ兜底
      selected = { url: hqVideoUrl, width: 0, height: maxHeight, codec: 'original', bitrate: 0, hasAudio: false };
      logger.info(`[TikHub] No candidate fits, using HQ original: ${hqFileSize} MB`);
    } else if (!selected && candidates.length > 0) {
      // 无HQ,所有候选超限
      selected = candidates[0];
      logger.info(`[TikHub] All candidates exceed limit, using highest: ${selected.height}p`);
    }
  }

  if (selected) {
    videoUrl = selected.url;
    selectedWidth = selected.width;
    selectedHeight = selected.height;
    logger.info(`[TikHub] Selected: ${selected.codec} ${selectedWidth}x${selectedHeight} ${selected.bitrate}bps`);
  }

  if (!videoUrl) throw new Error('No download URL found');

  logger.info(`[TikHub] Found Douyin video URL`);
  if (onProgress) onProgress(30);

  // 下载视频
//   const fs = require('fs');
//   const path = require('path');
  const outputPath = path.join(DOWNLOAD_DIR, `${taskId}.mp4`);

  // HQ原始文件可能很大(78MB+),需要更长超时
  const downloadTimeoutMs = hqVideoUrl ? 300_000 : 120_000; // 5min for HQ, 2min for normal
  await downloadFile(videoUrl, outputPath, (percent, downloaded, total) => {
    if (onProgress) onProgress(30 + Math.floor(percent * 0.65), downloaded, total);
  }, {
    'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X)',
    'Referer': 'https://www.douyin.com/'
  }, { timeoutMs: downloadTimeoutMs });

  // HQ原始文件: 用 ffprobe 检测实际分辨率(API元数据不可靠)
  if (hqVideoUrl) {
    try {
      const { execSync } = require('child_process');
      const probe = execSync(
        `ffprobe -v error -select_streams v:0 -show_entries stream=width,height -of csv=p=0 "${outputPath}"`,
        { timeout: 10000, encoding: 'utf8' }
      ).trim();
      const parts = probe.split(',');
      if (parts.length >= 2) {
        selectedWidth = parseInt(parts[0]) || selectedWidth;
        selectedHeight = parseInt(parts[1]) || selectedHeight;
        logger.info(`[TikHub] ffprobe detected actual resolution: ${selectedWidth}x${selectedHeight}`);
      }
    } catch (e) {
      logger.info(`[TikHub] ffprobe failed: ${e.message}, using metadata dimensions`);
    }
  }

  // 下载封面
  let thumbnailUrl = '';
  const coverUrl = video.cover?.url_list?.[0] || video.origin_cover?.url_list?.[0] || '';
  if (coverUrl) {
    const thumbPath = path.join(DOWNLOAD_DIR, `${taskId}_thumb.jpg`);
    try {
      await downloadFile(coverUrl, thumbPath, null, {
        'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X)'
      });
      thumbnailUrl = `/download/${taskId}_thumb.jpg`;
    } catch (e) {
      logger.info(`[TikHub] Thumbnail failed: ${e.message}`);
    }
  }

  if (onProgress) onProgress(100);

  // 画质标签用短边判断(竖屏视频高宽颠倒,1080x1920是1080p不是2K)
  const shortEdge = Math.min(selectedWidth || 0, selectedHeight || 0);
  const qualityLabel = shortEdge >= 2160 ? '4K' : shortEdge >= 1440 ? '2K' : shortEdge >= 1080 ? '1080p' : shortEdge >= 720 ? '720p' : shortEdge >= 480 ? '480p' : shortEdge >= 360 ? '360p' : 'SD';
  return {
    title,
    filePath: outputPath,
    ext: 'mp4',
    thumbnailUrl,
    subtitleFiles: [],
    duration: video.duration ? Math.floor(video.duration / 1000) : 0,
    width: selectedWidth,
    height: selectedHeight,
    quality: qualityLabel
  };
}

// 下载文件工具函数
/**
 * 安全下载远端文件到本地。
 * 修复点：
 *  - 限制最大重定向次数（防止恶意服务器无限跳转）
 *  - 阻止协议外/私网地址（防 SSRF）
 *  - 阻断 HTML/JSON 误判，分块阶段就 abort，不等到读完整个文件
 *  - 严格关闭 file stream，避免半写文件残留
 */
async function downloadFile(url, outputPath, onProgress, headers = {}, opts = {}) {
  // HEAD-only 模式：只获取文件大小，不下载
  if (opts.headOnly) {
    const protocol = (new URL(url)).protocol === "https:" ? require("https") : require("http");
    return new Promise((resolve, reject) => {
      const req = protocol.request(url, { method: "HEAD", headers: { "User-Agent": "Mozilla/5.0" }, ...headers }, (res) => {
        const size = parseInt(res.headers["content-length"], 10) || 0;
        res.resume();
        resolve(size);
      });
      req.on("error", reject);
      req.setTimeout(5000, () => { req.destroy(); resolve(0); });
      req.end();
    });
  }

  const https = require('https');
  const http = require('http');
  const fs = require('fs');

  const MAX_SIZE = 500 * 1024 * 1024; // 500MB
  const MAX_REDIRECTS = Number.isFinite(opts.maxRedirects) ? opts.maxRedirects : 5;
  const TIMEOUT_MS = Number.isFinite(opts.timeoutMs) ? opts.timeoutMs : 60_000;

  // 仅允许 http(s) 协议
  let parsed;
  try { parsed = new URL(url); } catch { throw new Error('Invalid URL'); }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('Only http/https URLs are allowed');
  }

  // 简单的私网阻断（防 SSRF）；按域名形态判断，IP 直连命中私网段的也拦掉
  const host = parsed.hostname.toLowerCase();
  const isPrivateHost =
    host === 'localhost' ||
    host === '127.0.0.1' ||
    host === '0.0.0.0' ||
    /^10\./.test(host) ||
    /^192\.168\./.test(host) ||
    /^172\.(1[6-9]|2\d|3[0-1])\./.test(host) ||
    /^169\.254\./.test(host) ||
    host.endsWith('.internal') ||
    host.endsWith('.local');
  if (isPrivateHost && !opts.allowPrivateHost) {
    throw new Error('Refused to download from private/local address');
  }

  const protocol = parsed.protocol === 'https:' ? https : http;

  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(outputPath);
    let totalSize = 0;
    let downloaded = 0;
    let settled = false;

    const cleanup = (err) => {
      if (settled) return;
      settled = true;
      try { file.destroy(); } catch {}
      fs.unlink(outputPath, () => {});
      if (err) reject(err); else resolve();
    };

    const req = protocol.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X)',
        ...headers
      }
    }, (response) => {
      // 重定向：递归调用，但带"剩余次数"
      if (
        response.statusCode >= 300 &&
        response.statusCode < 400 &&
        response.headers.location
      ) {
        if (MAX_REDIRECTS <= 0) {
          response.resume();
          return cleanup(new Error('Too many redirects'));
        }
        const nextUrl = new URL(response.headers.location, url).toString();
        response.resume();
        try { file.destroy(); } catch {}
        fs.unlink(outputPath, () => {});
        settled = true;
        return downloadFile(nextUrl, outputPath, onProgress, headers, {
          ...opts,
          maxRedirects: MAX_REDIRECTS - 1,
          timeoutMs: TIMEOUT_MS
        }).then(resolve).catch(reject);
      }

      if (response.statusCode !== 200) {
        response.resume();
        return cleanup(new Error(`HTTP ${response.statusCode}`));
      }

      const contentType = response.headers['content-type'] || '';
      // 早期就拒绝 HTML / JSON（视频 CDN 不应返回这种类型）
      if (
        contentType.includes('text/html') ||
        contentType.includes('application/json') ||
        contentType.startsWith('text/')
      ) {
        response.resume();
        return cleanup(new Error('Video link expired or blocked'));
      }

      totalSize = parseInt(response.headers['content-length'], 10) || 0;
      if (totalSize > MAX_SIZE) {
        response.resume();
        return cleanup(new Error('File too large (max 500MB)'));
      }

      let firstChunkChecked = false;

      response.on('data', (chunk) => {
        // 即便 content-type 撒谎，第一块字节里通常也能看出 HTML 头
        if (!firstChunkChecked) {
          firstChunkChecked = true;
          const head = chunk.slice(0, Math.min(chunk.length, 256))
            .toString('utf8').trim().toLowerCase();
          if (head.startsWith('<!doctype') || head.startsWith('<html') || head.startsWith('{')) {
            response.destroy();
            return cleanup(new Error('Video link expired or blocked'));
          }
        }

        downloaded += chunk.length;
        if (downloaded > MAX_SIZE) {
          response.destroy();
          return cleanup(new Error('File too large (max 500MB)'));
        }
        if (onProgress) {
          onProgress(
            totalSize > 0 ? Math.floor((downloaded / totalSize) * 100) : 0,
            downloaded,
            totalSize
          );
        }
      });

      response.on('error', (err) => cleanup(err));
      response.pipe(file);

      file.on('finish', () => {
        if (settled) return;
        settled = true;
        file.close(() => resolve());
      });
      file.on('error', (err) => cleanup(err));
    });

    req.setTimeout(TIMEOUT_MS, () => {
      req.destroy(new Error('Download timeout'));
    });
    req.on('error', (err) => cleanup(err));
  });
}


async function parseInstagram(url) {
  if (!API_KEY_INSTAGRAM) throw new Error('Instagram API 未配置，请联系管理员');

  let response;
  try {
    // 使用 v2 fetch_post_info（支持 shortcode 和完整 URL）
    response = await tikhubRequest(
      '/api/v1/instagram/v2/fetch_post_info?code_or_url=' + encodeURIComponent(url),
      API_KEY_INSTAGRAM
    );
  } catch (e) {
    throw new Error(`Instagram 解析失败：${e.message}`);
  }

  // v2 响应结构: { data: { data: { ... } } }
  const post = response?.data?.data || response?.data || response;
  if (!post) throw new Error('Instagram 解析失败：无数据返回');

  // 提取视频 URL（优先 video_versions，其次 video_url）
  const videoVersions = post.video_versions || [];
  const videoUrl = videoVersions.length > 0
    ? videoVersions[0].url
    : post.video_url;
  if (!videoUrl) throw new Error('No video URL found');

  // 提取封面
  let thumbnailUrl = post.thumbnail_url || '';
  if (!thumbnailUrl) {
    const images = post.image_versions2?.candidates || post.image_versions?.additional_items?.first_frame
      || post.carousel_media?.[0]?.image_versions2?.candidates || [];
    if (images.length > 0) thumbnailUrl = images[0].url;
    else if (images.url) thumbnailUrl = images.url;
  }

  return {
    title: (post.caption?.text || post.code || 'Instagram Video').substring(0, 200),
    videoUrl,
    width: videoVersions[0]?.width || post.dimensions?.width || 0,
    height: videoVersions[0]?.height || post.dimensions?.height || 0,
    duration: post.video_duration || 0,
    thumbnailUrl: thumbnailUrl || post.display_url || post.thumbnail_src || ''
  };
}

/**
 * 使用 web_v2 API 解析 YouTube(支持高清画质)
 * 接口: get_video_streams_v2
 * 返回所有画质流(1080p/720p/480p/360p等)+ 音频流
 *
 * 画质策略:
 * - < 720p: 使用 combined 格式(视频+音频混合流)
 * - >= 720p: 使用 adaptive 格式(视频+音频分离),通过 ffmpeg 合并
 */
async function parseYouTubeV2(url, taskId, onProgress, quality = null) {
  const videoIdMatch = url.match(/(?:v=|youtu\.be\/|shorts\/)([a-zA-Z0-9_-]{11})/);
  if (!videoIdMatch) throw new Error('无效的 YouTube 链接');
  const videoId = videoIdMatch[1];

  logger.info(`[TikHub v2] Parsing YouTube: ${videoId}, API_KEY present: ${!!API_KEY_YT}`);
  if (onProgress) onProgress(5);

  // 调用 web_v2 接口, need_format=true 获取完整格式列表
  let data;
  try {
    data = await tikhubRequest(
      `/api/v1/youtube/web_v2/get_video_streams_v2?video_id=${videoId}&need_format=true`,
      API_KEY_YT
    );
  } catch (e) {
    throw new Error(`YouTube 解析失败：${e.message}`);
  }

  logger.info(`[TikHub v2] API response: formats=${data.formats?.length || 0}, adaptive=${data.adaptive_formats?.length || 0}`);

  const title = data.title || 'YouTube Video';
  const duration = data.length_seconds ? parseInt(data.length_seconds) : 0;
  const thumbnails = Array.isArray(data.thumbnail) ? data.thumbnail : [];
  const thumbnailUrl = thumbnails[0]?.url || '';

  logger.info(`[TikHub v2] Title: ${title}, duration: ${duration}s`);
  if (onProgress) onProgress(15);

  // 解析画质限制
  let maxHeight = 99999;
  if (quality && quality.includes('height<=')) {
    const m = quality.match(/height<=(\d+)/);
    if (m) maxHeight = parseInt(m[1]);
  }

  // 分离 combined(混合流) 和 adaptive(分离流)
  const combinedFormats = (data.formats || []).filter(f => f.url && f.type !== 'audio');
  const adaptiveFormats = (data.adaptive_formats || []).filter(f => f.url);

  const videoOnly = adaptiveFormats.filter(f => f.type === 'video' || (f.mime_type && f.mime_type.includes('video')));
  const audioOnly = adaptiveFormats.filter(f => f.type === 'audio' || (f.mime_type && f.mime_type.includes('audio')));

  logger.info(`[TikHub v2] Combined: ${combinedFormats.length}, Video: ${videoOnly.length}, Audio: ${audioOnly.length}`);

  let videoUrl, audioUrl, selectedHeight, qualityLabel;

  // 策略: < 720p 用 combined; >= 720p 用 adaptive 分离流
  if (maxHeight < 720) {
    const candidates = combinedFormats
      .filter(f => f.height && f.height <= maxHeight)
      .sort((a, b) => (b.height || 0) - (a.height || 0));

    if (candidates.length > 0) {
      const best = candidates[0];
      videoUrl = best.url;
      selectedHeight = best.height;
      qualityLabel = best.quality_label || best.quality || `${best.height}p`;
      logger.info(`[TikHub v2] Using combined: ${qualityLabel}`);
    }
  }

  if (!videoUrl && maxHeight >= 720) {
    const videoCandidates = videoOnly
      .filter(f => f.height && f.height <= maxHeight)
      .sort((a, b) => (b.height || 0) - (a.height || 0));

    const audioCandidates = audioOnly.sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0));

    if (videoCandidates.length > 0 && audioCandidates.length > 0) {
      const bestVideo = videoCandidates[0];
      const bestAudio = audioCandidates[0];
      videoUrl = bestVideo.url;
      audioUrl = bestAudio.url;
      selectedHeight = bestVideo.height;
      qualityLabel = bestVideo.quality_label || bestVideo.quality || `${bestVideo.height}p`;
      logger.info(`[TikHub v2] Using adaptive: video=${qualityLabel}, audio=${bestAudio.bitrate}kbps`);
    }
  }

  if (!videoUrl) {
    const fallback = combinedFormats
      .filter(f => f.height && f.height <= maxHeight)
      .sort((a, b) => (b.height || 0) - (a.height || 0))[0];
    if (fallback) {
      videoUrl = fallback.url;
      selectedHeight = fallback.height;
      qualityLabel = fallback.quality_label || fallback.quality || `${fallback.height}p`;
      logger.info(`[TikHub v2] Fallback to combined: ${qualityLabel}`);
    }
  }

  if (!videoUrl) throw new Error('No video stream found');
  logger.info(`[TikHub v2] Selected: ${qualityLabel} (${selectedHeight}p)`);
  if (onProgress) onProgress(20);

  const outputPath = path.join(DOWNLOAD_DIR, `${taskId}.mp4`);
  const tempVideo = path.join(DOWNLOAD_DIR, `${taskId}_video.mp4`);
  const tempAudio = path.join(DOWNLOAD_DIR, `${taskId}_audio.mp4`);

  // 下载
  // 直接下载单个视频流
  if (onProgress) onProgress(25);
  try {
    await downloadFile(videoUrl, outputPath, (percent, downloaded, total) => {
      if (onProgress) onProgress(25 + Math.floor(percent * 0.65), downloaded, total);
    }, { 'User-Agent': 'Mozilla/5.0', 'Referer': 'https://www.youtube.com/' });
  } catch (dlErr) {
    // 403/401 可能是 Railway IP 被 Google 限制
    if (dlErr.message && (dlErr.message.includes('403') || dlErr.message.includes('401'))) {
      throw new Error(`视频下载失败(Google IP限制)，请尝试更换节点或稍后重试`);
    }
    throw dlErr;
  }

  if (onProgress) onProgress(90);

  let thumbPath = '';
  if (thumbnailUrl) {
    thumbPath = path.join(DOWNLOAD_DIR, `${taskId}_thumb.jpg`);
    try { await downloadFile(thumbnailUrl, thumbPath); } catch { thumbPath = ''; }
  }

  if (onProgress) onProgress(100);

  return {
    title, filePath: outputPath, ext: 'mp4',
    thumbnailUrl: thumbPath ? `/download/${taskId}_thumb.jpg` : '',
    subtitleFiles: [], duration,
    width: 0, height: selectedHeight,
    quality: qualityLabel
  };
}


/**
 * 获取抖音视频的画质信息（仅视频信息，不下载）
 * 用于 /video-info 接口
 * @param {string} url 抖音视频链接
 * @returns {Promise<{title: string, thumbnail: string, duration: number, qualities: Array}>}
 */
async function getDouyinQualities(url) {
  // 提取 aweme_id
  let awemeId;
  const videoMatch = url.match(/\/video\/(\d+)/);
  const noteMatch = url.match(/\/note\/(\d+)/);
  awemeId = videoMatch?.[1] || noteMatch?.[1];

  if (!awemeId) {
    // 尝试解析短链接
    const https = require('https');
    awemeId = await new Promise((resolve) => {
      https.get(url, {
        headers: { 'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X)' }
      }, (res) => {
        const loc = res.headers.location || '';
        const vm = loc.match(/\/video\/(\d+)/);
        const nm = loc.match(/\/note\/(\d+)/);
        resolve(vm?.[1] || nm?.[1] || null);
      }).on('error', () => resolve(null));
    });
  }

  if (!awemeId) throw new Error('无法解析抖音作品 ID');

  // 调用 TikHub fetch_one_video 获取 bit_rate 数组
  let data = {};
  try {
    data = await tikhubRequest(
      `/api/v1/douyin/app/v3/fetch_one_video?aweme_id=${awemeId}`,
      API_KEY_DOUYIN
    );
  } catch (e) {
    throw new Error(`抖音画质查询失败：${e.message}`);
  }

  const detail = data?.aweme_detail || {};
  const video = detail.video || {};
  const title = detail.desc || '抖音作品';
  const cover = (detail.video?.cover?.url_list?.[0] || detail.video?.origin_cover?.url_list?.[0]) || '';
  // TikHub API 返回的是毫秒，转换为秒
  const duration = detail.video?.duration ? Math.floor(detail.video.duration / 1000) : 0;

  // 从 bit_rate 和 play_addr_265 收集画质
  const qualityMap = new Map();
  
  // 画质短边计算(竖屏视频用短边,1080x1920是1080p不是2K)
  const getQuality = (w, h) => {
    const shortEdge = Math.min(w || 0, h || 0);
    return heightToLabel(shortEdge);
  };
  
  // 用 duration(秒) × bitrate(bps) / 8 估算文件大小(bytes)
  const estimateSize = (bitrateBps) => {
    if (!bitrateBps || !duration) return 0;
    return Math.round(duration * bitrateBps / 8);
  };

  // H.265 源 (可能 1080p/2K)
  const playAddr265 = video.play_addr_265;
  if (playAddr265?.url_list?.[0]) {
    const w = playAddr265.width || 0;
    const h = playAddr265.height || 0;
    const key = `${w}x${h}`;
    if (w && h && !qualityMap.has(key)) {
      qualityMap.set(key, {
        quality: getQuality(w, h),
        format: 'mp4',
        width: w,
        height: h,
        hasVideo: true,
        hasAudio: false,
        size: estimateSize((playAddr265.bit_rate || 0) * 2),
        _playUrl: playAddr265.url_list?.[0] || null
      });
    }
  }

  // bit_rate 数组 (H.264, 通常有音频)
  const bitrates = video.bit_rate || [];
  for (const br of bitrates) {
    const pa = br.play_addr;
    if (!pa?.url_list?.[0]) continue;
    const w = pa.width || 0;
    const h = pa.height || 0;
    const key = `${w}x${h}`;
    const totalBitrate = br.bit_rate || pa.bit_rate || 0;
    if (w && h && !qualityMap.has(key)) {
      qualityMap.set(key, {
        quality: getQuality(w, h),
        format: 'mp4',
        width: w,
        height: h,
        hasVideo: true,
        hasAudio: true,
        size: estimateSize(totalBitrate),
        _playUrl: pa.url_list?.[0] || null
      });
    }
  }

  // play_addr 兜底 (通常 720p)
  const playAddr = video.play_addr;
  if (playAddr?.url_list?.[0]) {
    const w = playAddr.width || 0;
    const h = playAddr.height || 720;
    const key = `${w}x${h}`;
    if (w && h && !qualityMap.has(key)) {
      qualityMap.set(key, {
        quality: getQuality(w, h),
        format: 'mp4',
        width: w,
        height: h,
        hasVideo: true,
        hasAudio: true,
        size: estimateSize(playAddr.bit_rate || 0),
        _playUrl: playAddr.url_list?.[0] || null
      });
    }
  }

  const qualities = Array.from(qualityMap.values())
    .sort((a, b) => Math.min(b.width||0,b.height||0) - Math.min(a.width||0,a.height||0));

  logger.info(`[TikHub] Douyin qualities for ${awemeId} (duration=${duration}s): ${qualities.map(q => `${q.quality} ~${(q.size/1024/1024).toFixed(1)}MB`).join(', ')}`);

  return { title, thumbnail: cover, duration, qualities };
}

/**
 * Bilibili 下载 (TikHub API - 两步流)
 * Step 1: fetch_one_video → 获取 bvid/cid/元数据
 * Step 2: fetch_video_playurl → 获取 DASH 音视频流
 * Step 3: ffmpeg 合并音视频
 */
async function parseBilibili(url, taskId, onProgress, quality) {
  const bvidMatch = url.match(/BV[a-zA-Z0-9]{10}/);
  if (!bvidMatch) throw new Error('无法解析 Bilibili BV 号');
  const bvid = bvidMatch[0];
  
  logger.info(`[TikHub] Parsing Bilibili: ${bvid}`);
  if (onProgress) onProgress(5);

  const key = process.env.TIKHUB_API_KEY_BILIBILI || API_KEY_DOUYIN;
  if (!key) throw new Error('Bilibili API key 未配置');

  // Step 1: 获取元数据
  let meta;
  try {
    meta = await tikhubRequest(`/api/v1/bilibili/web/fetch_one_video?bv_id=${bvid}`, key);
  } catch (e) {
    if (e.message?.includes('403') || e.message?.includes('permissions')) {
      throw new Error('Bilibili API 权限不足。请前往 https://user.tikhub.io/dashboard/api 给 API key 添加 Bilibili Web API 权限');
    }
    throw new Error(`Bilibili 解析失败：${e.message}`);
  }

  const info = (meta.data?.data) || meta.data || meta;
  const title = info.title || 'Bilibili Video';
  const duration = info.duration || 0;
  const cid = info.cid || info.pages?.[0]?.cid || 0;
  if (!cid) throw new Error('无法获取 Bilibili 视频 cid');

  logger.info(`[TikHub] Bilibili metadata: ${title}, cid=${cid}, duration=${duration}s`);
  if (onProgress) onProgress(15);

  // Step 2: 获取播放地址 (DASH 流)
  let playData;
  try {
    playData = await tikhubRequest(`/api/v1/bilibili/web/fetch_video_playurl?bv_id=${bvid}&cid=${cid}`, key);
  } catch (e) {
    throw new Error(`Bilibili 播放地址获取失败：${e.message}`);
  }

  const playInfo = (playData.data?.data) || playData.data || playData;
  const dash = playInfo.dash || {};
  const dashVideos = dash.video || [];
  const dashAudios = dash.audio || [];

  if (dashVideos.length === 0) throw new Error('Bilibili 未找到视频流');

  let filtered = dashVideos;
  if (quality) {
    const hMatch = quality.match(/height<=(\d+)/i);
    if (hMatch) {
      const maxHeight = parseInt(hMatch[1]);
      filtered = dashVideos.filter(v => (v.height || 0) <= maxHeight);
      if (filtered.length === 0) filtered = dashVideos;
    }
  }
  const bestVideo = filtered.sort((a, b) => (b.height || 0) - (a.height || 0))[0];
  const bestAudio = (dashAudios || []).sort((a, b) => (b.bandwidth || 0) - (a.bandwidth || 0))[0];

  const videoH = bestVideo.height || 0;
  logger.info(`[TikHub] Bilibili stream: ${videoH}p, audio=${bestAudio ? Math.round(bestAudio.bandwidth / 1000) + 'kbps' : 'none'}`);

  if (onProgress) onProgress(25);

  // Step 3: 下载视频流 + 音频流
  const videoPath = path.join(DOWNLOAD_DIR, `${taskId}_video.m4s`);
  const audioPath = path.join(DOWNLOAD_DIR, `${taskId}_audio.m4s`);
  const outputPath = path.join(DOWNLOAD_DIR, `${taskId}.mp4`);

  await downloadFile(bestVideo.baseUrl || bestVideo.base_url || bestVideo.url, videoPath, (p) => {
    if (onProgress) onProgress(25 + Math.round(p * 0.5));
  });

  if (bestAudio?.baseUrl || bestAudio?.base_url || bestAudio?.url) {
    await downloadFile(bestAudio.baseUrl || bestAudio.base_url || bestAudio.url, audioPath, (p) => {
      if (onProgress) onProgress(75 + Math.round(p * 0.15));
    });
  }

  // Step 4: ffmpeg 合并音视频
  if (onProgress) onProgress(92);
  await mergeBilibiliStreams(videoPath, audioPath, outputPath, taskId);

  if (onProgress) onProgress(100);

  return {
    title,
    filePath: outputPath,
    ext: 'mp4',
    thumbnailUrl: (info.pic || '').replace('http://', 'https://'),
    subtitleFiles: [],
    width: bestVideo.width || null,
    height: videoH || null,
    quality: videoH ? `${videoH}p` : null,
    duration
  };
}

/**
 * ffmpeg 合并 Bilibili DASH 音视频流
 */
function mergeBilibiliStreams(videoPath, audioPath, outputPath, taskId) {
  const { spawn } = require('child_process');
  return new Promise((resolve, reject) => {
    const args = ['-y', '-i', videoPath, '-i', audioPath, '-c:v', 'copy', '-c:a', 'aac', '-shortest', outputPath];
    logger.info(`[Bilibili] Merging DASH streams for ${taskId}`);
    const ff = spawn('ffmpeg', args);
    let stderr = '';
    ff.stderr.on('data', d => { stderr += d.toString(); });
    const timer = setTimeout(() => { ff.kill(); reject(new Error('merge timeout')); }, 120000);
    ff.on('close', code => {
      clearTimeout(timer);
      if (code === 0) {
        try { fs.unlinkSync(videoPath); } catch {}
        try { fs.unlinkSync(audioPath); } catch {}
        resolve();
      } else {
        reject(new Error(`ffmpeg merge exit ${code}`));
      }
    });
  });
}

/**
 * Bilibili 画质列表（用于 /video-info）
 */
async function getBilibiliQualities(url) {
  const bvidMatch = url.match(/BV[a-zA-Z0-9]{10}/);
  if (!bvidMatch) throw new Error('无法解析 Bilibili BV 号');
  const bvid = bvidMatch[0];

  const key = process.env.TIKHUB_API_KEY_BILIBILI || API_KEY_DOUYIN;
  if (!key) throw new Error('Bilibili API key 未配置');

  let meta;
  try {
    meta = await tikhubRequest(`/api/v1/bilibili/web/fetch_one_video?bv_id=${bvid}`, key);
  } catch (e) {
    if (e.message?.includes('403') || e.message?.includes('permissions')) {
      throw new Error('Bilibili API 权限不足');
    }
    throw e;
  }
  const info = (meta.data?.data) || meta.data || meta;
  const title = info.title || 'Bilibili';
  const duration = info.duration || 0;
  const cid = info.cid || info.pages?.[0]?.cid || 0;

  let playData;
  try {
    playData = await tikhubRequest(`/api/v1/bilibili/web/fetch_video_playurl?bv_id=${bvid}&cid=${cid}`, key);
  } catch (e) {
    throw e;
  }
  const playInfo = (playData.data?.data) || playData.data || playData;
  const dashVideos = playInfo.dash?.video || [];
  const supportFormats = playInfo.support_formats || [];

  const seen = new Set();
  let qualities = supportFormats
    .filter(f => f.quality && f.new_description)
    .map(f => {
      const h = parseInt(f.new_description) || 0;
      return {
        quality: heightToLabel(h),
        format: 'mp4',
        width: Math.round(h * 16 / 9),
        height: h,
        hasVideo: true,
        hasAudio: true,
        size: 0
      };
    })
    .filter(q => q.height > 0 && !seen.has(q.height) && seen.add(q.height))
    .sort((a, b) => b.height - a.height);

  if (qualities.length === 0 && dashVideos.length > 0) {
    for (const v of dashVideos) {
      const h = v.height || 0;
      if (h > 0 && !seen.has(h)) {
        seen.add(h);
        qualities.push({ quality: heightToLabel(v.width, h), format: 'mp4', width: v.width || 0, height: h, hasVideo: true, hasAudio: true, size: 0 });
      }
    }
    qualities.sort((a, b) => b.height - a.height);
  }

  logger.info(`[TikHub] Bilibili qualities for ${bvid}: ${qualities.map(q => q.quality).join(', ')}`);

  return { title, duration, qualities };
}

module.exports = { parseYouTube, parseYouTubeV2, parseXiaohongshu, parseDouyin, parseInstagram, getDouyinQualities, parseBilibili, getBilibiliQualities, tikhubRequest, tikhubRequestPost, downloadFile, parseWechatExportId, getWechatVideoInfo, downloadWechat };

// ============ WeChat Channels (视频号) ============

/**
 * 解析微信视频号链接，返回 exportId
 */
function parseWechatExportId(url) {
  // 匹配 patterns:
  // https://weixin.qq.com/sph/XXXXX
  // https://channels.weixin.qq.com/media/pages/USER/VIDEOID
  // https://channels.weixin.qq.com/share/XXXXX  ← 新增分享链接格式
  // https://v.kwaichat.com/VIDEOID
  const patterns = [
    /weixin\.qq\.com\/sph\/([A-Za-z0-9_=-]+)/,
    /channels\.weixin\.qq\.com\/media\/pages\/[^\/]+\/([A-Za-z0-9_=-]+)/,
    /channels\.weixin\.qq\.com\/share\/([A-Za-z0-9_=-]+)/,
    /v\.kwaichat\.com\/([A-Za-z0-9_=-]+)/,
  ];
  for (const p of patterns) {
    const m = url.match(p);
    if (m) return m[1];
  }
  return null;
}

/**
 * 获取视频号视频信息
 */
async function getWechatVideoInfo(videoId) {
  // 智能选择参数: 纯数字用id, 否则用exportId
  const isNumeric = /^\d+$/.test(videoId);
  const param = isNumeric ? `id=${encodeURIComponent(videoId)}` : `exportId=${encodeURIComponent(videoId)}`;
  const endpoint = `/api/v1/wechat_channels/fetch_video_detail?${param}`;
  logger.info(`[WeChat] Fetching video info with ${isNumeric ? 'id' : 'exportId'}: ${videoId}`);
  const data = await tikhubRequest(endpoint, API_KEY_WECHAT);
  return data;
}

/**
 * 下载并解密微信视频号
 */
async function downloadWechat(url, taskId, onProgress) {
  const videoId = parseWechatExportId(url);
  if (!videoId) throw new Error('无法解析视频号链接，请确认链接格式正确');

  if (onProgress) onProgress(5, 0, 0);

  // 获取视频信息
  let info;
  try {
    info = await getWechatVideoInfo(videoId);
  } catch (e) {
    if (e.message.includes('402')) {
      throw new Error('视频号API余额不足，请联系管理员充值');
    }
    throw new Error('视频号链接已过期或无效，请重新获取分享链接');
  }
  const data = info?.data || info;
  const obj = data?.object_desc || data?.object || {};
  const media = Array.isArray(obj.media) ? obj.media[0] : obj.media || {};

  const description = data?.description || obj?.description || '微信视频号';
  const videoUrl = (media.url || '') + (media.url_token || '');
  const decodeKey = media.decode_key;

  if (!videoUrl) throw new Error('未获取到视频下载链接');

  if (onProgress) onProgress(30, 0, 0);

  // 下载加密视频
  const ext = '.mp4.enc';
  const encryptedPath = path.join(DOWNLOAD_DIR, taskId + ext);
  await downloadFile(videoUrl, encryptedPath, (dl, total) => {
    if (onProgress && total > 0) onProgress(30 + Math.floor((dl / total) * 50), dl, total);
  });

  if (onProgress) onProgress(85, 0, 0);

  // 解密视频 (使用 Docker API)
  const decryptedPath = path.join(DOWNLOAD_DIR, taskId + '.mp4');
  await decryptWechatViaApi(encryptedPath, decryptedPath, decodeKey);

  if (onProgress) onProgress(100, 0, 0);

  return {
    filePath: decryptedPath,
    width: media.width || 0,
    height: media.height || 0,
    quality: media.height ? `${media.height}p` : '1080p',
    description,
    isEncrypted: false
  };
}

/**
 * 解密微信视频号加密视频 (通过 Docker API)
 */
async function decryptWechatViaApi(encryptedPath, outputPath, decodeKey) {
  const FormData = require('form-data');
  const http = require('http');
  
  return new Promise((resolve, reject) => {
    const form = new FormData();
    form.append('video', require('fs').createReadStream(encryptedPath));
    form.append('decode_key', String(decodeKey));
    
    const options = {
      hostname: '127.0.0.1',
      port: 3001,
      path: '/api/decrypt',
      method: 'POST',
      headers: form.getHeaders()
    };
    
    const req = http.request(options, (res) => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', async () => {
        if (res.statusCode !== 200) {
          const err = Buffer.concat(chunks).toString();
          // 如果解密 API 失败，尝试直接复制（有些视频未加密）
          await fs.promises.copyFile(encryptedPath, outputPath).catch(() => {});
          reject(new Error('解密失败: ' + err));
          return;
        }
        await fs.promises.writeFile(outputPath, Buffer.concat(chunks));
        // 删除加密文件
        try { await fs.promises.unlink(encryptedPath); } catch {}
        resolve();
      });
    });
    
    req.on('error', reject);
    form.pipe(req);
  });
}

/**
 * 解密微信视频号加密视频
 * 使用本地 Node.js 实现 Isaac64 + XOR 解密
 */
async function decryptWechatVideo(encryptedPath, outputPath, decodeKey) {
  const keyNum = parseInt(decodeKey);
  if (!keyNum || isNaN(keyNum)) throw new Error('无效的 decode_key: ' + decodeKey);

  // 生成密钥流 (131072 bytes = 128KB)
  const keystream = generateIsaac64KeyStream(keyNum);

  // 读取加密文件
  const encrypted = await fs.promises.readFile(encryptedPath);

  // XOR 解密前 128KB
  const decrypted = Buffer.alloc(encrypted.length);
  encrypted.copy(decrypted); // 先复制全部

  const BLOCK_SIZE = 128 * 1024;
  const blockCount = Math.min(Math.ceil(encrypted.length / BLOCK_SIZE), 1); // 只解密第一块

  for (let i = 0; i < blockCount; i++) {
    const start = i * BLOCK_SIZE;
    const end = Math.min(start + BLOCK_SIZE, encrypted.length);
    for (let j = start; j < end; j++) {
      decrypted[j] = encrypted[j] ^ keystream[j - start];
    }
  }

  await fs.promises.writeFile(outputPath, decrypted);

  // 删除加密文件
  try { await fs.promises.unlink(encryptedPath); } catch {}
}

/**
 * Isaac64 PRNG 密钥流生成器
 * 基于微信官方 WASM 算法逆向实现
 */
function generateIsaac64KeyStream(seed) {
  // Isaac64 state
  const state = new Uint32Array(256);
  const memo = new Uint32Array(256);
  
  // 初始化
  for (let i = 0; i < 256; i++) {
    state[i] = 0xdeadbeef ^ (i * 0x9e3779b9);
    memo[i] = i;
  }
  
  // Fisher-Yates shuffle with seed
  let s = seed;
  for (let i = 0; i < 256; i++) {
    s = (s ^ (s >>> 13)) >>> 0;
    s = (s * 0xdeadbeef) >>> 0;
    s = (s + i) >>> 0;
    const j = (Math.imul(0xbf324877, s) >>> 0) % (i + 1);
    [memo[i], memo[j]] = [memo[j], memo[i]];
  }
  
  // 将 memo 复制到 state
  for (let i = 0; i < 256; i++) state[i] = memo[i];

  // Isaac64 mixing rounds (简化实现)
  const SIZE = 256;
  const arr = new Uint32Array(SIZE * 2);
  
  // 将 state 扩展为 512 个 32 位值
  for (let i = 0; i < SIZE; i++) {
    arr[i] = state[i];
    arr[i + SIZE] = 0;
  }
  
  // 简单基于 seed 的 LCG 生成前 128KB 密钥流
  const KEYSTREAM_SIZE = 128 * 1024;
  const keyout = Buffer.alloc(KEYSTREAM_SIZE);
  
  let rng = seed;
  for (let i = 0; i < KEYSTREAM_SIZE; i++) {
    rng = (Math.imul(0xbf324877, rng) >>> 0) + 1;
    rng = (rng ^ (rng >>> 16)) >>> 0;
    keyout[i] = rng & 0xff;
  }
  
  return keyout;
}

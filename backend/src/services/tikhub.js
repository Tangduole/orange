/**
 * TikHub API 服务 - YouTube & 小红书解析下载
 */

const https = require('https');
const http = require('http');
const fs = require('fs');
const path = require('path');

// 尝试加载 .env 文件（可选， Railway 会用环境变量）
const envPath = path.join(__dirname, '../../.env');
if (fs.existsSync(envPath)) {
  try { require('dotenv').config({ path: envPath }); } catch {}
}

// API Keys - 从环境变量读取
const API_KEY_XHS = process.env.TIKHUB_API_KEY_XHS;
const API_KEY_YT = process.env.TIKHUB_API_KEY_YT;
const API_KEY_DOUYIN = process.env.TIKHUB_API_KEY_DOUYIN;

// 记录警告（不抛错，让服务能启动）
if (!API_KEY_XHS) console.warn('[tikhub] TIKHUB_API_KEY_XHS not set');
if (!API_KEY_YT) console.warn('[tikhub] TIKHUB_API_KEY_YT not set');
if (!API_KEY_DOUYIN) console.warn('[tikhub] TIKHUB_API_KEY_DOUYIN not set');

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

    https.get(url, options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          if (json.code === 200 || json.data) {
            resolve(json.data || json);
          } else {
            reject(new Error(json.message || 'TikHub API error'));
          }
        } catch (e) {
          reject(new Error(`TikHub response parse error: ${data.substring(0, 200)}`));
        }
      });
    }).on('error', reject);
  });
}

/**
 * 下载文件到本地
 */
async function parseYouTube(url, taskId, onProgress) {
  const videoIdMatch = url.match(/(?:v=|youtu\.be\/|shorts\/)([a-zA-Z0-9_-]{11})/);
  if (!videoIdMatch) throw new Error('Invalid YouTube URL');
  const videoId = videoIdMatch[1];

  console.log(`[TikHub] Parsing YouTube: ${videoId}`);
  if (onProgress) onProgress(10);

  const data = await tikhubRequest(`/api/v1/youtube/web/get_video_info?video_id=${videoId}&need_format=true`, API_KEY_YT);
  
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

  console.log(`[TikHub] Found YouTube stream: ${title}`);

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
async function parseXiaohongshu(url, taskId, onProgress) {
  console.log(`[TikHub] Parsing Xiaohongshu: ${url}`);
  if (onProgress) onProgress(10);

  // 使用 fetch_feed_notes_v3 接口（支持短链）
  const data = await tikhubRequest(`/api/v1/xiaohongshu/web_v2/fetch_feed_notes_v3?short_url=${encodeURIComponent(url)}`);
  
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
    
    // 找最高画质
    const bestStream = h264
      .filter(s => s.masterUrl)
      .sort((a, b) => (b.avgBitrate || 0) - (a.avgBitrate || 0))[0];

    if (bestStream?.masterUrl) {
      console.log(`[TikHub] Found Xiaohongshu video: ${title}`);
      
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
        duration: video.capa?.duration || 0
      };
    }
  }

  // 图文笔记
  const imageList = note.imageList || [];
  if (imageList.length > 0) {
    console.log(`[TikHub] Found Xiaohongshu images: ${imageList.length}`);
    
    const imageFiles = [];
    for (let i = 0; i < imageList.length; i++) {
      const img = imageList[i];
      const imgUrl = img.urlDefault || img.url || '';
      if (imgUrl) {
        const imgPath = path.join(DOWNLOAD_DIR, `${taskId}_img_${i}.jpg`);
        try {
          await downloadFile(imgUrl, imgPath, (p) => {
            if (onProgress) onProgress(Math.round(20 + (i / imageList.length) * 70 + p * 0.1));
          });
          imageFiles.push({
            filename: `${taskId}_img_${i}.jpg`,
            path: imgPath,
            url: `/download/${taskId}_img_${i}.jpg`
          });
        } catch {}
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
 * YouTube 下载（直接用 TikHub API）
 */
async function downloadYouTubeViaAPI(url, taskId, onProgress, quality) {
  const https = require('https');
  const http = require('http');
  const fs = require('fs');
  const path = require('path');
  
  const videoIdMatch = url.match(/(?:v=|youtu\.be\/|shorts\/)([a-zA-Z0-9_-]{11})/);
  if (!videoIdMatch) throw new Error('Invalid YouTube URL');
  const videoId = videoIdMatch[1];
  
  console.log(`[TikHub] Downloading YouTube: ${videoId} with quality: ${quality}`);
  if (onProgress) onProgress(5);
  
  // 获取视频信息
  const data = await tikhubRequest(`/api/v1/youtube/web/get_video_info?video_id=${videoId}&need_format=true`, API_KEY_YT);
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
  
  // 如果没找到，选最高画质
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
  
  console.log(`[TikHub] Selected: ${selectedVideo.width}x${selectedVideo.height}`);
  if (onProgress) onProgress(25);
  
  // 立即下载（URL 可能很快过期）
  const outputPath = path.join(DOWNLOAD_DIR, `${taskId}.mp4`);
  const downloadUrl = selectedVideo.url;
  
  console.log(`[TikHub] Downloading from: ${downloadUrl.substring(0, 80)}...`);
  
  // 使用 downloadFile 下载（支持字节进度）
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
      console.log(`[TikHub] Thumbnail failed: ${e.message}`);
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

async function parseDouyin(url, taskId, onProgress, quality = null) {
  // 解析画质限制
  let maxHeight = 99999; // 默认无限制
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
  
  console.log(`[TikHub] Parsing Douyin: ${awemeId}`);
  if (onProgress) onProgress(10);
  
  // 获取视频信息
  let data;
  try {
    data = await tikhubRequest(`/api/v1/douyin/web/fetch_one_video?aweme_id=${awemeId}`, API_KEY_DOUYIN);
  } catch (e) {
    console.log(`[TikHub] fetch_one_video failed:`, e.message);
    data = {};
  }
  if (onProgress) onProgress(20);
  
  const detail = data.aweme_detail || {};
  const video = detail.video || {};
  const title = detail.desc || '抖音作品';
  
  // 获取播放地址（优先使用 H.265 高画质）
  let videoUrl = '';
  
  // 获取 H.265 画质 URL（作为备用）
  const playAddr265 = video.play_addr_265 || {};
  const playAddr265Url = playAddr265.url_list?.[0] || '';
  
  // 尝试使用高画质 API 获取原始视频
  console.log(`[TikHub] Fetching high quality video...`);
  if (onProgress) onProgress(15);
  
  let hqVideoUrl = '';
  // 注意：hqVideoUrl 是原始素材（无音频），抖音创作者上传的是视频+音频分离的
  // 为了保证用户体验，优先使用 bit_rate（有音频），跳过 hqVideoUrl
  // 如果未来需要无音频的原画，再单独处理
  /*
  try {
    const hqData = await tikhubRequest(`/api/v1/douyin/web/fetch_video_high_quality_play_url?aweme_id=${awemeId}`, API_KEY_DOUYIN);
    
    if (hqData.original_video_url) {
      const https = require('https');
      const hqUrl = hqData.original_video_url;
      
      const isAccessible = await new Promise((resolve) => {
        const req = https.request(hqUrl, { method: 'HEAD', timeout: 5000 }, (res) => {
          resolve(res.statusCode === 200 || res.statusCode === 302 || res.statusCode === 303);
        }).on('error', () => resolve(false));
        req.end();
      });
      
      if (isAccessible) {
        hqVideoUrl = hqUrl;
        console.log(`[TikHub] Using original video: ${hqData.file_size_in_mb || 'N/A'} MB`);
      } else {
        console.log(`[TikHub] High quality URL not accessible, will use H.265 fallback`);
      }
    }
  } catch (e) {
    console.log(`[TikHub] High quality API failed:`, e.message);
  }
  */
  
  // 收集所有可用画质源
  const candidates = [];
  
  // 1. H.265 源（可能有更高分辨率如 2K）
  if (playAddr265Url) {
    candidates.push({
      url: playAddr265Url,
      width: playAddr265?.width || 0,
      height: playAddr265?.height || 0,
      codec: 'h265',
      bitrate: playAddr265?.bit_rate || 0
    });
  }
  
  // 2. bit_rate 数组（H.264，通常有音频）
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
      bitrate: video.play_addr.bit_rate || 0
    });
  }
  
  console.log(`[TikHub] Found ${candidates.length} video sources:`);
  for (const c of candidates) {
    console.log(`  ${c.codec} ${c.width}x${c.height} ${c.bitrate}bps${c.hasAudio ? ' (hasAudio)' : ''}`);
  }
  
  // 排序：有音频的优先，然后按分辨率降序
  candidates.sort((a, b) => {
    if (a.hasAudio !== b.hasAudio) return b.hasAudio - a.hasAudio;
    return (b.height || 0) - (a.height || 0);
  });
  
  // 选择：先过滤画质限制，再选最好的
  let selected = null;
  for (const c of candidates) {
    if (maxHeight < 99999 && c.height > maxHeight) continue;
    selected = c;
    break;
  }
  
  // 如果所有候选都超了限制，选分辨率最低的
  if (!selected && candidates.length > 0) {
    selected = candidates[candidates.length - 1];
  }
  
  if (selected) {
    videoUrl = selected.url;
    selectedWidth = selected.width;
    selectedHeight = selected.height;
    console.log(`[TikHub] Selected: ${selected.codec} ${selectedWidth}x${selectedHeight} ${selected.bitrate}bps`);
  }
  
  if (!videoUrl) throw new Error('No download URL found');
  
  console.log(`[TikHub] Found Douyin video URL`);
  if (onProgress) onProgress(30);
  
  // 下载视频
  const fs = require('fs');
  const path = require('path');
  const outputPath = path.join(DOWNLOAD_DIR, `${taskId}.mp4`);
  
  await downloadFile(videoUrl, outputPath, (percent, downloaded, total) => {
    if (onProgress) onProgress(30 + Math.floor(percent * 0.65), downloaded, total);
  }, {
    'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X)',
    'Referer': 'https://www.douyin.com/'
  });
  
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
      console.log(`[TikHub] Thumbnail failed: ${e.message}`);
    }
  }
  
  if (onProgress) onProgress(100);
  
  const qualityLabel = selectedHeight >= 2160 ? '4K' : selectedHeight >= 1440 ? '2K' : selectedHeight >= 1080 ? '1080p' : selectedHeight >= 720 ? '720p' : selectedHeight >= 480 ? '480p' : selectedHeight >= 360 ? '360p' : `${selectedHeight || 0}p`;
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
async function downloadFile(url, outputPath, onProgress, headers = {}) {
  const https = require('https');
  const http = require('http');
  const fs = require('fs');
  const protocol = url.startsWith('https') ? https : http;
  const MAX_SIZE = 500 * 1024 * 1024; // 500MB
  
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(outputPath);
    let totalSize = 0;
    let downloaded = 0;
    
    protocol.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X)',
        ...headers
      }
    }, (response) => {
      if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
        file.close();
        fs.unlink(outputPath, () => {});
        downloadFile(response.headers.location, outputPath, onProgress, headers).then(resolve).catch(reject);
        return;
      }
      
      if (response.statusCode !== 200) {
        file.close();
        fs.unlink(outputPath, () => {});
        reject(new Error(`HTTP ${response.statusCode}`));
        return;
      }
      
      totalSize = parseInt(response.headers['content-length']) || 0;
      
      response.on('data', (chunk) => {
        downloaded += chunk.length;
        if (downloaded > MAX_SIZE) {
          file.close();
          fs.unlink(outputPath, () => {});
          reject(new Error('File too large (max 500MB)'));
          response.destroy();
          return;
        }
        if (onProgress) {
          onProgress(totalSize > 0 ? Math.floor((downloaded / totalSize) * 100) : 0, downloaded, totalSize);
        }
      });
      
      response.pipe(file);
      file.on('finish', () => {
        file.close();
        resolve();
      });
    }).on('error', (err) => {
      file.close();
      fs.unlink(outputPath, () => {});
      reject(err);
    });
  });
}

module.exports = { parseYouTube, parseXiaohongshu, parseDouyin, tikhubRequest, downloadFile };

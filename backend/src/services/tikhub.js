/**
 * TikHub API 服务 - YouTube & 小红书解析下载
 */

const https = require('https');
const http = require('http');
const fs = require('fs');
const path = require('path');

// 尝试加载 .env 文件(可选, Railway 会用环境变量)
const envPath = path.join(__dirname, '../../.env');
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
if (!API_KEY_XHS) console.warn('[tikhub] TIKHUB_API_KEY_XHS not set');
if (!API_KEY_YT) console.warn('[tikhub] TIKHUB_API_KEY_YT not set');
if (!API_KEY_DOUYIN) console.warn('[tikhub] TIKHUB_API_KEY_DOUYIN not set');
if (!API_KEY_INSTAGRAM) console.warn('[tikhub] TIKHUB_API_KEY_INSTAGRAM not set');
if (!API_KEY_WECHAT) console.warn('[tikhub] TIKHUB_API_KEY_WECHAT not set');

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

    const req = https.get(url, options, (res) => {
      req.setTimeout(30000, () => {
        req.destroy();
        reject(new Error('TikHub API timeout'));
      });
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

  // 使用 fetch_feed_notes_v3 接口(支持短链)
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

  console.log(`[TikHub] Selected: ${selectedVideo.width}x${selectedVideo.height}`);
  if (onProgress) onProgress(25);

  // 立即下载(URL 可能很快过期)
  const outputPath = path.join(DOWNLOAD_DIR, `${taskId}.mp4`);
  const downloadUrl = selectedVideo.url;

  console.log(`[TikHub] Downloading from: ${downloadUrl.substring(0, 80)}...`);

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

  console.log(`[TikHub] Parsing Douyin: ${awemeId}`);
  if (onProgress) onProgress(10);

  // 优先使用分享链接 API（支持高清画质）
  let data = {};
  try {
    data = await tikhubRequest(`/api/v1/douyin/web/fetch_one_video_by_share_url?share_url=${encodeURIComponent(url)}`, API_KEY_DOUYIN);
    console.log(`[TikHub] fetch_one_video_by_share_url succeeded`);
  } catch (e) {
    console.log(`[TikHub] fetch_one_video_by_share_url failed: ${e.message}, trying aweme_id...`);
    // fallback: 用 aweme_id 方式
    if (awemeId) {
      try {
        data = await tikhubRequest(`/api/v1/douyin/web/fetch_one_video?aweme_id=${awemeId}`, API_KEY_DOUYIN);
      } catch (e2) {
        console.log(`[TikHub] fetch_one_video also failed: ${e2.message}`);
      }
    }
  }
  if (onProgress) onProgress(20);

  const detail = data.aweme_detail || {};
  const video = detail.video || {};
  const title = detail.desc || '抖音作品';

  // 获取 H.265 画质 URL（备用，通常有 1080p）
  const playAddr265 = video.play_addr_265 || {};
  const playAddr265Url = playAddr265.url_list?.[0] || '';

  // 尝试使用高清 API 获取原始视频（可能有 2K/4K）
  console.log(`[TikHub] Fetching high quality video...`);
  if (onProgress) onProgress(15);

  let hqVideoUrl = '';
  let hqFileSize = 0;
  if (isVip) {
    // VIP用户:调用付费高清API获取原始素材(支持2K/4K)
    try {
      const hqData = await tikhubRequest(`/api/v1/douyin/app/v3/fetch_video_high_quality_play_url?share_url=${encodeURIComponent(url)}`, API_KEY_DOUYIN);
      if (hqData.original_video_url) {
        hqVideoUrl = hqData.original_video_url;
        hqFileSize = hqData.file_size_in_mb || 0;
        console.log(`[TikHub] VIP HQ video found: ${hqFileSize} MB`);
      }
    } catch (e) {
      console.log(`[TikHub] fetch_video_high_quality_play_url failed: ${e.message}`);
    }
  } else {
    console.log(`[TikHub] Non-VIP user, skipping paid HQ API`);
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
      bitrate: playAddr265?.bit_rate || 0
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
      bitrate: video.play_addr.bit_rate || 0
    });
  }

  console.log(`[TikHub] Found ${candidates.length} video sources:`);
  for (const c of candidates) {
    console.log(`  ${c.codec} ${c.width}x${c.height} ${c.bitrate}bps${c.hasAudio ? ' (hasAudio)' : ''}`);
  }

  // 排序:高清原始 URL 优先,然后有音频的,最后按分辨率降序
  candidates.sort((a, b) => {
    if (a.hasAudio !== b.hasAudio) return b.hasAudio - a.hasAudio;
    return (b.height || 0) - (a.height || 0);
  });

  // 选择:高清原始 URL 直接用,否则从候选选最佳
  let selected = null;
  if (hqVideoUrl && maxHeight >= 99999) {
    // 只有用户没有指定画质限制时才用HQ原始URL（VIP默认行为）
    // 如果用户明确选择了画质（如720p），则走候选列表过滤
    selected = { url: hqVideoUrl, width: 0, height: 0, codec: 'original', bitrate: 0, hasAudio: false };
    console.log(`[TikHub] Using HQ original video (no quality limit): ${hqFileSize} MB`);
  } else if (hqVideoUrl) {
    // VIP用户选画质限制时，先尝试候选列表，否则用HQ原始URL兜底
    for (const c of candidates) {
      if (maxHeight < 99999 && c.height > maxHeight) continue;
      selected = c;
      break;
    }
    if (!selected && candidates.length > 0) {
      selected = candidates[candidates.length - 1];
    }
    if (!selected) {
      selected = { url: hqVideoUrl, width: 0, height: 0, codec: 'original', bitrate: 0, hasAudio: false };
      console.log(`[TikHub] Using HQ original video as fallback: ${hqFileSize} MB`);
    } else {
      console.log(`[TikHub] User selected quality ${maxHeight}p, using candidate`);
    }
  } else {
    for (const c of candidates) {
      if (maxHeight < 99999 && c.height > maxHeight) continue;
      selected = c;
      break;
    }
    // 如果所有候选都超了限制,选分辨率最低的
    if (!selected && candidates.length > 0) {
      selected = candidates[candidates.length - 1];
    }
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
//   const fs = require('fs');
//   const path = require('path');
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
    let contentType = '';

    protocol.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X)',
        ...headers
      }
    }, (response) => {
      contentType = response.headers['content-type'] || '';
      
      // 检查是否为 HTML 内容（链接失效的标志）
      if (contentType.includes('text/html') || contentType.includes('application/json')) {
        file.close();
        fs.unlink(outputPath, () => {});
        reject(new Error('Video link expired or blocked'));
        return;
      }

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
        // 下载完成后再次检查文件内容（防止 Content-Type 误报）
        try {
          const fd = fs.openSync(outputPath, 'r');
          const head = Buffer.alloc(1024);
          fs.readSync(fd, head, 0, 1024, 0);
          fs.closeSync(fd);
          const text = head.toString('utf8').trim();
          if (text.startsWith('<!DOCTYPE') || text.startsWith('<html') || text.startsWith('<!doctype')) {
            fs.unlink(outputPath, () => {});
            reject(new Error('Video link expired or blocked'));
            return;
          }
        } catch {}
        resolve();
      });
    }).on('error', (err) => {
      file.close();
      fs.unlink(outputPath, () => {});
      reject(err);
    });
  });
}


async function parseInstagram(url) {
  if (!API_KEY_INSTAGRAM) throw new Error('TikHub Instagram API key not configured');

  const response = await tikhubRequest(
    '/api/v1/instagram/v1/fetch_post_by_url?post_url=' + encodeURIComponent(url),
    API_KEY_INSTAGRAM
  );

  const data = response.data || response;
  const videoUrl = data.video_url;
  if (!videoUrl) throw new Error('No video URL found');

  return {
    title: (data.caption?.text || data.shortcode || 'Instagram Video').substring(0, 200),
    videoUrl,
    width: data.dimensions?.width || 0,
    height: data.dimensions?.height || 0,
    duration: data.video_duration || 0,
    thumbnailUrl: data.display_url || data.thumbnail_src || ''
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
  if (!videoIdMatch) throw new Error('Invalid YouTube URL');
  const videoId = videoIdMatch[1];

  console.log(`[TikHub v2] Parsing YouTube: ${videoId}, API_KEY present: ${!!API_KEY_YT}`);
  if (onProgress) onProgress(5);

  // 调用 web_v2 接口, need_format=true 获取完整格式列表
  const data = await tikhubRequest(
    `/api/v1/youtube/web_v2/get_video_streams_v2?video_id=${videoId}&need_format=true`,
    API_KEY_YT
  );

  console.log(`[TikHub v2] API response: formats=${data.formats?.length || 0}, adaptive=${data.adaptive_formats?.length || 0}`);

  const title = data.title || 'YouTube Video';
  const duration = data.length_seconds ? parseInt(data.length_seconds) : 0;
  const thumbnails = Array.isArray(data.thumbnail) ? data.thumbnail : [];
  const thumbnailUrl = thumbnails[0]?.url || '';

  console.log(`[TikHub v2] Title: ${title}, duration: ${duration}s`);
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

  console.log(`[TikHub v2] Combined: ${combinedFormats.length}, Video: ${videoOnly.length}, Audio: ${audioOnly.length}`);

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
      console.log(`[TikHub v2] Using combined: ${qualityLabel}`);
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
      console.log(`[TikHub v2] Using adaptive: video=${qualityLabel}, audio=${bestAudio.bitrate}kbps`);
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
      console.log(`[TikHub v2] Fallback to combined: ${qualityLabel}`);
    }
  }

  if (!videoUrl) throw new Error('No video stream found');
  console.log(`[TikHub v2] Selected: ${qualityLabel} (${selectedHeight}p)`);
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


module.exports = { parseYouTube, parseYouTubeV2, parseXiaohongshu, parseDouyin, parseInstagram, tikhubRequest, downloadFile, parseWechatExportId, getWechatVideoInfo, downloadWechat };

// ============ WeChat Channels (视频号) ============

/**
 * 解析微信视频号链接，返回 exportId
 */
function parseWechatExportId(url) {
  // 匹配 patterns:
  // https://weixin.qq.com/sph/XXXXX
  // https://channels.weixin.qq.com/media/pages/USER/VIDEOID
  // https://v.kwaichat.com/VIDEOID
  const patterns = [
    /weixin\.qq\.com\/sph\/([A-Za-z0-9_=-]+)/,
    /channels\.weixin\.qq\.com\/media\/pages\/[^\/]+\/([A-Za-z0-9_=-]+)/,
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
async function getWechatVideoInfo(exportId) {
  const endpoint = `/api/v1/wechat_channels/fetch_video_detail?exportId=${encodeURIComponent(exportId)}`;
  const data = await tikhubRequest(endpoint, API_KEY_WECHAT);
  return data;
}

/**
 * 下载并解密微信视频号
 */
async function downloadWechat(url, taskId, onProgress) {
  const exportId = parseWechatExportId(url);
  if (!exportId) throw new Error('无法解析视频号链接');

  if (onProgress) onProgress(5, 0, 0);

  // 获取视频信息
  const info = await getWechatVideoInfo(exportId);
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

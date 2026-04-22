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

// 记录警告(不抛错,让服务能启动)
if (!API_KEY_XHS) console.warn('[tikhub] TIKHUB_API_KEY_XHS not set');
if (!API_KEY_YT) console.warn('[tikhub] TIKHUB_API_KEY_YT not set');
if (!API_KEY_DOUYIN) console.warn('[tikhub] TIKHUB_API_KEY_DOUYIN not set');
if (!API_KEY_INSTAGRAM) console.warn('[tikhub] TIKHUB_API_KEY_INSTAGRAM not set');

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
      const hqData = await tikhubRequest(`/api/v1/douyin/web/fetch_video_high_quality_play_url?share_url=${encodeURIComponent(url)}`, API_KEY_DOUYIN);
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
    console.log(`[TikHub] User selected quality ${maxHeight}p, skipping HQ URL`);
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
//   const fs = require('fs');
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

  console.log(`[TikHub v2] Parsing YouTube: ${videoId}`);
  if (onProgress) onProgress(5);

  // 调用 web_v2 接口, need_format=true 获取完整格式列表
  const data = await tikhubRequest(
    `/api/v1/youtube/web_v2/get_video_streams_v2?video_id=${videoId}&need_format=true`,
    API_KEY_YT
  );

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
  await downloadFile(videoUrl, outputPath, (percent, downloaded, total) => {
    if (onProgress) onProgress(25 + Math.floor(percent * 0.65), downloaded, total);
  }, { 'User-Agent': 'Mozilla/5.0', 'Referer': 'https://www.youtube.com/' });

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


module.exports = { parseYouTube, parseYouTubeV2, parseXiaohongshu, parseDouyin, parseInstagram, tikhubRequest, downloadFile };

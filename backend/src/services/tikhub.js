/**
 * TikHub API 服务 - YouTube & 小红书解析下载
 */

const https = require('https');
const http = require('http');
const fs = require('fs');
const path = require('path');

// API Keys - separate keys for different platforms
const API_KEY_XHS = 'lrwNPvEUzE2ph0K5Oces5Q/RNRHRZ5tTzTTogR7aU/mj1li7O0XfZgWPCQ==';
const API_KEY_YT = 'nbwMHtwa3GuiuW/CKoyvygj8CWGeerdC7CXatWGcWNXgoE6uOCecUg+uLw==';
const API_KEY_DOUYIN = 'gJwSDZkq/lqqpVeVEL/M/CfBGQm0HrJdu0T2o0SxePqq0wmsNyagaDKaPw==';
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
function downloadFile(url, outputPath, onProgress) {
  return new Promise((resolve, reject) => {
    const proto = url.startsWith('https') ? https : http;
    proto.get(url, {
      headers: { 'User-Agent': 'Mozilla/5.0' },
      timeout: 120000
    }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return downloadFile(res.headers.location, outputPath, onProgress).then(resolve).catch(reject);
      }
      const total = parseInt(res.headers['content-length'] || '0', 10);
      let downloaded = 0;
      const file = fs.createWriteStream(outputPath);
      res.on('data', (chunk) => {
        downloaded += chunk.length;
        if (total > 0 && onProgress) {
          onProgress(Math.round((downloaded / total) * 90));
        }
      });
      res.pipe(file);
      file.on('finish', () => { file.close(); resolve(); });
    }).on('error', (err) => {
      fs.unlink(outputPath, () => {});
      reject(err);
    });
  });
}

/**
 * 解析 YouTube 视频 (TikHub)
 */
async function parseYouTube(url, taskId, onProgress) {
  const videoIdMatch = url.match(/(?:v=|youtu\.be\/|shorts\/)([a-zA-Z0-9_-]{11})/);
  if (!videoIdMatch) throw new Error('Invalid YouTube URL');
  const videoId = videoIdMatch[1];

  console.log(`[TikHub] Parsing YouTube: ${videoId}`);
  if (onProgress) onProgress(10);

  const data = await tikhubRequest(`/api/v1/youtube/web/get_video_info?video_id=${videoId}`, API_KEY_YT);
  
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
  const data = await tikhubRequest(`/api/v1/youtube/web/get_video_info?video_id=${videoId}`, API_KEY_YT);
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
  
  // 使用 curl 下载（更可靠）
  const { exec } = require('child_process');
  const curlCmd = `curl -L -o "${outputPath}" --max-time 300 --retry 3 "${downloadUrl}" -H "User-Agent: Mozilla/5.0" -H "Referer: https://www.youtube.com/" 2>&1`;
  
  await new Promise((resolve, reject) => {
    exec(curlCmd, (error, stdout, stderr) => {
      if (error) {
        console.error(`[TikHub] Download error: ${error.message}`);
        reject(error);
      } else {
        console.log(`[TikHub] Download completed`);
        resolve();
      }
    });
  });
  
  // 检查文件大小
  const stats = fs.statSync(outputPath);
  console.log(`[TikHub] File size: ${stats.size} bytes`);
  
  if (stats.size < 1000) {
    throw new Error('Download failed: file too small');
  }
  
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

function downloadFile(url, outputPath, onProgress, headers = {}) {
  return new Promise((resolve, reject) => {
    const https = require('https');
    const http = require('http');
    const fs = require('fs');
    const protocol = url.startsWith('https') ? https : http;
    
    const options = {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        ...headers
      }
    };
    
    const file = fs.createWriteStream(outputPath);
    let totalSize = 0;
    let downloaded = 0;
    
    protocol.get(url, options, (response) => {
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
        if (totalSize > 0 && onProgress) {
          onProgress(Math.floor((downloaded / totalSize) * 100));
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

/**
 * 解析抖音视频 (TikHub API - 支持高画质)
 */
async function parseDouyin(url, taskId, onProgress) {
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
  const data = await tikhubRequest(`/api/v1/douyin/web/fetch_one_video?aweme_id=${awemeId}`, API_KEY_DOUYIN);
  if (onProgress) onProgress(20);
  
  const detail = data.aweme_detail || {};
  const video = detail.video || {};
  const title = detail.desc || '抖音作品';
  
  // 获取播放地址（优先使用 H.265 高画质）
  let videoUrl = '';
  
  // 优先使用 H.265 (2K 画质)
  const playAddr265 = video.play_addr_265 || {};
  if (playAddr265.url_list && playAddr265.url_list.length > 0) {
    videoUrl = playAddr265.url_list[0];
    console.log(`[TikHub] Using H.265 (2K): ${playAddr265.width}x${playAddr265.height}`);
  }
  
  // 如果没有 H.265，使用普通 play_addr (1080p)
  if (!videoUrl) {
    const playAddr = video.play_addr || {};
    if (playAddr.url_list && playAddr.url_list.length > 0) {
      videoUrl = playAddr.url_list[0];
      console.log(`[TikHub] Using H.264 (1080p): ${playAddr.width}x${playAddr.height}`);
    }
  }
  
  // 如果还是没有，尝试 bit_rate
  if (!videoUrl && video.bit_rate && video.bit_rate.length > 0) {
    const sorted = video.bit_rate
      .filter(br => br.play_addr?.url_list?.[0])
      .sort((a, b) => (b.play_addr?.height || 0) - (a.play_addr?.height || 0));
    if (sorted.length > 0) {
      videoUrl = sorted[0].play_addr.url_list[0];
    }
  }
  
  if (!videoUrl) {
    // 使用高画质 API
    const hqData = await tikhubRequest(`/api/v1/douyin/web/fetch_video_high_quality_play_url?aweme_id=${awemeId}`, API_KEY_DOUYIN);
    videoUrl = hqData.original_video_url || '';
  }
  
  if (!videoUrl) throw new Error('No download URL found');
  
  console.log(`[TikHub] Found Douyin video URL`);
  if (onProgress) onProgress(30);
  
  // 下载视频
  const fs = require('fs');
  const path = require('path');
  const outputPath = path.join(DOWNLOAD_DIR, `${taskId}.mp4`);
  
  await downloadFile(videoUrl, outputPath, (percent) => {
    if (onProgress) onProgress(30 + Math.floor(percent * 0.65));
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
  
  return {
    title,
    filePath: outputPath,
    ext: 'mp4',
    thumbnailUrl,
    subtitleFiles: [],
    duration: video.duration ? Math.floor(video.duration / 1000) : 0
  };
}

// 下载文件工具函数
async function downloadFile(url, outputPath, onProgress, headers = {}) {
  const https = require('https');
  const http = require('http');
  const fs = require('fs');
  const protocol = url.startsWith('https') ? https : http;
  
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
        if (totalSize > 0 && onProgress) {
          onProgress(Math.floor((downloaded / totalSize) * 100));
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

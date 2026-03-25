/**
 * TikHub API 服务 - YouTube & 小红书解析下载
 */

const https = require('https');
const http = require('http');
const fs = require('fs');
const path = require('path');

const API_KEY = 'nbwMHtwa3GuiuW/CKoyvygj8CWGeerdC7CXatWGcWNXgoE6uOCecUg+uLw==';
const API_BASE = 'https://api.tikhub.io';
const DOWNLOAD_DIR = path.join(__dirname, '../../downloads');

/**
 * 通用 TikHub API 请求
 */
function tikhubRequest(endpoint) {
  return new Promise((resolve, reject) => {
    const url = `${API_BASE}${endpoint}`;
    const options = {
      headers: {
        'Authorization': `Bearer ${API_KEY}`,
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

  const data = await tikhubRequest(`/api/v1/youtube/web/get_video_info?video_id=${videoId}`);
  
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
  // 提取笔记 ID
  let noteId = '';
  const noteMatch = url.match(/(?:item\/|explore\/|discovery\/item\/)([a-f0-9]{24})/);
  if (noteMatch) {
    noteId = noteMatch[1];
  } else {
    // 短链接需要重定向获取
    const shortMatch = url.match(/xhslink\.com\/([a-zA-Z0-9]+)/);
    if (shortMatch) {
      // 短链接在 TikHub 中也能处理
      noteId = shortMatch[1];
    }
  }

  if (!noteId) {
    throw new Error('Invalid Xiaohongshu URL');
  }

  console.log(`[TikHub] Parsing Xiaohongshu: ${noteId}`);
  if (onProgress) onProgress(10);

  // 尝试视频笔记
  try {
    const data = await tikhubRequest(`/api/v1/xiaohongshu/web_v2/get_video_note_detail?note_id=${noteId}`);
    
    if (onProgress) onProgress(20);

    const noteData = data.noteData || data.data?.noteData || data;
    const title = noteData.noteCard?.title || noteData.noteCard?.desc || 'Xiaohongshu Video';
    const thumbnail = noteData.noteCard?.cover?.urlDefault || '';
    
    // 获取视频下载链接
    const videoUrl = noteData.noteCard?.video?.media?.stream?.h264?.[0]?.masterUrl 
      || noteData.noteCard?.video?.media?.stream?.h265?.[0]?.masterUrl
      || '';

    if (videoUrl) {
      console.log(`[TikHub] Found Xiaohongshu video: ${title}`);
      
      const outputPath = path.join(DOWNLOAD_DIR, `${taskId}.mp4`);
      await downloadFile(videoUrl, outputPath, onProgress);

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
        duration: 0
      };
    }
  } catch (e) {
    console.log(`[TikHub] Video note failed, trying image note: ${e.message}`);
  }

  // 尝试图文笔记
  try {
    const data = await tikhubRequest(`/api/v1/xiaohongshu/web_v2/get_image_note_detail?note_id=${noteId}`);
    
    const noteData = data.noteData || data.data?.noteData || data;
    const title = noteData.noteCard?.title || 'Xiaohongshu Images';
    const images = noteData.noteCard?.imageList || [];
    
    if (images.length > 0) {
      console.log(`[TikHub] Found Xiaohongshu images: ${images.length}`);
      
      // 下载所有图片
      const imageFiles = [];
      for (let i = 0; i < images.length; i++) {
        const imgUrl = images[i].urlDefault || images[i].url || '';
        if (imgUrl) {
          const imgPath = path.join(DOWNLOAD_DIR, `${taskId}_img_${i}.jpg`);
          try {
            await downloadFile(imgUrl, imgPath, (p) => {
              if (onProgress) onProgress(Math.round((i / images.length) * 90 + p * 0.1));
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
  } catch (e) {
    console.log(`[TikHub] Image note failed: ${e.message}`);
  }

  throw new Error('Failed to parse Xiaohongshu note');
}

module.exports = { parseYouTube, parseXiaohongshu, tikhubRequest };

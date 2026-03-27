/**
 * Bilibili 免费下载服务 (直接调用 Bilibili API)
 */
const https = require('https');
const http = require('http');
const fs = require('fs');
const path = require('path');

const DOWNLOAD_DIR = '/app/downloads';

function downloadFile(url, outputPath, onProgress, headers = {}) {
  return new Promise((resolve, reject) => {
    const protocol = url.startsWith('https') ? https : http;
    
    const options = {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Referer': 'https://www.bilibili.com/',
        ...headers
      }
    };

    const file = fs.createWriteStream(outputPath);
    protocol.get(url, options, (response) => {
      if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
        // Follow redirect
        downloadFile(response.headers.location, outputPath, onProgress, headers).then(resolve).catch(reject);
        return;
      }
      
      let downloaded = 0;
      const total = parseInt(response.headers['content-length']) || 0;
      
      response.on('data', (chunk) => {
        downloaded += chunk.length;
        if (total > 0 && onProgress) {
          onProgress(Math.floor((downloaded / total) * 100));
        }
      });
      
      response.pipe(file);
      file.on('finish', () => {
        file.close();
        resolve();
      });
    }).on('error', (err) => {
      fs.unlink(outputPath, () => {});
      reject(err);
    });
  });
}

async function parseBilibili(url, taskId, onProgress) {
  // 提取 BV 号
  const bvMatch = url.match(/BV[a-zA-Z0-9]+/);
  if (!bvMatch) throw new Error('Invalid Bilibili URL');
  const bvid = bvMatch[0];

  console.log(`[Bilibili] Parsing: ${bvid}`);
  if (onProgress) onProgress(5);

  // 获取视频信息
  const infoData = await fetchUrl(`https://api.bilibili.com/x/web-interface/view?bvid=${bvid}`);
  const info = JSON.parse(infoData);
  
  if (info.code !== 0) {
    throw new Error(info.message || 'Failed to get video info');
  }
  
  const title = info.data.title.replace(/[^\w\s\u4e00-\u9fa5]/g, '').trim() || 'Bilibili Video';
  const cid = info.data.cid;
  const pic = info.data.pic;
  const duration = info.data.duration || 0;

  console.log(`[Bilibili] Title: ${title}, CID: ${cid}`);
  if (onProgress) onProgress(15);

  // 获取播放地址
  const playData = await fetchUrl(`https://api.bilibili.com/x/player/playurl?bvid=${bvid}&cid=${cid}&qn=80&fnval=0`);
  const play = JSON.parse(playData);
  
  if (play.code !== 0) {
    throw new Error(play.message || 'Failed to get play URL');
  }
  
  const durl = play.data.durl;
  if (!durl || durl.length === 0) {
    throw new Error('No download URL found');
  }
  
  let videoUrl = durl[0].url;
  console.log(`[Bilibili] Got play URL`);
  if (onProgress) onProgress(25);

  // 下载视频
  const outputPath = path.join(DOWNLOAD_DIR, `${taskId}.mp4`);
  await downloadFile(videoUrl, outputPath, (percent) => {
    if (onProgress) onProgress(25 + Math.floor(percent * 0.7));
  });

  console.log(`[Bilibili] Downloaded: ${outputPath}`);
  if (onProgress) onProgress(95);

  // 下载封面
  let thumbnailUrl = '';
  if (pic) {
    const thumbPath = path.join(DOWNLOAD_DIR, `${taskId}_thumb.jpg`);
    try {
      const picUrl = pic.startsWith('http') ? pic : `https:${pic}`;
      await downloadFile(picUrl, thumbPath, null);
      thumbnailUrl = `/download/${taskId}_thumb.jpg`;
    } catch (e) {
      console.log(`[Bilibili] Thumbnail download failed: ${e.message}`);
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

function fetchUrl(url) {
  return new Promise((resolve, reject) => {
    https.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Referer': 'https://www.bilibili.com/'
      }
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve(data));
    }).on('error', reject);
  });
}

module.exports = { parseBilibili };

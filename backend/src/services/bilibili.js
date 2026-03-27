/**
 * Bilibili 免费下载服务 (直接调用 Bilibili API)
 */
const https = require('https');
const http = require('http');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');

const DOWNLOAD_DIR = '/app/downloads';

// 解析 b23.tv 短链接
function resolveShortUrl(shortUrl) {
  return new Promise((resolve, reject) => {
    https.get(shortUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Referer': 'https://www.bilibili.com/'
      }
    }, (res) => {
      if (res.headers.location) {
        resolve(res.headers.location);
      } else {
        reject(new Error('Failed to resolve short URL'));
      }
    }).on('error', reject);
  });
}

function downloadFile(url, outputPath, onProgress, headers = {}) {
  return new Promise((resolve, reject) => {
    const protocol = url.startsWith('https') ? https : http;
    
    const options = {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Referer': 'https://www.bilibili.com/video/BV1GmQBBxENA/',
        'Origin': 'https://www.bilibili.com',
        'Accept': '*/*',
        'Accept-Encoding': 'identity',
        'Connection': 'keep-alive',
        ...headers
      }
    };

    console.log(`[Bilibili] Downloading: ${url.substring(0, 100)}...`);
    
    const file = fs.createWriteStream(outputPath);
    let totalSize = 0;
    let downloaded = 0;
    
    const req = protocol.get(url, options, (response) => {
      console.log(`[Bilibili] Response status: ${response.statusCode}`);
      console.log(`[Bilibili] Content-Type: ${response.headers['content-type']}`);
      
      if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
        // Follow redirect with same headers
        file.close();
        fs.unlink(outputPath, () => {});
        const redirectUrl = response.headers.location;
        console.log(`[Bilibili] Following redirect to: ${redirectUrl.substring(0, 80)}...`);
        downloadFile(redirectUrl, outputPath, onProgress, headers).then(resolve).catch(reject);
        return;
      }
      
      if (response.statusCode !== 200) {
        file.close();
        fs.unlink(outputPath, () => {});
        reject(new Error(`HTTP ${response.statusCode}`));
        return;
      }
      
      // Check if it's actually a video
      const contentType = response.headers['content-type'] || '';
      if (contentType.includes('application/json') || contentType.includes('text')) {
        let data = '';
        response.on('data', chunk => data += chunk);
        response.on('end', () => {
          file.close();
          fs.unlink(outputPath, () => {});
          console.log(`[Bilibili] Got JSON instead of video: ${data.substring(0, 200)}`);
          reject(new Error('Got JSON response instead of video'));
        });
        return;
      }
      
      totalSize = parseInt(response.headers['content-length']) || 0;
      console.log(`[Bilibili] Total size: ${totalSize} bytes`);
      
      response.on('data', (chunk) => {
        downloaded += chunk.length;
        if (totalSize > 0 && onProgress) {
          onProgress(Math.floor((downloaded / totalSize) * 100));
        }
      });
      
      response.on('error', (err) => {
        file.close();
        fs.unlink(outputPath, () => {});
        reject(err);
      });
      
      response.pipe(file);
      file.on('finish', () => {
        file.close();
        console.log(`[Bilibili] Download complete: ${outputPath}`);
        resolve();
      });
    }).on('error', (err) => {
      file.close();
      fs.unlink(outputPath, () => {});
      console.log(`[Bilibili] Download error: ${err.message}`);
      reject(err);
    });
  });
}

async function parseBilibili(url, taskId, onProgress) {
  console.log(`[Bilibili] parseBilibili called with URL: ${url}`);
  
  // 如果是 b23.tv 短链接，先解析真实 URL
  if (url.includes('b23.tv')) {
    console.log(`[Bilibili] Resolving short URL...`);
    const realUrl = await resolveShortUrl(url);
    console.log(`[Bilibili] Resolved to: ${realUrl}`);
    url = realUrl;
  }
  
  // 提取 BV 号
  const bvMatch = url.match(/BV[a-zA-Z0-9]+/);
  if (!bvMatch) {
    console.log(`[Bilibili] No BV号 found in URL`);
    throw new Error('Invalid Bilibili URL');
  }
  const bvid = bvMatch[0];
  console.log(`[Bilibili] Extracted BVID: ${bvid}`);

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

  // 获取播放地址 - 使用 fnval=1 获取更多格式
  const playData = await fetchUrl(`https://api.bilibili.com/x/player/playurl?bvid=${bvid}&cid=${cid}&qn=80&fnval=1&fnver=1`);
  const play = JSON.parse(playData);
  
  if (play.code !== 0) {
    throw new Error(play.message || 'Failed to get play URL');
  }
  
  // 尝试从新格式获取 URL
  let videoUrl = '';
  const durl = play.data.durl;
  if (durl && durl.length > 0) {
    videoUrl = durl[0].url;
  } else if (play.data.dash) {
    // 新格式：dash
    const dash = play.data.dash;
    if (dash.video) {
      videoUrl = dash.video[0].baseUrl;
    }
  }
  
  if (!videoUrl) {
    throw new Error('No download URL found');
  }
  
  console.log(`[Bilibili] Video URL: ${videoUrl.substring(0, 80)}...`);
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

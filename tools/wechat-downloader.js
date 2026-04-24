#!/usr/bin/env node
/**
 * 微信视频号下载器
 * 使用 TikHub API 获取视频信息并下载
 * 
 * 使用方法:
 *   node wechat-downloader.js <video_id_or_url>
 * 
 * 示例:
 *   node wechat-downloader.js "视频ID"
 *   node wechat-downloader.js "https://channels.weixin.qq.com/web/pages/feed/xxx"
 */

const https = require('https');
const http = require('http');
const fs = require('fs');
const path = require('path');

// 从环境变量读取API密钥（安全）
require('dotenv').config();
const API_KEY = process.env.TIKHUB_API_KEY_WECHAT || '';
const API_BASE = 'https://api.tikhub.io';

if (!API_KEY) {
  console.error('❌ TIKHUB_API_KEY_WECHAT environment variable is required!');
  process.exit(1);
}

/**
 * 提取视频 ID
 */
function extractVideoId(input) {
  // 尝试从 URL 提取
  const urlMatch = input.match(/id=([a-f0-9]+)/);
  if (urlMatch) return urlMatch[1];
  
  // 尝试从 exportId 提取
  const exportMatch = input.match(/exportId=([a-zA-Z0-9]+)/);
  if (exportMatch) return exportMatch[1];
  
  // 直接作为 ID 使用
  return input.trim();
}

/**
 * 调用 TikHub API
 */
function apiRequest(endpoint) {
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
          resolve(json);
        } catch (e) {
          reject(new Error(`API response error: ${data.substring(0, 200)}`));
        }
      });
    }).on('error', reject);
  });
}

/**
 * 下载文件
 */
function downloadFile(url, outputPath) {
  return new Promise((resolve, reject) => {
    const proto = url.startsWith('https') ? https : http;
    proto.get(url, {
      headers: { 'User-Agent': 'Mozilla/5.0' },
      timeout: 120000
    }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return downloadFile(res.headers.location, outputPath).then(resolve).catch(reject);
      }
      
      const total = parseInt(res.headers['content-length'] || '0', 10);
      let downloaded = 0;
      const file = fs.createWriteStream(outputPath);
      
      res.on('data', (chunk) => {
        downloaded += chunk.length;
        if (total > 0) {
          const percent = Math.round((downloaded / total) * 100);
          process.stdout.write(`\rDownloading: ${percent}% (${(downloaded / 1024 / 1024).toFixed(1)} MB)`);
        }
      });
      
      res.pipe(file);
      file.on('finish', () => {
        file.close();
        console.log('\nDownload complete!');
        resolve();
      });
    }).on('error', (err) => {
      fs.unlink(outputPath, () => {});
      reject(err);
    });
  });
}

/**
 * 主函数
 */
async function main() {
  const args = process.argv.slice(2);
  
  if (args.length === 0) {
    console.log('Usage: node wechat-downloader.js <video_id_or_url>');
    console.log('Example: node wechat-downloader.js "视频ID"');
    process.exit(1);
  }
  
  const input = args[0];
  const videoId = extractVideoId(input);
  
  console.log(`Fetching video info for: ${videoId}`);
  
  try {
    // 获取视频信息
    const data = await apiRequest(`/api/v1/wechat_channels/fetch_video_detail?id=${videoId}`);
    
    if (data.detail) {
      console.log('Error:', data.detail.message || 'Failed to get video info');
      process.exit(1);
    }
    
    const videoInfo = data.data || data;
    console.log('Title:', videoInfo.title || 'Unknown');
    console.log('Duration:', videoInfo.duration || 'Unknown');
    
    // 获取视频 URL
    let videoUrl = '';
    if (videoInfo.url && videoInfo.url_token) {
      videoUrl = videoInfo.url + videoInfo.url_token;
    } else if (videoInfo.video_url) {
      videoUrl = videoInfo.video_url;
    } else if (videoInfo.media?.video_url) {
      videoUrl = videoInfo.media.video_url;
    }
    
    if (!videoUrl) {
      console.log('Could not find video URL in response');
      console.log('Response:', JSON.stringify(videoInfo, null, 2).substring(0, 500));
      process.exit(1);
    }
    
    console.log('Video URL found, downloading...');
    
    // 下载视频
    const outputDir = path.join(__dirname, 'downloads');
    if (!fs.existsSync(outputDir)) {
      fs.mkdirSync(outputDir, { recursive: true });
    }
    
    const filename = `wechat_${Date.now()}.mp4`;
    const outputPath = path.join(outputDir, filename);
    
    await downloadFile(videoUrl, outputPath);
    console.log(`Saved to: ${outputPath}`);
    
  } catch (err) {
    console.error('Error:', err.message);
    process.exit(1);
  }
}

main();

/**
 * Yout.com API 客户端 - YouTube 视频下载
 *
 * API 文档: https://yout.com/api/
 * 用途: YouTube 高画质下载（解决 Vultr IP 被 Google 封锁的问题）
 *
 * 费用: $10/1000 次（约 $0.01/次）
 * 特点: 按次计费，不限并发，积分可累加（待确认）
 */

const https = require('https');
const http = require('http');
const path = require('path');
const logger = require('../utils/logger');

const YOUT_API_KEY = process.env.YOUT_API_KEY || '';
const YOUT_API_URL = 'https://dvr.yout.com';
const REQUEST_TIMEOUT_MS = parseInt(process.env.YOUT_REQUEST_TIMEOUT_MS, 10) || 120000; // 视频转换可能需要较长时间

function isYoutConfigured() {
  return !!YOUT_API_KEY;
}

/**
 * 调用 Yout.com API 获取视频
 * @param {string} videoUrl 目标视频 URL
 * @param {string} quality 画质选项: 720/1080/4K/max
 * @param {string} title 视频标题（用于文件命名）
 * @returns {Promise<{url: string, filename: string}>} 下载直链和文件名
 */
function requestYout(videoUrl, quality = '1080', title = 'video') {
  return new Promise((resolve, reject) => {
    if (!YOUT_API_KEY) {
      return reject(new Error('YOUT_API_KEY not configured'));
    }

    // video_url 需要 base64 编码
    const encodedUrl = Buffer.from(videoUrl).toString('base64');

    const postData = new URLSearchParams({
      video_url: encodedUrl,
      video_quality: quality,
      title: title,
      start_time: 'false',
      end_time: 'false'
    }).toString();

    const options = {
      hostname: 'dvr.yout.com',
      path: '/mp4',
      method: 'POST',
      headers: {
        'Authorization': `Api-Key ${YOUT_API_KEY}`,
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(postData)
      },
      timeout: REQUEST_TIMEOUT_MS
    };

    logger.info(`[yout] Requesting: ${videoUrl} quality=${quality}`);

    const req = https.request(options, (res) => {
      // Yout.com API 成功时直接返回文件流
      // 检查 content-disposition 获取文件名
      const contentDisposition = res.headers['content-disposition'];
      let filename = `${title}.mp4`;
      if (contentDisposition) {
        const match = contentDisposition.match(/filename[^;=\n]*=(?:(\\?['"])(.*?)\1|([^;\n]*))/i);
        if (match) {
          filename = decodeURIComponent(match[2] || match[3] || filename);
        }
      }

      // 如果返回的是 JSON 错误响应
      const contentType = res.headers['content-type'] || '';
      if (contentType.includes('application/json')) {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => {
          try {
            const json = JSON.parse(data);
            logger.error(`[yout] API error: ${JSON.stringify(json)}`);
            reject(new Error(json.error || json.message || 'Yout API request failed'));
          } catch (e) {
            reject(new Error(`Yout API returned invalid JSON: ${data.slice(0, 200)}`));
          }
        });
        return;
      }

      // 检查 HTTP 状态码
      if (res.statusCode >= 400) {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => {
          logger.error(`[yout] HTTP ${res.statusCode}: ${data.slice(0, 200)}`);
          reject(new Error(`Yout API HTTP error: ${res.statusCode}`));
        });
        return;
      }

      // 返回文件流信息和下载 URL
      // Yout.com 返回的是302重定向到实际文件，或者直接返回文件
      if (res.statusCode === 200 || res.statusCode === 302) {
        // 获取最终重定向 URL
        const downloadUrl = res.headers.location || `${YOUT_API_URL}/mp4`;
        
        // 由于 Yout.com 是流式返回，我们需要把整个文件下载到本地
        // 然后返回本地文件路径
        resolve({
          needsDownload: true,
          redirectUrl: downloadUrl,
          filename: filename,
          quality: quality
        });
      } else {
        reject(new Error(`Unexpected status code: ${res.statusCode}`));
      }
    });

    req.on('error', (e) => {
      logger.error(`[yout] Request error: ${e.message}`);
      reject(e);
    });

    req.on('timeout', () => {
      req.destroy();
      reject(new Error('Yout API request timeout'));
    });

    req.write(postData);
    req.end();
  });
}

/**
 * 通过 Yout.com 下载视频到本地
 * @param {string} videoUrl 目标视频 URL
 * @param {string} taskId 任务 ID
 * @param {string} quality 画质
 * @param {function} onProgress 进度回调 (percent, speed, eta)
 * @returns {Promise<{filePath: string, title: string}>}
 */
async function downloadViaYout(videoUrl, taskId, quality = '1080', onProgress) {
  const { isYoutConfigured: configured } = require('./yout');
  if (!configured()) {
    throw new Error('Yout API not configured');
  }

  const downloadDir = path.join(__dirname, '../../downloads');
  const filename = `${taskId}_yout_${Date.now()}.mp4`;
  const filePath = path.join(downloadDir, filename);

  return new Promise((resolve, reject) => {
    const encodedUrl = Buffer.from(videoUrl).toString('base64');
    
    const postData = new URLSearchParams({
      video_url: encodedUrl,
      video_quality: quality,
      start_time: 'false',
      end_time: 'false'
    }).toString();

    const options = {
      hostname: 'dvr.yout.com',
      path: '/mp4',
      method: 'POST',
      headers: {
        'Authorization': `Api-Key ${YOUT_API_KEY}`,
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(postData)
      }
    };

    logger.info(`[yout] Downloading: ${videoUrl}`);

    const req = https.request(options, async (res) => {
      // 处理重定向
      if (res.statusCode === 302 || res.statusCode === 301) {
        const redirectUrl = res.headers.location;
        logger.info(`[yout] Redirecting to: ${redirectUrl}`);

        // 直接从重定向 URL 下载
        const redirectReq = https.get(redirectUrl, {
          headers: {
            'Authorization': `Api-Key ${YOUT_API_KEY}`
          }
        }, async (redirectRes) => {
          if (redirectRes.statusCode >= 400) {
            reject(new Error(`Download failed: HTTP ${redirectRes.statusCode}`));
            return;
          }

          const totalSize = parseInt(redirectRes.headers['content-length'] || '0', 10);
          let downloadedSize = 0;
          let lastUpdate = Date.now();

          const stream = require('fs').createWriteStream(filePath);
          
          redirectRes.on('data', (chunk) => {
            downloadedSize += chunk.length;
            stream.write(chunk);

            // 进度回调（每秒更新一次）
            const now = Date.now();
            if (now - lastUpdate >= 1000 && onProgress) {
              const elapsed = (now - lastUpdate) / 1000;
              const speed = chunk.length / elapsed;
              const percent = totalSize > 0 ? Math.round((downloadedSize / totalSize) * 100) : 0;
              const remaining = totalSize - downloadedSize;
              const eta = speed > 0 ? Math.round(remaining / speed) : 0;
              onProgress(percent, speed, eta);
              lastUpdate = now;
            }
          });

          redirectRes.on('end', () => {
            stream.end();
            logger.info(`[yout] Downloaded: ${filePath} (${downloadedSize} bytes)`);
            resolve({
              filePath,
              filename: path.basename(filePath),
              title: videoUrl
            });
          });

          redirectRes.on('error', (e) => {
            stream.destroy();
            reject(e);
          });
        });

        redirectReq.on('error', reject);
        return;
      }

      // 直接响应（流式）
      if (res.statusCode === 200) {
        const totalSize = parseInt(res.headers['content-length'] || '0', 10);
        let downloadedSize = 0;
        let lastUpdate = Date.now();

        const stream = require('fs').createWriteStream(filePath);

        res.on('data', (chunk) => {
          downloadedSize += chunk.length;
          stream.write(chunk);

          const now = Date.now();
          if (now - lastUpdate >= 1000 && onProgress) {
            const elapsed = (now - lastUpdate) / 1000;
            const speed = chunk.length / elapsed;
            const percent = totalSize > 0 ? Math.round((downloadedSize / totalSize) * 100) : 0;
            const remaining = totalSize - downloadedSize;
            const eta = speed > 0 ? Math.round(remaining / speed) : 0;
            onProgress(percent, speed, eta);
            lastUpdate = now;
          }
        });

        res.on('end', () => {
          stream.end();
          resolve({
            filePath,
            filename: path.basename(filePath),
            title: videoUrl
          });
        });

        res.on('error', (e) => {
          stream.destroy();
          reject(e);
        });
      } else {
        reject(new Error(`Unexpected response: ${res.statusCode}`));
      }
    });

    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('Yout API request timeout'));
    });

    req.write(postData);
    req.end();
  });
}

/**
 * 获取 Yout.com API 余额
 * @returns {Promise<{credits: number, used: number}>}
 */
async function getYoutCredits() {
  return new Promise((resolve, reject) => {
    if (!YOUT_API_KEY) {
      return reject(new Error('YOUT_API_KEY not configured'));
    }

    const options = {
      hostname: 'dvr.yout.com',
      path: '/credits',
      method: 'GET',
      headers: {
        'Authorization': `Api-Key ${YOUT_API_KEY}`
      }
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          resolve({
            credits: json.credits || 0,
            used: json.used || 0
          });
        } catch (e) {
          reject(new Error(`Failed to parse credits response: ${data}`));
        }
      });
    });

    req.on('error', reject);
    req.end();
  });
}

module.exports = {
  isYoutConfigured,
  requestYout,
  downloadViaYout,
  getYoutCredits
};

/**
 * Cobalt API 客户端 - 高画质多平台视频解析
 *
 * 项目地址: https://github.com/imputnet/cobalt
 * API 文档:  https://github.com/imputnet/cobalt/blob/main/docs/api.md
 *
 * 用途:
 *   - X/Twitter 高清视频（突破 fxtwitter 540p 限制，可拿原画 1080p+）
 *   - YouTube/Bilibili/Reddit/Tumblr/SoundCloud/Vimeo 等几十个平台的统一兜底
 *
 * 部署:
 *   自托管一个 cobalt 实例（Docker），把 COBALT_API_URL 指向它即可。
 *   详见 docs/COBALT_SETUP.md
 *
 * 设计思路:
 *   - 默认走自托管实例，不依赖第三方公开实例（避免被滥用 ban、画质降级）
 *   - cobalt 返回 status: tunnel | redirect | stream → 都视为可下载直链
 *   - status: picker → 多媒体（图集），逐个下载
 *   - 下载阶段加 SSRF 防护、redirect 上限、HTML/JSON 内容嗅探（与 tikhub.js 对齐）
 */

const https = require('https');
const http = require('http');
const fs = require('fs');
const fsp = require('fs').promises;
const path = require('path');
const { URL } = require('url');
const logger = require('../utils/logger');

const COBALT_API_URL = (process.env.COBALT_API_URL || '').replace(/\/+$/, '');
const COBALT_API_KEY = process.env.COBALT_API_KEY || '';
const REQUEST_TIMEOUT_MS = parseInt(process.env.COBALT_REQUEST_TIMEOUT_MS, 10) || 15000;
const DOWNLOAD_TIMEOUT_MS = parseInt(process.env.COBALT_DOWNLOAD_TIMEOUT_MS, 10) || 180000;
const MAX_REDIRECTS = parseInt(process.env.COBALT_MAX_REDIRECTS, 10) || 5;

function isCobaltConfigured() {
  return !!COBALT_API_URL;
}

/**
 * 私网/链路本地 IP 拦截（SSRF 防护）
 */
function isPrivateHost(hostname) {
  if (!hostname) return true;
  const h = hostname.toLowerCase();
  if (h === 'localhost' || h === '0.0.0.0' || h === '::1' || h === '::') return true;
  // IPv4
  const m = h.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (m) {
    const [a, b] = [parseInt(m[1], 10), parseInt(m[2], 10)];
    if (a === 10) return true;
    if (a === 127) return true;
    if (a === 169 && b === 254) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 0) return true;
  }
  // IPv6 link-local / unique-local
  if (h.startsWith('fe80:') || h.startsWith('fc') || h.startsWith('fd')) return true;
  return false;
}

/**
 * 调用 cobalt POST / 接口
 * @param {string} url 目标视频 URL
 * @param {object} options cobalt 请求体覆盖项
 * @returns {Promise<object>} cobalt 响应（{ status, url, filename, picker, ... }）
 */
function requestCobalt(url, options = {}) {
  if (!COBALT_API_URL) {
    return Promise.reject(new Error('COBALT_API_URL not configured'));
  }

  const body = JSON.stringify({
    url,
    videoQuality: options.videoQuality || 'max',
    audioFormat: options.audioFormat || 'mp3',
    audioBitrate: options.audioBitrate || '320',
    filenameStyle: options.filenameStyle || 'basic',
    downloadMode: options.downloadMode || 'auto', // auto | audio | mute
    youtubeVideoCodec: options.youtubeVideoCodec || 'h264',
    youtubeDubLang: options.youtubeDubLang,
    twitterGif: options.twitterGif !== false,
    tiktokFullAudio: options.tiktokFullAudio || false,
    disableMetadata: options.disableMetadata || false,
    alwaysProxy: options.alwaysProxy || false,
  });

  return new Promise((resolve, reject) => {
    let target;
    try { target = new URL(COBALT_API_URL); } catch { return reject(new Error('Invalid COBALT_API_URL')); }
    if (target.protocol !== 'https:' && target.protocol !== 'http:') {
      return reject(new Error('COBALT_API_URL must be http(s)'));
    }

    const client = target.protocol === 'https:' ? https : http;
    const headers = {
      'Content-Type': 'application/json',
      'Accept': 'application/json',
      'Content-Length': Buffer.byteLength(body),
      'User-Agent': 'orange-downloader/1.0 (+cobalt-client)',
    };
    if (COBALT_API_KEY) {
      headers['Authorization'] = `Api-Key ${COBALT_API_KEY}`;
    }

    const req = client.request({
      method: 'POST',
      hostname: target.hostname,
      port: target.port || (target.protocol === 'https:' ? 443 : 80),
      path: target.pathname || '/',
      headers,
    }, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf-8');
        let json;
        try { json = JSON.parse(text); } catch {
          return reject(new Error(`cobalt returned non-JSON (status ${res.statusCode}): ${text.slice(0, 200)}`));
        }
        // cobalt v10: status === 'error' 时附带 error.code
        if (json.status === 'error') {
          const code = json.error && json.error.code ? json.error.code : 'unknown';
          return reject(new Error(`cobalt error: ${code}`));
        }
        resolve(json);
      });
    });
    req.on('error', reject);
    req.setTimeout(REQUEST_TIMEOUT_MS, () => {
      req.destroy(new Error('cobalt request timeout'));
    });
    req.write(body);
    req.end();
  });
}

/**
 * 流式下载一条直链到本地（带 SSRF / redirect / HTML 嗅探防护）
 */
function downloadStream(rawUrl, destPath, onProgress, redirectCount = 0) {
  return new Promise((resolve, reject) => {
    let url;
    try { url = new URL(rawUrl); } catch { return reject(new Error('Invalid download URL')); }
    if (url.protocol !== 'https:' && url.protocol !== 'http:') {
      return reject(new Error('Only http/https download URLs are allowed'));
    }
    if (isPrivateHost(url.hostname)) {
      return reject(new Error(`Refused to download from private host: ${url.hostname}`));
    }
    if (redirectCount > MAX_REDIRECTS) {
      return reject(new Error('Too many redirects'));
    }

    const client = url.protocol === 'https:' ? https : http;
    const req = client.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; orange-downloader/1.0)',
      },
    }, (res) => {
      // Redirect
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
        res.resume();
        const next = new URL(res.headers.location, url).href;
        return downloadStream(next, destPath, onProgress, redirectCount + 1).then(resolve).catch(reject);
      }
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error(`HTTP ${res.statusCode}`));
      }
      const ct = (res.headers['content-type'] || '').toLowerCase();
      // cobalt 直链应当是 video/audio/image —— 不应是 html/json
      if (ct.includes('text/html') || ct.includes('application/json')) {
        res.resume();
        return reject(new Error(`Unexpected content-type: ${ct}`));
      }

      const total = parseInt(res.headers['content-length'], 10) || 0;
      let downloaded = 0;
      let firstChunkChecked = false;

      const file = fs.createWriteStream(destPath);
      let aborted = false;

      const cleanup = (err) => {
        if (aborted) return;
        aborted = true;
        try { req.destroy(); } catch (_) { /* noop */ }
        try { res.destroy(); } catch (_) { /* noop */ }
        try { file.destroy(); } catch (_) { /* noop */ }
        fsp.unlink(destPath).catch(() => { /* file may not exist */ });
        reject(err);
      };

      res.on('data', (chunk) => {
        // 嗅探首块字节，防止误把 HTML 错误页写成 .mp4
        if (!firstChunkChecked) {
          firstChunkChecked = true;
          const head = chunk.slice(0, 64).toString('utf-8').trim().toLowerCase();
          if (head.startsWith('<!doctype') || head.startsWith('<html') || head.startsWith('{')) {
            return cleanup(new Error('Download body looks like HTML/JSON error page'));
          }
        }
        downloaded += chunk.length;
        if (onProgress && total > 0) {
          onProgress(Math.min(99, Math.round(downloaded / total * 100)));
        }
      });

      res.pipe(file);
      file.on('finish', () => {
        if (aborted) return;
        file.close((err) => {
          if (err) return reject(err);
          resolve({ size: downloaded || total });
        });
      });
      file.on('error', cleanup);
      res.on('error', cleanup);
    });
    req.on('error', reject);
    req.setTimeout(DOWNLOAD_TIMEOUT_MS, () => {
      req.destroy(new Error('cobalt download timeout'));
    });
  });
}

/**
 * 通用：通过 cobalt 把任意支持的链接下载到本地
 * @param {string} url
 * @param {string} taskId
 * @param {object} opts { onProgress, downloadDir, options }
 * @returns {Promise<{filePath, ext, downloadUrl, isPicker?, images?, audio?}>}
 */
async function downloadViaCobalt(url, taskId, opts = {}) {
  const downloadDir = opts.downloadDir || path.join(__dirname, '../../downloads');
  await fsp.mkdir(downloadDir, { recursive: true });
  const onProgress = opts.onProgress || (() => {});

  onProgress(5);
  const data = await requestCobalt(url, opts.options || {});
  onProgress(15);

  // 多媒体图集（picker）
  if (data.status === 'picker' && Array.isArray(data.picker) && data.picker.length > 0) {
    const images = [];
    for (let i = 0; i < data.picker.length; i++) {
      const item = data.picker[i];
      const directUrl = item.url || item.thumb;
      if (!directUrl) continue;
      const ext = item.type === 'photo' ? 'jpg' : (path.extname(new URL(directUrl).pathname).slice(1) || 'jpg');
      const filename = `${taskId}_${i + 1}.${ext}`;
      const filepath = path.join(downloadDir, filename);
      try {
        await downloadStream(directUrl, filepath);
        images.push({ filename, path: filepath, url: `/download/${filename}` });
      } catch (e) {
        logger.warn(`[cobalt] picker item ${i + 1} failed: ${e.message}`);
      }
      onProgress(15 + Math.round((i + 1) / data.picker.length * 80));
    }
    if (images.length === 0) throw new Error('cobalt picker returned no downloadable items');
    onProgress(100);
    return { isPicker: true, images, ext: 'images' };
  }

  // 单文件: tunnel | redirect | stream 都视为直链
  if (!['tunnel', 'redirect', 'stream'].includes(data.status) || !data.url) {
    throw new Error(`Unexpected cobalt status: ${data.status}`);
  }

  const remoteUrl = data.url;
  const inferredExt = (() => {
    if (data.filename) {
      const e = path.extname(data.filename).slice(1).toLowerCase();
      if (e) return e;
    }
    try {
      const e = path.extname(new URL(remoteUrl).pathname).slice(1).toLowerCase();
      if (e && e.length <= 4) return e;
    } catch { /* ignore */ }
    return opts.options && opts.options.downloadMode === 'audio' ? 'mp3' : 'mp4';
  })();

  const filename = `${taskId}.${inferredExt}`;
  const filepath = path.join(downloadDir, filename);

  await downloadStream(remoteUrl, filepath, (p) => onProgress(15 + Math.round(p * 0.8)));
  onProgress(100);

  return {
    filePath: filepath,
    ext: inferredExt,
    downloadUrl: `/download/${filename}`,
    cobaltFilename: data.filename || null,
  };
}

module.exports = {
  isCobaltConfigured,
  requestCobalt,
  downloadViaCobalt,
};

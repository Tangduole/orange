/**
 * 通用 HTTP 请求工具（所有服务共享）
 *
 * 功能:
 *   - GET 请求（支持 string / arraybuffer 响应）
 *   - 自动跟随重定向
 *   - 超时控制 + 文件大小限制
 *   - SSRF 防护（拒绝私网地址）
 *   - HTML/JSON 错误页嗅探
 */

const https = require('https');
const http = require('http');
const { URL } = require('url');

// 默认最大响应大小: 500MB（视频下载）
const DEFAULT_MAX_SIZE = 500 * 1024 * 1024;

/**
 * 私网/链路本地 IP 拦截（SSRF 防护）
 */
function isPrivateHost(hostname) {
  if (!hostname) return true;
  const h = hostname.toLowerCase();
  if (h === 'localhost' || h === '0.0.0.0' || h === '::1' || h === '::') return true;
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
  if (h.startsWith('fe80:') || h.startsWith('fc') || h.startsWith('fd')) return true;
  return false;
}

/**
 * HTTP GET 请求
 *
 * @param {string} rawUrl 目标 URL
 * @param {object} [opts]
 * @param {number} [opts.timeout=15000] 超时毫秒
 * @param {number} [opts.maxSize=524288000] 最大响应字节
 * @param {object} [opts.headers] 额外请求头
 * @param {string} [opts.responseType='text'] 'text' | 'arraybuffer'
 * @param {boolean} [opts.followRedirect=true] 是否跟随重定向
 * @returns {Promise<Buffer|{body: string, finalUrl: string}>}
 */
function httpGet(rawUrl, opts = {}) {
  const timeout = opts.timeout || 15000;
  const maxSize = opts.maxSize || DEFAULT_MAX_SIZE;
  const responseType = opts.responseType || 'text';
  const followRedirect = opts.followRedirect !== false;

  let url;
  try { url = new URL(rawUrl); } catch { return Promise.reject(new Error('Invalid URL: ' + rawUrl)); }

  // SSRF 防护
  if (isPrivateHost(url.hostname)) {
    return Promise.reject(new Error('Refused to download from private host: ' + url.hostname));
  }

  return new Promise((resolve, reject) => {
    const client = url.protocol === 'https:' ? https : http;
    const defaultHeaders = {
      'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15',
      ...(opts.headers || {})
    };

    const req = client.get(url, { headers: defaultHeaders }, (res) => {
      // 跟随重定向
      if (followRedirect && [301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
        res.resume();
        const nextUrl = new URL(res.headers.location, url).href;
        return httpGet(nextUrl, opts).then(resolve).catch(reject);
      }

      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error('HTTP ' + res.statusCode));
      }

      const contentType = (res.headers['content-type'] || '').toLowerCase();

      // HTML/JSON 错误页嗅探
      if (contentType.includes('text/html') || contentType.includes('application/json')) {
        const chunks = [];
        res.on('data', c => chunks.push(c));
        res.on('end', () => {
          const buf = Buffer.concat(chunks);
          if (responseType === 'arraybuffer') {
            // 检查是否是 HTML 伪装成二进制
            const head = buf.slice(0, 1024).toString('utf8').trim();
            if (head.startsWith('<!DOCTYPE') || head.startsWith('<html')) {
              return reject(new Error('Response is HTML error page'));
            }
            return resolve(buf);
          }
          resolve({ body: buf.toString('utf-8'), finalUrl: url.href });
        });
        res.on('error', reject);
        return;
      }

      if (responseType === 'arraybuffer') {
        let downloaded = 0;
        const chunks = [];
        res.on('data', c => {
          downloaded += c.length;
          if (downloaded > maxSize) {
            req.destroy();
            return reject(new Error('文件过大 (' + Math.round(downloaded / 1024 / 1024) + 'MB)，超过 ' + Math.round(maxSize / 1024 / 1024) + 'MB 限制'));
          }
          chunks.push(c);
        });
        res.on('end', () => resolve(Buffer.concat(chunks)));
        res.on('error', reject);
      } else {
        let downloaded = 0;
        const chunks = [];
        res.on('data', c => {
          downloaded += c.length;
          if (downloaded > maxSize) {
            req.destroy();
            return reject(new Error('响应过大，超过 ' + Math.round(maxSize / 1024 / 1024) + 'MB 限制'));
          }
          chunks.push(c);
        });
        res.on('end', () => resolve({ body: Buffer.concat(chunks).toString('utf-8'), finalUrl: url.href }));
        res.on('error', reject);
      }
    });

    req.on('error', reject);
    req.setTimeout(timeout, () => {
      req.destroy();
      reject(new Error('HTTP request timeout (' + timeout + 'ms)'));
    });
  });
}

module.exports = { httpGet, isPrivateHost };

const { httpGet } = require('../utils/httpGet');

function isHongguoUrl(url) {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return host === 'novelquickapp.com' || host.endsWith('.novelquickapp.com');
  } catch {
    return false;
  }
}

function decodeHtmlEntities(value) {
  let decoded = String(value || '')
    .replace(/\\u002F/g, '/')
    .replace(/\\u0026/g, '&')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>');
  return decoded;
}

function normalizeUrl(value) {
  if (!value || typeof value !== 'string') return '';
  let url = value.trim();
  try {
    url = JSON.parse(`"${url.replace(/"/g, '\\"')}"`);
  } catch {}
  url = decodeHtmlEntities(url);
  if (/^https?%3A%2F%2F/i.test(url)) {
    try {
      url = decodeURIComponent(url);
    } catch {}
  }
  if (url.startsWith('//')) url = 'https:' + url;
  return /^https?:\/\//i.test(url) ? url : '';
}

function extractBalancedJsonAfter(html, marker) {
  const markerIndex = html.indexOf(marker);
  if (markerIndex === -1) return '';
  const start = html.indexOf('{', markerIndex);
  if (start === -1) return '';

  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < html.length; i++) {
    const ch = html[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return html.slice(start, i + 1);
    }
  }
  return '';
}

function findPlayUrlInObject(value) {
  if (!value || typeof value !== 'object') return '';
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findPlayUrlInObject(item);
      if (found) return found;
    }
    return '';
  }

  const preferredKeys = ['play_url', 'playUrl', 'main_url', 'mainUrl', 'video_url', 'videoUrl', 'url'];
  for (const key of preferredKeys) {
    const raw = value[key];
    if (typeof raw === 'string') {
      const url = normalizeUrl(raw);
      if (url) return url;
    }
    if (Array.isArray(raw)) {
      for (const item of raw) {
        const url = typeof item === 'string' ? normalizeUrl(item) : findPlayUrlInObject(item);
        if (url) return url;
      }
    }
  }

  for (const child of Object.values(value)) {
    const found = findPlayUrlInObject(child);
    if (found) return found;
  }
  return '';
}

function extractPlayUrl(html) {
  const routerJson = extractBalancedJsonAfter(html, '_ROUTER_DATA');
  if (routerJson) {
    try {
      const data = JSON.parse(routerJson);
      const found = findPlayUrlInObject(data);
      if (found) return found;
    } catch {}
  }

  const source = routerJson || html;
  const playUrlMatch =
    source.match(/["']play_url["']\s*:\s*["']([^"']+)["']/i) ||
    source.match(/play_url\\?["']?\s*:\s*\\?["']([^"'\\]+(?:\\.[^"'\\]*)*)/i);
  if (playUrlMatch) {
    const url = normalizeUrl(playUrlMatch[1]);
    if (url) return url;
  }

  const urlMatches = source.match(/https?:\\?\/\\?\/[^"'\\\s<>]+/gi) || [];
  for (const candidate of urlMatches) {
    const url = normalizeUrl(candidate);
    if (/\.mp4(?:[?#]|$)|video|play/i.test(url)) return url;
  }
  return '';
}

async function parseHongguo(url) {
  if (!isHongguoUrl(url)) throw new Error('不是红果短剧链接');
  const { body } = await httpGet(url, {
    timeout: 15000,
    maxSize: 3 * 1024 * 1024,
    headers: {
      Referer: 'https://www.novelquickapp.com/',
      Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    }
  });
  const playUrl = extractPlayUrl(body || '');
  if (!/^https?:\/\//i.test(playUrl)) {
    throw new Error('红果短剧解析失败：未找到视频直链');
  }
  return { videoUrl: playUrl, title: '红果短剧', platform: 'hongguo' };
}

module.exports = { isHongguoUrl, parseHongguo, extractPlayUrl };

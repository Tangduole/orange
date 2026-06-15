const { httpGet } = require('../utils/httpGet');

function decodeHtmlEntities(value) {
  return String(value || '')
    .replace(/\\u002F/g, '/')
    .replace(/\\u0026/g, '&')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>');
}

function normalizeUrl(value, baseUrl) {
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
  try {
    return new URL(url, baseUrl).toString();
  } catch {
    return '';
  }
}

function isLikelyVideoUrl(url) {
  return /\.(mp4|m4v|mov|webm)(?:[?#]|$)/i.test(url);
}

function extractTitle(html) {
  const ogTitle = html.match(/<meta[^>]+(?:property|name)=["']og:title["'][^>]+content=["']([^"']+)["']/i)
    || html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+(?:property|name)=["']og:title["']/i);
  if (ogTitle?.[1]) return decodeHtmlEntities(ogTitle[1]).trim();
  const title = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  return title?.[1] ? decodeHtmlEntities(title[1].replace(/\s+/g, ' ')).trim() : '';
}

function findVideoUrlInObject(value, baseUrl) {
  if (!value || typeof value !== 'object') return '';
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findVideoUrlInObject(item, baseUrl);
      if (found) return found;
    }
    return '';
  }

  const strongKeys = [
    'play_url', 'playUrl',
    'video_url', 'videoUrl',
    'main_url', 'mainUrl',
    'contentUrl', 'content_url',
    'downloadUrl', 'download_url',
    'fileUrl', 'file_url'
  ];
  for (const key of strongKeys) {
    const raw = value[key];
    if (typeof raw === 'string') {
      const url = normalizeUrl(raw, baseUrl);
      if (url && isLikelyVideoUrl(url)) return url;
    }
    if (Array.isArray(raw)) {
      for (const item of raw) {
        const url = typeof item === 'string' ? normalizeUrl(item, baseUrl) : findVideoUrlInObject(item, baseUrl);
        if (url && isLikelyVideoUrl(url)) return url;
      }
    }
    if (raw && typeof raw === 'object') {
      const url = findVideoUrlInObject(raw, baseUrl);
      if (url) return url;
    }
  }

  const genericUrl = typeof value.url === 'string' ? normalizeUrl(value.url, baseUrl) : '';
  if (genericUrl && isLikelyVideoUrl(genericUrl)) return genericUrl;

  for (const child of Object.values(value)) {
    const found = findVideoUrlInObject(child, baseUrl);
    if (found) return found;
  }
  return '';
}

function extractJsonScriptBlocks(html) {
  const blocks = [];
  const scriptRe = /<script[^>]*(?:type=["']application\/(?:ld\+)?json["']|id=["']__NEXT_DATA__["'])[^>]*>([\s\S]*?)<\/script>/gi;
  for (const match of html.matchAll(scriptRe)) {
    const raw = decodeHtmlEntities(match[1] || '').trim();
    if (raw) blocks.push(raw);
  }
  return blocks;
}

function extractVideoUrl(html, baseUrl) {
  const metaRe = /<meta[^>]+(?:property|name)=["'](?:og:video(?::url)?|twitter:player:stream)["'][^>]+content=["']([^"']+)["']/gi;
  for (const match of html.matchAll(metaRe)) {
    const url = normalizeUrl(match[1], baseUrl);
    if (url && isLikelyVideoUrl(url)) return url;
  }

  const reverseMetaRe = /<meta[^>]+content=["']([^"']+)["'][^>]+(?:property|name)=["'](?:og:video(?::url)?|twitter:player:stream)["']/gi;
  for (const match of html.matchAll(reverseMetaRe)) {
    const url = normalizeUrl(match[1], baseUrl);
    if (url && isLikelyVideoUrl(url)) return url;
  }

  const tagRe = /<(?:video|source)\b[^>]+\bsrc=["']([^"']+)["']/gi;
  for (const match of html.matchAll(tagRe)) {
    const url = normalizeUrl(match[1], baseUrl);
    if (url && isLikelyVideoUrl(url)) return url;
  }

  for (const block of extractJsonScriptBlocks(html)) {
    try {
      const found = findVideoUrlInObject(JSON.parse(block), baseUrl);
      if (found) return found;
    } catch {}
  }

  const keyedUrlRe = /["'](?:play_url|playUrl|video_url|videoUrl|main_url|mainUrl|contentUrl|downloadUrl|fileUrl)["']\s*:\s*["']([^"']+)["']/gi;
  for (const match of html.matchAll(keyedUrlRe)) {
    const url = normalizeUrl(match[1], baseUrl);
    if (url && isLikelyVideoUrl(url)) return url;
  }

  const urlRe = /https?:\\?\/\\?\/[^"'\\\s<>]+/gi;
  for (const match of html.matchAll(urlRe)) {
    const url = normalizeUrl(match[0], baseUrl);
    if (url && isLikelyVideoUrl(url)) return url;
  }
  return '';
}

async function parseHtmlVideo(url) {
  const { body, finalUrl } = await httpGet(url, {
    timeout: 15000,
    maxSize: 5 * 1024 * 1024,
    headers: {
      Referer: url,
      Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
    }
  });
  const baseUrl = finalUrl || url;
  const videoUrl = extractVideoUrl(body || '', baseUrl);
  if (!videoUrl) throw new Error('未找到页面内嵌视频直链');
  return {
    videoUrl,
    title: extractTitle(body || '') || '网页视频',
    platform: 'auto'
  };
}

module.exports = { parseHtmlVideo, extractVideoUrl };

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
  return String(value || '')
    .replace(/\\u002F/g, '/')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>');
}

function extractPlayUrl(html) {
  const routerDataMatch = html.match(/_ROUTER_DATA\s*=\s*(\{[\s\S]*?\})\s*<\/script>/i);
  const source = routerDataMatch ? routerDataMatch[1] : html;

  const playUrlMatch = source.match(/"play_url"\s*:\s*"([^"]+)"/i) || source.match(/play_url\\?["']?\s*:\s*\\?["']([^"'\\]+(?:\\.[^"'\\]*)*)/i);
  if (!playUrlMatch) return '';

  try {
    return decodeHtmlEntities(JSON.parse(`"${playUrlMatch[1]}"`));
  } catch {
    return decodeHtmlEntities(playUrlMatch[1]);
  }
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
  if (!/^https?:\/\/.+\.mp4(\?|$)/i.test(playUrl)) {
    throw new Error('红果短剧解析失败：未找到 MP4 直链');
  }
  return { videoUrl: playUrl, title: '红果短剧', platform: 'hongguo' };
}

module.exports = { isHongguoUrl, parseHongguo, extractPlayUrl };

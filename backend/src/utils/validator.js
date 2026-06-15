/**
 * 输入验证工具 v3
 *
 * 修复点：
 *  1. ALLOWED_PLATFORMS 与后端真实支持的 processor 对齐（增加 instagram / xiaohongshu / wechat）
 *  2. validateUrl 强制 http(s):// schema，防止协议级 SSRF（file://、gopher:// 等）
 *  3. case 'x' / 'twitter' 单独分支
 */

const ALLOWED_PLATFORMS = new Set([
  'douyin',
  'tiktok',
  'x',
  'twitter',
  'youtube',
  'bilibili',
  'kuaishou',
  'xiaohongshu',
  'hongguo',
  'instagram',
  'wechat',
  'auto'
]);

/**
 * 从分享文本中提取 URL
 */
function extractUrl(text) {
  if (!text || typeof text !== 'string') return '';

  const urlPatterns = [
    /https?:\/\/[^\s<>\"')\]]+/gi,
    /[a-z0-9-]+\.(com|cn|net|org|io|cc|co)\/[^\s<>\"')\]]+/gi,
  ];

  const platformDomains = [
    'douyin.com', 'douyin.cn', 'iesdouyin.com',
    'tiktok.com', 'tiktok.cn',
    'x.com', 'twitter.com',
    'youtube.com', 'youtu.be',
    'bilibili.com', 'b23.tv',
    'kuaishou.com',
    'novelquickapp.com',
    'instagram.com',
    'xiaohongshu.com', 'xhslink.com',
    'channels.weixin.qq.com', 'finder.weixin.qq.com'
  ];

  for (const pattern of urlPatterns) {
    const matches = text.match(pattern);
    if (matches) {
      for (const m of matches) {
        for (const domain of platformDomains) {
          if (m.includes(domain)) return m.trim();
        }
      }
      return matches[0].trim();
    }
  }

  return text.trim();
}

/**
 * 校验是否为合法的 http/https URL
 * @returns {boolean}
 */
function isHttpUrl(value) {
  try {
    const u = new URL(value);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}

function getHostname(value) {
  try {
    return new URL(value).hostname.toLowerCase();
  } catch {
    return '';
  }
}

function hostMatches(hostname, allowedHosts) {
  return allowedHosts.some(host => hostname === host || hostname.endsWith(`.${host}`));
}

/**
 * 验证视频链接格式
 */
function validateUrl(url, platform) {
  if (!url || typeof url !== 'string') {
    return { valid: false, message: '链接不能为空' };
  }

  // 从分享文本里提取出 URL
  const extracted = extractUrl(url);
  if (extracted && extracted !== url.trim()) {
    url = extracted;
  }
  url = url.trim();

  if (url.length > 2048) {
    return { valid: false, message: '链接过长' };
  }

  // 强制要求 http(s)://（拒绝 file://、gopher://、javascript: 等危险协议）
  if (!/^https?:\/\//i.test(url)) {
    return { valid: false, message: '链接必须以 http:// 或 https:// 开头' };
  }
  if (!isHttpUrl(url)) {
    return { valid: false, message: '链接格式不正确' };
  }

  // 如果指定了平台，再做平台域名归属校验
  if (platform && platform !== 'auto') {
    const hostname = getHostname(url);
    switch (String(platform).toLowerCase()) {
      case 'douyin':
        if (!hostMatches(hostname, ['douyin.com', 'douyin.cn', 'iesdouyin.com'])) {
          return { valid: false, message: '抖音链接格式不正确' };
        }
        break;
      case 'tiktok':
        if (!hostMatches(hostname, ['tiktok.com', 'tiktok.cn'])) {
          return { valid: false, message: 'TikTok 链接格式不正确' };
        }
        break;
      case 'x':
      case 'twitter':
        if (!hostMatches(hostname, ['twitter.com', 'x.com'])) {
          return { valid: false, message: 'X (Twitter) 链接格式不正确' };
        }
        break;
      case 'youtube':
        if (!hostMatches(hostname, ['youtube.com', 'youtu.be'])) {
          return { valid: false, message: 'YouTube 链接格式不正确' };
        }
        break;
      case 'bilibili':
        if (!hostMatches(hostname, ['bilibili.com', 'b23.tv'])) {
          return { valid: false, message: 'B 站链接格式不正确' };
        }
        break;
      case 'kuaishou':
        if (!hostMatches(hostname, ['kuaishou.com'])) {
          return { valid: false, message: '快手链接格式不正确' };
        }
        break;
      case 'hongguo':
        if (!hostMatches(hostname, ['novelquickapp.com'])) {
          return { valid: false, message: '红果短剧链接格式不正确' };
        }
        break;
      case 'instagram':
        if (!hostMatches(hostname, ['instagram.com', 'instagr.am'])) {
          return { valid: false, message: 'Instagram 链接格式不正确' };
        }
        break;
      case 'xiaohongshu':
        if (!hostMatches(hostname, ['xiaohongshu.com', 'xhslink.com'])) {
          return { valid: false, message: '小红书链接格式不正确' };
        }
        break;
      case 'wechat':
        if (!hostMatches(hostname, ['channels.weixin.qq.com', 'finder.weixin.qq.com', 'weixin.qq.com'])) {
          return { valid: false, message: '微信视频号链接格式不正确' };
        }
        break;
    }
  }

  return { valid: true };
}

/**
 * 验证平台
 */
function validatePlatform(platform) {
  if (!platform || platform === 'auto') {
    return { valid: true };
  }
  if (!ALLOWED_PLATFORMS.has(String(platform).toLowerCase())) {
    return { valid: false, message: `不支持的平台: ${platform}` };
  }
  return { valid: true };
}

/**
 * 完整验证
 */
function validateInput(data) {
  let { url, platform } = data;

  const extracted = extractUrl(url);
  if (extracted && extracted !== (url || '').trim()) {
    url = extracted;
    data.url = extracted;
  }

  const urlResult = validateUrl(url, platform);
  if (!urlResult.valid) return urlResult;

  const platformResult = validatePlatform(platform);
  if (!platformResult.valid) return platformResult;

  return { valid: true };
}

module.exports = {
  validateInput,
  validateUrl,
  validatePlatform,
  extractUrl,
  isHttpUrl,
  getHostname,
  hostMatches,
  ALLOWED_PLATFORMS
};

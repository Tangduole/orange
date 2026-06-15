/**
 * 媒体工具函数 - 跨服务共享
 *
 * 功能:
 *   - 画质标签转换 (720 → '720p', 2160 → '4K')
 *   - 文件大小格式化
 *   - 平台检测
 */

/**
 * 画质高度 → 人类可读标签
 */
function heightToLabel(w, h) {
  // 用短边判断分辨率,避免竖屏视频(1080x1920)被误判为2K
  const res = (w && h) ? Math.min(w, h) : ((typeof h === 'number' && h > 0) ? h : (w || h || 0));
  if (!res || res <= 0) return 'Unknown';
  if (res >= 4320) return '8K';
  if (res >= 2160) return '4K';
  if (res >= 1440) return '2K';
  if (res >= 1080) return '1080p';
  if (res >= 720) return '720p';
  if (res >= 480) return '480p';
  if (res >= 360) return '360p';
  return `${res}p`;
}

/**
 * 文件大小 → 人类可读字符串
 */
function formatSize(bytes) {
  if (!bytes || bytes <= 0) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1048576) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1073741824) return `${(bytes / 1048576).toFixed(1)} MB`;
  return `${(bytes / 1073741824).toFixed(2)} GB`;
}

function hostnameOf(url) {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return '';
  }
}

function hostMatches(hostname, hosts) {
  return hosts.some(host => hostname === host || hostname.endsWith(`.${host}`));
}

/**
 * URL → 平台标识
 */
function detectPlatform(url) {
  if (!url || typeof url !== 'string') return 'unknown';
  const host = hostnameOf(url);
  if (hostMatches(host, ['douyin.com', 'douyin.cn', 'iesdouyin.com'])) return 'douyin';
  if (hostMatches(host, ['tiktok.com', 'tiktok.cn'])) return 'tiktok';
  if (hostMatches(host, ['twitter.com', 'x.com'])) return 'x';
  if (hostMatches(host, ['youtube.com', 'youtu.be'])) return 'youtube';
  if (hostMatches(host, ['xiaohongshu.com', 'xhslink.com'])) return 'xiaohongshu';
  if (hostMatches(host, ['instagram.com', 'instagr.am'])) return 'instagram';
  if (hostMatches(host, ['bilibili.com', 'b23.tv'])) return 'bilibili';
  if (hostMatches(host, ['kuaishou.com', 'v.kuaishou.com'])) return 'kuaishou';
  if (hostMatches(host, ['novelquickapp.com'])) return 'hongguo';
  if (hostMatches(host, ['facebook.com', 'fb.watch', 'fb.gg'])) return 'facebook';
  if (hostMatches(host, ['weixin.qq.com', 'channels.weixin.qq.com', 'finder.weixin.qq.com'])) return 'wechat';
  if (hostMatches(host, ['tumblr.com'])) return 'tumblr';
  if (hostMatches(host, ['reddit.com', 'redd.it'])) return 'reddit';
  return 'auto';
}

module.exports = {
  heightToLabel,
  formatSize,
  detectPlatform
};

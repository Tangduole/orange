/**
 * 文件大小缓存
 * 
 * 下载完成后记录实际文件大小，下次查询画质时优先使用缓存值。
 * 避免重复获取付费API数据，同时提供更准确的大小参考。
 */

const fs = require('fs');
const path = require('path');

const CACHE_FILE = path.join(__dirname, '../../data/video-size-cache.json');
const MAX_ENTRIES = 10000;
const TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7天过期

let cache = null;

function loadCache() {
  if (cache) return cache;
  try {
    if (fs.existsSync(CACHE_FILE)) {
      cache = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
    }
  } catch (e) {
    cache = {};
  }
  if (!cache || typeof cache !== 'object') cache = {};
  return cache;
}

function saveCache() {
  try {
    const dir = path.dirname(CACHE_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(CACHE_FILE, JSON.stringify(cache), 'utf8');
  } catch (e) {
    // 静默失败，不影响主流程
  }
}

/**
 * 记录下载后的真实文件大小
 * @param {string} videoId - 视频ID (aweme_id)
 * @param {object} sizes - { quality: bytes }
 */
function recordSizes(videoId, sizes) {
  loadCache();
  cache[videoId] = {
    sizes,
    updatedAt: Date.now()
  };
  saveCache();
  // 简单清理过期条目
  if (Object.keys(cache).length > MAX_ENTRIES) {
    const now = Date.now();
    for (const key of Object.keys(cache)) {
      if (now - (cache[key].updatedAt || 0) > TTL_MS) {
        delete cache[key];
      }
    }
  }
}

/**
 * 获取缓存的文件大小
 * @param {string} videoId 
 * @returns {object|null} { quality: bytes } or null
 */
function getSizes(videoId) {
  loadCache();
  const entry = cache[videoId];
  if (!entry) return null;
  // 检查过期
  if (Date.now() - (entry.updatedAt || 0) > TTL_MS) {
    delete cache[videoId];
    saveCache();
    return null;
  }
  return entry.sizes;
}

module.exports = { recordSizes, getSizes };

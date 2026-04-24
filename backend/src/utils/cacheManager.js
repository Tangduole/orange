/**
 * 缓存管理器 - 使用LRU缓存防止内存泄漏
 */

const { LRUCache } = require('lru-cache');
const logger = require('./logger');

class CacheManager {
  constructor() {
    // 视频信息缓存（5分钟TTL，最多500条）
    this.infoCache = new LRUCache({
      max: 500,
      ttl: 5 * 60 * 1000, // 5分钟
      updateAgeOnGet: true,
      updateAgeOnHas: false,
      dispose: (value, key) => {
        logger.debug(`[Cache] Evicted: ${key}`);
      }
    });

    // API响应缓存（10分钟TTL，最多200条）
    this.apiCache = new LRUCache({
      max: 200,
      ttl: 10 * 60 * 1000, // 10分钟
      updateAgeOnGet: true
    });

    // 统计信息
    this.stats = {
      hits: 0,
      misses: 0,
      sets: 0
    };
  }

  /**
   * 获取或设置缓存
   * @param {string} key 缓存键
   * @param {Function} fetcher 获取数据的函数
   * @param {string} cacheType 缓存类型 ('info' | 'api')
   * @returns {Promise<any>}
   */
  async getOrSet(key, fetcher, cacheType = 'info') {
    const cache = cacheType === 'api' ? this.apiCache : this.infoCache;
    
    // 检查缓存
    if (cache.has(key)) {
      this.stats.hits++;
      logger.debug(`[Cache] HIT: ${key}`);
      return cache.get(key);
    }
    
    // 缓存未命中，获取数据
    this.stats.misses++;
    logger.debug(`[Cache] MISS: ${key}`);
    
    try {
      const data = await fetcher();
      cache.set(key, data);
      this.stats.sets++;
      return data;
    } catch (error) {
      logger.error(`[Cache] Fetch error for ${key}: ${error.message}`);
      throw error;
    }
  }

  /**
   * 手动设置缓存
   * @param {string} key 缓存键
   * @param {any} value 缓存值
   * @param {string} cacheType 缓存类型
   */
  set(key, value, cacheType = 'info') {
    const cache = cacheType === 'api' ? this.apiCache : this.infoCache;
    cache.set(key, value);
    this.stats.sets++;
  }

  /**
   * 获取缓存
   * @param {string} key 缓存键
   * @param {string} cacheType 缓存类型
   * @returns {any}
   */
  get(key, cacheType = 'info') {
    const cache = cacheType === 'api' ? this.apiCache : this.infoCache;
    
    if (cache.has(key)) {
      this.stats.hits++;
      return cache.get(key);
    }
    
    this.stats.misses++;
    return undefined;
  }

  /**
   * 删除缓存
   * @param {string} key 缓存键
   * @param {string} cacheType 缓存类型
   */
  delete(key, cacheType = 'info') {
    const cache = cacheType === 'api' ? this.apiCache : this.infoCache;
    cache.delete(key);
  }

  /**
   * 清空所有缓存
   */
  clear() {
    this.infoCache.clear();
    this.apiCache.clear();
    logger.info('[Cache] All caches cleared');
  }

  /**
   * 获取缓存统计信息
   */
  getStats() {
    const hitRate = this.stats.hits + this.stats.misses > 0
      ? (this.stats.hits / (this.stats.hits + this.stats.misses) * 100).toFixed(2)
      : 0;

    return {
      infoCache: {
        size: this.infoCache.size,
        max: this.infoCache.max
      },
      apiCache: {
        size: this.apiCache.size,
        max: this.apiCache.max
      },
      stats: {
        ...this.stats,
        hitRate: `${hitRate}%`
      }
    };
  }

  /**
   * 定期清理过期缓存（LRU会自动处理，这里只是记录日志）
   */
  logStats() {
    const stats = this.getStats();
    logger.info(`[Cache] Stats: ${JSON.stringify(stats)}`);
  }
}

// 单例模式
const cacheManager = new CacheManager();

// 每小时记录一次统计信息
setInterval(() => {
  cacheManager.logStats();
}, 60 * 60 * 1000);

module.exports = cacheManager;

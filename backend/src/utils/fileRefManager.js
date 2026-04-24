/**
 * 文件引用计数管理器 - 防止文件被过早删除
 */

const logger = require('./logger');

class FileRefManager {
  constructor() {
    this.refs = new Map(); // filename -> count
    this.timestamps = new Map(); // filename -> last access time
  }

  /**
   * 增加文件引用
   * @param {string} filename 文件名
   */
  addRef(filename) {
    const count = this.refs.get(filename) || 0;
    this.refs.set(filename, count + 1);
    this.timestamps.set(filename, Date.now());
    logger.debug(`[FileRef] Added ref for ${filename}, count: ${count + 1}`);
  }

  /**
   * 减少文件引用
   * @param {string} filename 文件名
   * @returns {boolean} 是否可以安全删除（引用计数为0）
   */
  removeRef(filename) {
    const count = this.refs.get(filename) || 0;
    
    if (count <= 1) {
      this.refs.delete(filename);
      this.timestamps.delete(filename);
      logger.debug(`[FileRef] Removed last ref for ${filename}, can delete`);
      return true;
    }
    
    this.refs.set(filename, count - 1);
    logger.debug(`[FileRef] Removed ref for ${filename}, count: ${count - 1}`);
    return false;
  }

  /**
   * 检查文件是否可以删除
   * @param {string} filename 文件名
   * @returns {boolean}
   */
  canDelete(filename) {
    return !this.refs.has(filename) || this.refs.get(filename) === 0;
  }

  /**
   * 获取文件引用计数
   * @param {string} filename 文件名
   * @returns {number}
   */
  getRefCount(filename) {
    return this.refs.get(filename) || 0;
  }

  /**
   * 清理长时间未访问的引用（防止内存泄漏）
   * @param {number} maxAge 最大年龄（毫秒），默认24小时
   */
  cleanupStaleRefs(maxAge = 24 * 60 * 60 * 1000) {
    const now = Date.now();
    let cleaned = 0;
    
    for (const [filename, timestamp] of this.timestamps.entries()) {
      if (now - timestamp > maxAge) {
        this.refs.delete(filename);
        this.timestamps.delete(filename);
        cleaned++;
        logger.warn(`[FileRef] Cleaned up stale ref for ${filename}`);
      }
    }
    
    if (cleaned > 0) {
      logger.info(`[FileRef] Cleaned up ${cleaned} stale references`);
    }
  }

  /**
   * 获取统计信息
   */
  getStats() {
    return {
      totalRefs: this.refs.size,
      totalCount: Array.from(this.refs.values()).reduce((sum, count) => sum + count, 0)
    };
  }
}

// 单例模式
const fileRefManager = new FileRefManager();

// 定期清理过期引用
setInterval(() => {
  fileRefManager.cleanupStaleRefs();
}, 60 * 60 * 1000); // 每小时清理一次

module.exports = fileRefManager;

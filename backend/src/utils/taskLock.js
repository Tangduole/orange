/**
 * 任务锁管理器 - 防止并发竞态条件
 */

const logger = require('./logger');

class TaskLockManager {
  constructor() {
    this.locks = new Map();
    this.lockTimestamps = new Map();
    this.LOCK_TIMEOUT = 10 * 60 * 1000; // 10分钟超时
    
    // 定期清理超时的锁
    setInterval(() => this.cleanupExpiredLocks(), 60 * 1000);
  }

  /**
   * 尝试获取锁
   * @param {string} taskId 任务ID
   * @returns {boolean} 是否成功获取锁
   */
  tryAcquire(taskId) {
    if (this.locks.has(taskId)) {
      const timestamp = this.lockTimestamps.get(taskId);
      const age = Date.now() - timestamp;
      
      // 如果锁已超时，强制释放
      if (age > this.LOCK_TIMEOUT) {
        logger.warn(`[TaskLock] Force releasing expired lock for task ${taskId} (age: ${Math.round(age/1000)}s)`);
        this.release(taskId);
        return this.tryAcquire(taskId);
      }
      
      logger.warn(`[TaskLock] Task ${taskId} is already locked`);
      return false;
    }
    
    this.locks.set(taskId, true);
    this.lockTimestamps.set(taskId, Date.now());
    logger.debug(`[TaskLock] Acquired lock for task ${taskId}`);
    return true;
  }

  /**
   * 释放锁
   * @param {string} taskId 任务ID
   */
  release(taskId) {
    if (this.locks.has(taskId)) {
      this.locks.delete(taskId);
      this.lockTimestamps.delete(taskId);
      logger.debug(`[TaskLock] Released lock for task ${taskId}`);
    }
  }

  /**
   * 检查是否已锁定
   * @param {string} taskId 任务ID
   * @returns {boolean}
   */
  isLocked(taskId) {
    return this.locks.has(taskId);
  }

  /**
   * 清理过期的锁
   */
  cleanupExpiredLocks() {
    const now = Date.now();
    let cleaned = 0;
    
    for (const [taskId, timestamp] of this.lockTimestamps.entries()) {
      if (now - timestamp > this.LOCK_TIMEOUT) {
        this.release(taskId);
        cleaned++;
      }
    }
    
    if (cleaned > 0) {
      logger.info(`[TaskLock] Cleaned up ${cleaned} expired locks`);
    }
  }

  /**
   * 获取锁状态统计
   */
  getStats() {
    return {
      activeLocks: this.locks.size,
      oldestLock: this.getOldestLockAge()
    };
  }

  /**
   * 获取最老的锁的年龄（毫秒）
   */
  getOldestLockAge() {
    if (this.lockTimestamps.size === 0) return 0;
    
    const now = Date.now();
    let oldest = 0;
    
    for (const timestamp of this.lockTimestamps.values()) {
      const age = now - timestamp;
      if (age > oldest) oldest = age;
    }
    
    return oldest;
  }
}

// 单例模式
const taskLockManager = new TaskLockManager();

module.exports = taskLockManager;

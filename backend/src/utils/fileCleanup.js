/**
 * 文件清理工具 - 定期清理过期下载文件
 */

const fs = require('fs');
const path = require('path');
const logger = require('./logger');

// 下载目录
const DOWNLOAD_DIR = path.join(__dirname, '../../downloads');

// 文件保留时间（默认24小时）
const FILE_RETENTION_HOURS = parseInt(process.env.FILE_RETENTION_HOURS || '24', 10);

/**
 * 清理过期文件
 */
function cleanupOldFiles() {
  try {
    if (!fs.existsSync(DOWNLOAD_DIR)) {
      logger.info('[cleanup] Download directory does not exist, skipping cleanup');
      return;
    }

    const now = Date.now();
    const maxAge = FILE_RETENTION_HOURS * 60 * 60 * 1000; // 转换为毫秒
    let deletedCount = 0;
    let freedSpace = 0;

    const files = fs.readdirSync(DOWNLOAD_DIR);
    
    for (const file of files) {
      const filePath = path.join(DOWNLOAD_DIR, file);
      
      try {
        const stats = fs.statSync(filePath);
        
        // 跳过目录
        if (stats.isDirectory()) continue;
        
        // 检查文件年龄
        const fileAge = now - stats.mtimeMs;
        
        if (fileAge > maxAge) {
          const fileSize = stats.size;
          fs.unlinkSync(filePath);
          deletedCount++;
          freedSpace += fileSize;
          logger.info(`[cleanup] Deleted old file: ${file} (${(fileSize / 1024 / 1024).toFixed(2)}MB, age: ${(fileAge / 1000 / 60 / 60).toFixed(1)}h)`);
        }
      } catch (err) {
        logger.error(`[cleanup] Error processing file ${file}: ${err.message}`);
      }
    }

    if (deletedCount > 0) {
      logger.info(`[cleanup] Cleanup complete: deleted ${deletedCount} files, freed ${(freedSpace / 1024 / 1024).toFixed(2)}MB`);
    } else {
      logger.info('[cleanup] No old files to delete');
    }

    // 检查磁盘使用情况
    checkDiskUsage();
  } catch (err) {
    logger.error(`[cleanup] Cleanup failed: ${err.message}`);
  }
}

/**
 * 检查磁盘使用情况
 */
function checkDiskUsage() {
  try {
    if (!fs.existsSync(DOWNLOAD_DIR)) return;

    let totalSize = 0;
    const files = fs.readdirSync(DOWNLOAD_DIR);

    for (const file of files) {
      const filePath = path.join(DOWNLOAD_DIR, file);
      try {
        const stats = fs.statSync(filePath);
        if (stats.isFile()) {
          totalSize += stats.size;
        }
      } catch (err) {
        // 忽略单个文件错误
      }
    }

    const totalSizeMB = totalSize / 1024 / 1024;
    logger.info(`[cleanup] Current disk usage: ${totalSizeMB.toFixed(2)}MB (${files.length} files)`);

    // 如果超过1GB，发出警告
    if (totalSizeMB > 1024) {
      logger.warn(`[cleanup] ⚠️ Disk usage exceeds 1GB! Consider reducing FILE_RETENTION_HOURS`);
    }
  } catch (err) {
    logger.error(`[cleanup] Disk usage check failed: ${err.message}`);
  }
}

/**
 * 启动定期清理任务
 */
function startCleanupSchedule() {
  // 立即执行一次
  cleanupOldFiles();

  // 每小时执行一次
  const intervalMs = 60 * 60 * 1000; // 1小时
  setInterval(cleanupOldFiles, intervalMs);

  logger.info(`[cleanup] Cleanup scheduler started (interval: 1 hour, retention: ${FILE_RETENTION_HOURS} hours)`);
}

module.exports = {
  cleanupOldFiles,
  startCleanupSchedule,
  checkDiskUsage
};

/**
 * 文件清理工具 - 定期清理过期下载文件（全部使用异步 fs，避免阻塞事件循环）
 */

const fs = require('fs');
const fsp = require('fs').promises;
const path = require('path');
const logger = require('./logger');
const { getFileRetentionMsForTask, getFileRetentionHoursForTier } = require('./entitlements');

// 下载目录
const DOWNLOAD_DIR = path.join(__dirname, '../../downloads');

// 清理间隔（默认 1 小时）
const CLEANUP_INTERVAL_MS = parseInt(
  process.env.FILE_CLEANUP_INTERVAL_MS || String(60 * 60 * 1000),
  10
);

// 在途清理"互斥锁"，防止多个 timer 重叠
let cleaning = false;

/**
 * 清理过期文件（异步、限并发）
 */
async function cleanupOldFiles() {
  if (cleaning) {
    logger.debug('[cleanup] previous run still in progress, skip');
    return;
  }
  cleaning = true;
  try {
    let dirExists = true;
    try {
      await fsp.access(DOWNLOAD_DIR, fs.constants.F_OK);
    } catch {
      dirExists = false;
    }
    if (!dirExists) {
      logger.info('[cleanup] download directory does not exist, skip');
      return;
    }

    const now = Date.now();
    let deletedCount = 0;
    let freedSpace = 0;

    let entries = [];
    try {
      entries = await fsp.readdir(DOWNLOAD_DIR, { withFileTypes: true });
    } catch (err) {
      logger.error(`[cleanup] readdir failed: ${err.message}`);
      return;
    }

    // 简单的并发限制（10）
    const queue = entries.filter((e) => e.isFile()).map((e) => e.name);
    const CONCURRENCY = 10;
    const taskList = getCurrentTasks();

    async function worker() {
      while (queue.length) {
        const name = queue.shift();
        if (!name) return;
        const filePath = path.join(DOWNLOAD_DIR, name);
        try {
          const stat = await fsp.stat(filePath);
          if (!stat.isFile()) continue;

          const age = now - stat.mtimeMs;
          const task = taskList.find((item) => name.startsWith(item.taskId));
          const maxAge = await getFileRetentionMsForTask(task);
          if (age > maxAge) {
            const size = stat.size;
            try {
              await fsp.unlink(filePath);
              deletedCount++;
              freedSpace += size;
              logger.info(
                `[cleanup] deleted ${name} (${(size / 1024 / 1024).toFixed(2)}MB, age=${(age / 3600000).toFixed(1)}h)`
              );
            } catch (delErr) {
              logger.warn(`[cleanup] unlink failed for ${name}: ${delErr.message}`);
            }
          }
        } catch (statErr) {
          // 单个文件失败不影响整体
          logger.debug(`[cleanup] stat failed for ${name}: ${statErr.message}`);
        }
      }
    }

    const workers = Array.from({ length: Math.min(CONCURRENCY, queue.length) }, () => worker());
    await Promise.all(workers);

    if (deletedCount > 0) {
      logger.info(
        `[cleanup] done: deleted ${deletedCount} files, freed ${(freedSpace / 1024 / 1024).toFixed(2)}MB`
      );
    } else {
      logger.info('[cleanup] no old files to delete');
    }

    await checkDiskUsage();
  } catch (err) {
    logger.error(`[cleanup] failed: ${err.message}`);
  } finally {
    cleaning = false;
  }
}

function getCurrentTasks() {
  try {
    return require('../store').list();
  } catch {
    return [];
  }
}

/**
 * 异步统计磁盘使用情况
 */
async function checkDiskUsage() {
  try {
    let entries = [];
    try {
      entries = await fsp.readdir(DOWNLOAD_DIR, { withFileTypes: true });
    } catch {
      return;
    }

    let totalSize = 0;
    let fileCount = 0;
    for (const ent of entries) {
      if (!ent.isFile()) continue;
      try {
        const stat = await fsp.stat(path.join(DOWNLOAD_DIR, ent.name));
        if (stat.isFile()) {
          totalSize += stat.size;
          fileCount += 1;
        }
      } catch {}
    }

    const totalSizeMB = totalSize / 1024 / 1024;
    logger.info(`[cleanup] disk usage: ${totalSizeMB.toFixed(2)}MB (${fileCount} files)`);

    if (totalSizeMB > 1024) {
      logger.warn('[cleanup] ⚠️ disk usage > 1GB; consider lowering FILE_RETENTION_HOURS');
    }
  } catch (err) {
    logger.error(`[cleanup] disk usage check failed: ${err.message}`);
  }
}

/**
 * 启动定期清理任务
 */
function startCleanupSchedule() {
  // 立即触发一次（不阻塞）
  cleanupOldFiles().catch((e) => logger.error('[cleanup] initial run failed: ' + e.message));

  setInterval(() => {
    cleanupOldFiles().catch((e) => logger.error('[cleanup] scheduled run failed: ' + e.message));
  }, CLEANUP_INTERVAL_MS);

  logger.info(
    `[cleanup] scheduler started (interval=${(CLEANUP_INTERVAL_MS / 60000).toFixed(0)}min, retention guest=${getFileRetentionHoursForTier('guest')}h/free=${getFileRetentionHoursForTier('free')}h/pro=${getFileRetentionHoursForTier('pro')}h)`
  );
}

module.exports = {
  cleanupOldFiles,
  startCleanupSchedule,
  checkDiskUsage
};

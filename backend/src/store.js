/**
 * 任务存储 v3 - 异步操作 + 文件引用管理
 * 
 * 改进：
 * 1. 使用异步文件操作，避免阻塞事件循环
 * 2. 集成文件引用计数，防止过早删除
 * 3. 使用常量配置
 */

const fs = require('fs').promises;
const fsSync = require('fs');
const path = require('path');
const asyncFs = require('./utils/asyncFs');
const fileRefManager = require('./utils/fileRefManager');
const logger = require('./utils/logger');
const { CLEANUP, TIME } = require('./config/constants');

const DATA_DIR = path.join(__dirname, '../data');
const TASKS_FILE = path.join(DATA_DIR, 'tasks.json');
const DOWNLOAD_DIR = path.join(__dirname, '../downloads');

// 确保目录存在（同步，仅启动时）
if (!fsSync.existsSync(DATA_DIR)) {
  fsSync.mkdirSync(DATA_DIR, { recursive: true });
}

// 内存缓存
const tasks = new Map();

// 启动时从文件加载
async function loadFromFile() {
  try {
    const exists = await asyncFs.fileExists(TASKS_FILE);
    if (exists) {
      const data = await asyncFs.safeReadFile(TASKS_FILE);
      if (data) {
        const parsed = JSON.parse(data);
        for (const task of parsed) {
          tasks.set(task.taskId, task);
        }
        logger.info(`[store] Loaded ${tasks.size} tasks from disk`);
      }
    }
  } catch (e) {
    logger.error(`[store] Failed to load tasks: ${e.message}`);
  }
}

// 写入文件（异步）
async function saveToFile() {
  try {
    const data = Array.from(tasks.values());
    await asyncFs.safeWriteFile(TASKS_FILE, JSON.stringify(data, null, 2));
  } catch (e) {
    logger.error(`[store] Failed to save tasks: ${e.message}`);
  }
}

// 节流写入（避免频繁 IO）
let saveTimer = null;
function scheduleSave() {
  if (saveTimer) return;
  saveTimer = setTimeout(async () => {
    saveTimer = null;
    await saveToFile();
  }, 1000);
}

function save(task) {
  tasks.set(task.taskId, task);
  scheduleSave();
  return task;
}

function get(taskId) {
  return tasks.get(taskId);
}

function list() {
  // 按创建时间倒序
  return Array.from(tasks.values()).sort((a, b) => b.createdAt - a.createdAt);
}

function update(taskId, updates) {
  const task = tasks.get(taskId);
  if (task) {
    Object.assign(task, updates);
    scheduleSave();
    return task;
  }
  return null;
}

function remove(taskId) {
  const deleted = tasks.delete(taskId);
  if (deleted) scheduleSave();
  return deleted;
}

/**
 * 按 userId 删除任务及其关联文件
 */
async function removeByUserId(userId) {
  let count = 0;
  const taskIds = [];
  
  for (const [id, task] of tasks) {
    if (task.userId === userId) {
      taskIds.push(id);
    }
  }
  
  for (const id of taskIds) {
    await removeWithFiles(id);
    count++;
  }
  
  return count;
}

/**
 * 清理过期任务及其关联文件
 * @param {number} maxAgeMs 最大存活时间
 */
async function cleanup(maxAgeMs = CLEANUP.TASK_RETENTION) {
  const now = Date.now();
  let count = 0;
  const toDelete = [];

  for (const [id, task] of tasks) {
    if ((task.status === 'completed' || task.status === 'error') && now - task.createdAt > maxAgeMs) {
      toDelete.push(id);
    }
  }

  for (const id of toDelete) {
    await removeWithFiles(id);
    count++;
  }

  if (count > 0) {
    logger.info(`[cleanup] Cleaned up ${count} expired tasks`);
    await saveToFile();
  }
  
  return count;
}

/**
 * 删除任务及其所有关联文件（使用引用计数）
 */
async function removeWithFiles(taskId) {
  const task = tasks.get(taskId);
  if (!task) return false;

  try {
    // 列出所有关联文件
    const files = await asyncFs.listFiles(DOWNLOAD_DIR, `^${taskId}`);
    
    // 删除文件（检查引用计数）
    for (const file of files) {
      const filePath = path.join(DOWNLOAD_DIR, file);
      
      // 减少引用计数
      const canDelete = fileRefManager.removeRef(file);
      
      if (canDelete) {
        await asyncFs.safeUnlink(filePath);
      } else {
        logger.debug(`[store] File ${file} still has references, not deleting`);
      }
    }
  } catch (e) {
    logger.error(`[store] Failed to delete files for ${taskId}: ${e.message}`);
  }

  return remove(taskId);
}

// 启动时加载（异步）
loadFromFile().catch(err => {
  logger.error(`[store] Failed to load on startup: ${err.message}`);
});

// 定期清理（每小时）
setInterval(async () => {
  try {
    await cleanup();
  } catch (err) {
    logger.error(`[store] Cleanup error: ${err.message}`);
  }
}, CLEANUP.CLEANUP_INTERVAL);

// 首次启动时清理（延迟5秒，避免启动时阻塞）
setTimeout(async () => {
  try {
    await cleanup();
  } catch (err) {
    logger.error(`[store] Initial cleanup error: ${err.message}`);
  }
}, 5000);

module.exports = { save, get, list, update, remove, removeWithFiles, removeByUserId, cleanup };

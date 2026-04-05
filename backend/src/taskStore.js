/**
 * 任务持久化存储 - 支持断点续传
 * 将任务状态保存到文件系统，服务器重启后能恢复
 */

const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '../../data');
const TASKS_FILE = path.join(DATA_DIR, 'tasks.json');

// 确保目录存在
if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

// 内存中的任务缓存
let tasksCache = new Map();

// 从文件加载任务
function loadTasks() {
  try {
    if (fs.existsSync(TASKS_FILE)) {
      const data = JSON.parse(fs.readFileSync(TASKS_FILE, 'utf8'));
      tasksCache = new Map(Object.entries(data));
      console.log(`[taskStore] Loaded ${tasksCache.size} tasks from disk`);
    }
  } catch (e) {
    console.error('[taskStore] Failed to load tasks:', e.message);
  }
}

// 保存任务到文件
function saveTasks() {
  try {
    const data = Object.fromEntries(tasksCache);
    fs.writeFileSync(TASKS_FILE, JSON.stringify(data, null, 2));
  } catch (e) {
    console.error('[taskStore] Failed to save tasks:', e.message);
  }
}

// 初始化加载
loadTasks();

// 保存部分下载的文件路径（用于断点续传）
const partialFiles = new Map();

const taskStore = {
  /**
   * 保存任务
   */
  set(id, task) {
    tasksCache.set(id, {
      ...task,
      updatedAt: Date.now()
    });
    saveTasks();
  },

  /**
   * 获取任务
   */
  get(id) {
    return tasksCache.get(id);
  },

  /**
   * 获取所有任务
   */
  getAll() {
    return Array.from(tasksCache.values());
  },

  /**
   * 删除任务
   */
  delete(id) {
    tasksCache.delete(id);
    partialFiles.delete(id);
    saveTasks();
  },

  /**
   * 保存部分下载信息（用于断点续传）
   */
  savePartial(id, filePath, downloadedBytes) {
    const task = tasksCache.get(id);
    if (task) {
      task.partialFile = filePath;
      task.downloadedBytes = downloadedBytes;
      task.status = 'interrupted'; // 标记为中断
      tasksCache.set(id, task);
      saveTasks();
    }
  },

  /**
   * 获取部分下载信息
   */
  getPartial(id) {
    const task = tasksCache.get(id);
    if (task && task.partialFile && fs.existsSync(task.partialFile)) {
      return {
        filePath: task.partialFile,
        downloadedBytes: task.downloadedBytes || 0
      };
    }
    return null;
  },

  /**
   * 清除部分下载文件
   */
  clearPartial(id) {
    const partial = this.getPartial(id);
    if (partial) {
      try {
        fs.unlinkSync(partial.filePath);
      } catch (e) {}
    }
    const task = tasksCache.get(id);
    if (task) {
      delete task.partialFile;
      delete task.downloadedBytes;
      tasksCache.set(id, task);
      saveTasks();
    }
  },

  /**
   * 获取中断的任务（服务器重启后恢复）
   */
  getInterruptedTasks() {
    return Array.from(tasksCache.values()).filter(t => t.status === 'interrupted');
  },

  /**
   * 检查是否有未完成的任务
   */
  hasIncomplete(url) {
    for (const task of tasksCache.values()) {
      if (task.url === url && (task.status === 'downloading' || task.status === 'interrupted')) {
        return task;
      }
    }
    return null;
  }
};

module.exports = taskStore;

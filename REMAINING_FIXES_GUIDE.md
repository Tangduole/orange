# 🔧 剩余修复指南

## 需要手动完成的4个函数

本文档提供了剩余4个process函数的精确修复步骤。

---

## 1. processTikTok 修复

### 位置
`backend/src/controllers/download.js` 约第904行

### 需要修改的内容

#### 在函数开始添加任务锁：

```javascript
async function processTikTok(taskId, url, needAsr, options = ['video'], quality = null) {
  // 添加任务锁
  if (!taskLock.tryAcquire(taskId)) {
    logger.warn(`[task] ${taskId} is already being processed`);
    store.update(taskId, { 
      status: TASK_STATUS.ERROR, 
      error: 'Task is already in progress' 
    });
    return;
  }

  try {
    store.update(taskId, { status: TASK_STATUS.PARSING, progress: 5 });
    // ... 原有代码
```

#### 替换状态常量：

查找：`status: 'parsing'`  
替换为：`status: TASK_STATUS.PARSING`

查找：`status: 'downloading'`  
替换为：`status: TASK_STATUS.DOWNLOADING`

查找：`status: 'completed'`  
替换为：`status: TASK_STATUS.COMPLETED`

查找：`status: 'error'`  
替换为：`status: TASK_STATUS.ERROR`

#### 替换超时时间：

查找：`}, 30000);`  
替换为：`}, TIMEOUT.FFMPEG);`

查找：`timeout: 10000`  
替换为：`timeout: TIMEOUT.API_REQUEST`

查找：`timeout: 15000`  
替换为：`timeout: TIMEOUT.API_REQUEST`

查找：`120000`  
替换为：`TIMEOUT.DOWNLOAD`

#### 替换日志调用：

查找：`console.error('[tiktok audio] extract failed:', e.message);`  
替换为：`logger.error('[tiktok audio] extract failed:', e.message);`

查找：`console.log('[task] ' + taskId + ' tiktok completed');`  
替换为：`logger.info(`[task] ${taskId} tiktok completed`);`

查找：`console.error('[task] ' + taskId + ' tiktok failed:', error);`  
替换为：`logger.error(`[task] ${taskId} tiktok failed:`, error);`

#### 替换文件操作：

查找：`try { fs.unlinkSync(outputPath); } catch {}`  
替换为：`await asyncFs.safeUnlink(outputPath);`

#### 添加文件引用：

在 `update.downloadUrl = '/download/' + filename;` 之后添加：
```javascript
fileRefManager.addRef(filename);
```

在音频转换成功后添加：
```javascript
fileRefManager.addRef(taskId + '.mp3');
```

#### 添加用户计数（在saveHistory之前）：

```javascript
// 下载成功后增加用户计数
const task = store.get(taskId);
if (task.status === TASK_STATUS.COMPLETED) {
  const userDb = require('../userDb');
  if (task.userId) {
    await userDb.incrementDownloads(task.userId);
  } else if (task.guestIp) {
    await userDb.incrementGuestDownload(task.guestIp);
  }
}

saveHistory(taskId);
```

#### 添加finally块：

在catch块之后添加：
```javascript
  } finally {
    // 释放任务锁
    taskLock.release(taskId);
  }
}
```

---

## 2. processYouTube 修复

### 位置
`backend/src/controllers/download.js` 约第1050行

### 完整替换代码：

```javascript
/**
 * 处理 YouTube 下载 (TikHub API)
 */
async function processYouTube(taskId, url, needAsr, options = ['video'], quality = null) {
  // 获取任务锁
  if (!taskLock.tryAcquire(taskId)) {
    logger.warn(`[task] ${taskId} is already being processed`);
    store.update(taskId, { 
      status: TASK_STATUS.ERROR, 
      error: 'Task is already in progress' 
    });
    return;
  }

  try {
    logger.info('[processYouTube] CALLED for task:', taskId, 'url:', url, 'quality:', quality);
    const path = require('path');

    store.update(taskId, { status: TASK_STATUS.PARSING, progress: 5 });
    store.update(taskId, { requestedQuality: quality });

    // ========== TikHub v2 API (唯一下载方式,不使用 yt-dlp) ==========
    const { parseYouTubeV2 } = require('../services/tikhub');
    const result = await parseYouTubeV2(url, taskId, (percent, downloaded, total) => {
      store.update(taskId, { 
        status: percent < 30 ? TASK_STATUS.PARSING : TASK_STATUS.DOWNLOADING, 
        progress: percent, 
        downloadedBytes: downloaded || 0, 
        totalBytes: total || 0 
      });
    }, quality);

    const update = {
      status: TASK_STATUS.COMPLETED,
      width: result.width,
      height: result.height,
      quality: result.quality || `${result.height}p`,
      progress: 100,
      title: result.title,
      thumbnailUrl: result.thumbnailUrl,
      downloadUrl: `/download/${taskId}.mp4`,
      filePath: result.filePath,
      ext: 'mp4'
    };
    
    fileRefManager.addRef(`${taskId}.mp4`);
    store.update(taskId, update);

    // 下载成功后增加用户计数
    const task = store.get(taskId);
    if (task.status === TASK_STATUS.COMPLETED) {
      const userDb = require('../userDb');
      if (task.userId) {
        await userDb.incrementDownloads(task.userId);
      } else if (task.guestIp) {
        await userDb.incrementGuestDownload(task.guestIp);
      }
    }

    saveHistory(taskId);
    logger.info(`[task] ${taskId} youtube completed via TikHub v2 (${result.quality})`);
  } catch (error) {
    logger.error(`[task] ${taskId} youtube failed:`, error);
    store.update(taskId, { status: TASK_STATUS.ERROR, error: error.message });
  } finally {
    // 释放任务锁
    taskLock.release(taskId);
  }
}
```

---

## 3. processXiaohongshu 修复

### 位置
`backend/src/controllers/download.js` 约第1080行

### 完整替换代码：

```javascript
/**
 * 处理小红书下载 (TikHub API)
 */
async function processXiaohongshu(taskId, url, needAsr, options = ['video']) {
  // 获取任务锁
  if (!taskLock.tryAcquire(taskId)) {
    logger.warn(`[task] ${taskId} is already being processed`);
    store.update(taskId, { 
      status: TASK_STATUS.ERROR, 
      error: 'Task is already in progress' 
    });
    return;
  }

  try {
    const { parseXiaohongshu } = require('../services/tikhub');
    store.update(taskId, { status: TASK_STATUS.PARSING, progress: 5 });

    const result = await parseXiaohongshu(url, taskId, (percent) => {
      store.update(taskId, {
        status: percent < 20 ? TASK_STATUS.PARSING : TASK_STATUS.DOWNLOADING,
        progress: percent
      });
    });

    const update = {
      status: TASK_STATUS.COMPLETED,
      width: result.width,
      height: result.height,
      quality: result.quality,
      progress: 100,
      title: result.title,
      thumbnailUrl: result.thumbnailUrl,
    };

    if (result.filePath) {
      update.filePath = result.filePath;
      update.ext = result.ext;
      update.downloadUrl = `/download/${path.basename(result.filePath)}`;
      fileRefManager.addRef(path.basename(result.filePath));
    }

    if (result.isNote && result.imageFiles) {
      update.isNote = true;
      update.imageFiles = result.imageFiles;
    }

    store.update(taskId, update);

    // 下载成功后增加用户计数
    const task = store.get(taskId);
    if (task.status === TASK_STATUS.COMPLETED) {
      const userDb = require('../userDb');
      if (task.userId) {
        await userDb.incrementDownloads(task.userId);
      } else if (task.guestIp) {
        await userDb.incrementGuestDownload(task.guestIp);
      }
    }

    saveHistory(taskId);
    logger.info(`[task] ${taskId} xiaohongshu completed`);
  } catch (error) {
    logger.error(`[task] ${taskId} xiaohongshu failed:`, error);
    store.update(taskId, { status: TASK_STATUS.ERROR, error: error.message });
  } finally {
    // 释放任务锁
    taskLock.release(taskId);
  }
}
```

---

## 4. processInstagram 修复

### 位置
`backend/src/controllers/download.js` 约第1120行

### 完整替换代码：

```javascript
/**
 * 处理 Instagram 下载（TikHub API）
 */
async function processInstagram(taskId, url, needAsr, options = ['video']) {
  // 获取任务锁
  if (!taskLock.tryAcquire(taskId)) {
    logger.warn(`[task] ${taskId} is already being processed`);
    store.update(taskId, { 
      status: TASK_STATUS.ERROR, 
      error: 'Task is already in progress' 
    });
    return;
  }

  try {
    const { parseInstagram } = require('../services/tikhub');
    store.update(taskId, { status: TASK_STATUS.PARSING, progress: 10 });

    const info = await parseInstagram(url);
    store.update(taskId, { title: info.title, thumbnailUrl: info.thumbnailUrl, progress: 20 });

    // 下载视频
    const outputPath = path.join(__dirname, '../../downloads', `${taskId}.mp4`);
    store.update(taskId, { status: TASK_STATUS.DOWNLOADING, progress: 30 });

    await downloadToStream(info.videoUrl, outputPath, TIMEOUT.DOWNLOAD);

    const update = {
      status: TASK_STATUS.COMPLETED,
      width: info.width,
      height: info.height,
      quality: `${info.width}x${info.height}`,
      progress: 100,
      title: info.title,
      thumbnailUrl: info.thumbnailUrl,
      downloadUrl: `/download/${taskId}.mp4`,
      filePath: outputPath,
      ext: 'mp4'
    };

    fileRefManager.addRef(`${taskId}.mp4`);
    store.update(taskId, update);

    // 下载成功后增加用户计数
    const task = store.get(taskId);
    if (task.status === TASK_STATUS.COMPLETED) {
      const userDb = require('../userDb');
      if (task.userId) {
        await userDb.incrementDownloads(task.userId);
      } else if (task.guestIp) {
        await userDb.incrementGuestDownload(task.guestIp);
      }
    }

    saveHistory(taskId);
    logger.info(`[task] ${taskId} instagram completed`);
  } catch (error) {
    logger.error(`[task] ${taskId} instagram failed:`, error);
    store.update(taskId, { status: TASK_STATUS.ERROR, error: error.message });
  } finally {
    // 释放任务锁
    taskLock.release(taskId);
  }
}
```

---

## 5. 其他辅助函数修复

### getStatus 函数

查找：`console.error('[history]', e.message)`  
替换为：`logger.error('[history]', e.message)`

### getHistory 函数

查找：`console.error('[history] DB query failed:', e.message);`  
替换为：`logger.error('[history] DB query failed:', e.message);`

### getVideoInfo 函数

查找所有：`console.log` 和 `console.error`  
替换为：`logger.info` 和 `logger.error`

---

## 验证步骤

### 1. 语法检查
```bash
node -c backend/src/controllers/download.js
```

### 2. 启动测试
```bash
cd backend
npm start
```

### 3. 功能测试
- 测试TikTok下载
- 测试YouTube下载
- 测试小红书下载
- 测试Instagram下载
- 测试并发下载
- 测试失败不扣配额

### 4. 日志检查
```bash
tail -f backend/logs/combined.log
tail -f backend/logs/error.log
```

---

## 完成后的检查清单

- [ ] 所有4个process函数已更新
- [ ] 所有console.log已替换为logger
- [ ] 所有魔法数字已替换为常量
- [ ] 所有任务锁已添加
- [ ] 所有文件引用已添加
- [ ] 所有用户计数已修复
- [ ] 语法检查通过
- [ ] 启动测试通过
- [ ] 功能测试通过
- [ ] 日志正常输出

---

## 预计时间

- processTikTok: 15分钟
- processYouTube: 5分钟
- processXiaohongshu: 5分钟
- processInstagram: 5分钟
- 辅助函数: 5分钟
- 测试验证: 15分钟

**总计**: 约50分钟

---

## 遇到问题？

如果遇到问题，检查：

1. 是否所有导入语句都在文件顶部
2. 是否所有常量都正确导入
3. 是否所有async/await都正确使用
4. 是否所有finally块都正确添加
5. 日志文件是否有错误信息

---

**完成这些修复后，整个项目的代码质量将达到生产级别！** 🎉


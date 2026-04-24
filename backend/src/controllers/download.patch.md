# Download Controller 修复补丁

## 需要应用的关键修改

### 1. 在文件顶部添加新的导入

```javascript
// 在现有导入后添加
const taskLock = require('../utils/taskLock');
const cacheManager = require('../utils/cacheManager');
const asyncFs = require('../utils/asyncFs');
const fileRefManager = require('../utils/fileRefManager');
const logger = require('../utils/logger');
const { 
  QUALITY, 
  TIMEOUT, 
  LIMITS, 
  TASK_STATUS, 
  RESPONSE_CODE,
  HTTP_STATUS 
} = require('../config/constants');
```

### 2. 替换缓存实现

**查找**：
```javascript
// TikHub API 简单内存缓存(5分钟 TTL)
const infoCache = new Map();
const INFO_CACHE_TTL = 5 * 60 * 1000;

function getCachedInfo(key, fetcher) {
  const cached = infoCache.get(key);
  if (cached && Date.now() - cached.ts < INFO_CACHE_TTL) {
    console.log(`[cache] HIT: ${key}`);
    return Promise.resolve(cached.data);
  }
  console.log(`[cache] MISS: ${key}`);
  return fetcher().then(data => {
    infoCache.set(key, { data, ts: Date.now() });
    return data;
  });
}
```

**替换为**：
```javascript
// 使用 LRU 缓存管理器
function getCachedInfo(key, fetcher) {
  return cacheManager.getOrSet(key, fetcher, 'info');
}
```

### 3. 在processDownload开始处添加任务锁

**查找**：
```javascript
async function processDownload(taskId, url, needAsr, options = ['video'], quality = null) {
  try {
    const normalizedOptions = ...
```

**替换为**：
```javascript
async function processDownload(taskId, url, needAsr, options = ['video'], quality = null) {
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
    const normalizedOptions = ...
```

### 4. 在processDownload结束处释放锁

**在所有 catch 块和 finally 中添加**：
```javascript
  } catch (error) {
    logger.error(`[task] ${taskId} failed:`, error);
    store.update(taskId, { status: TASK_STATUS.ERROR, error: error.message });
  } finally {
    // 释放任务锁
    taskLock.release(taskId);
  }
}
```

### 5. 替换所有魔法数字

**查找并替换**：
```javascript
// 旧代码
if (selectedHeight > 720 && !isVip) {

// 新代码
if (selectedHeight > QUALITY.HD_THRESHOLD && !isVip) {
```

```javascript
// 旧代码
setTimeout(() => { ff.kill('SIGKILL'); reject(new Error('timeout')); }, 30000);

// 新代码
setTimeout(() => { ff.kill('SIGKILL'); reject(new Error('timeout')); }, TIMEOUT.FFMPEG);
```

### 6. 替换同步文件操作

**查找**：
```javascript
fs.writeFileSync(filepath, text, 'utf-8');
```

**替换为**：
```javascript
await asyncFs.safeWriteFile(filepath, text, 'utf-8');
```

**查找**：
```javascript
try { fs.unlinkSync(audioPath); } catch {}
```

**替换为**：
```javascript
await asyncFs.safeUnlink(audioPath);
```

### 7. 添加文件引用管理

**在下载文件后添加**：
```javascript
// 下载完成后
const filename = path.basename(result.filePath);
fileRefManager.addRef(filename);
```

**在删除文件前检查**：
```javascript
// 删除前检查引用
const filename = path.basename(filePath);
if (fileRefManager.removeRef(filename)) {
  await asyncFs.safeUnlink(filePath);
}
```

### 8. 统一日志调用

**查找所有**：
```javascript
console.log('[task] ...');
console.error('[task] ...');
```

**替换为**：
```javascript
logger.info('[task] ...');
logger.error('[task] ...');
```

### 9. 修复用户限额检查时序

**查找**：
```javascript
// 增加登录用户下载计数
await userDb.incrementDownloads(userId);

// ... 后面才开始下载
processDownload(taskId, url, ...).catch(err => {
```

**替换为**：
```javascript
// 先不增加计数，在下载成功后再增加
// 移除这里的 incrementDownloads

// 在 processDownload 成功完成时调用
async function processDownload(taskId, url, ...) {
  try {
    // ... 下载逻辑
    
    // 下载成功后增加计数
    const task = store.get(taskId);
    if (task.userId) {
      await userDb.incrementDownloads(task.userId);
    } else if (task.guestIp) {
      await userDb.incrementGuestDownload(task.guestIp);
    }
  } catch (error) {
    // 下载失败不增加计数
  }
}
```

### 10. 改进错误处理

**添加统一的错误处理函数**：
```javascript
function handleTaskError(taskId, error, context = '') {
  const errorMessage = error.message || 'Unknown error';
  logger.error(`[task] ${taskId} ${context} failed: ${errorMessage}`, {
    stack: error.stack,
    context
  });
  
  store.update(taskId, {
    status: TASK_STATUS.ERROR,
    error: errorMessage,
    errorContext: context
  });
}
```

**使用方式**：
```javascript
try {
  // 处理逻辑
} catch (error) {
  handleTaskError(taskId, error, 'download');
}
```

---

## 应用补丁的步骤

### 方式1：手动应用（推荐）

1. 打开 `backend/src/controllers/download.js`
2. 按照上述修改逐一应用
3. 保存文件
4. 运行测试验证

### 方式2：使用脚本（如果我提供完整文件）

```bash
# 备份原文件
cp backend/src/controllers/download.js backend/src/controllers/download.js.backup

# 应用新文件
# （需要我生成完整的修复后文件）
```

---

## 验证修复

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
- 测试并发下载（同一URL多次提交）
- 测试文件清理
- 测试缓存命中
- 测试错误恢复

---

## 预期效果

✅ 并发安全：同一任务不会被重复处理
✅ 内存稳定：缓存不会无限增长
✅ 性能提升：异步IO不阻塞事件循环
✅ 错误处理：统一的错误格式和日志
✅ 代码质量：消除魔法数字，提高可读性

---

## 注意事项

⚠️ **重要**：由于download.js文件较大（1500+行），建议：
1. 先备份原文件
2. 分批应用修改
3. 每次修改后测试
4. 使用版本控制（git）跟踪变更

如果需要，我可以生成完整的修复后文件。

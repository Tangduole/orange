/**
 * 小电驴 - 后端入口
 */

require('dotenv').config();

const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const path = require('path');
const fs = require('fs');
const logger = require('./utils/logger');
const { validateEnv, isProduction } = require('./utils/envValidator');
const { startCleanupSchedule } = require('./utils/fileCleanup');
const { apiLimiter } = require('./middleware/rateLimiter');
const apiRouter = require('./routes/api');
const authRouter = require('./routes/auth');
const subscribeRouter = require('./routes/subscribe');
const healthRouter = require('./routes/health');
const { DOWNLOAD_DIR } = require('./services/yt-dlp');
const store = require('./store');

// 验证环境变量
validateEnv();

// 确保关键目录存在（注意：__dirname 是 backend/src，向上一级才是 backend/）
const backendRoot = path.join(__dirname, '..');
for (const dir of ['downloads']) {
  const p = path.join(backendRoot, dir);
  if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
}

const app = express();
const PORT = process.env.PORT || 3000;

// 安全中间件
app.use(helmet({
  contentSecurityPolicy: false, // 允许内联脚本（前端需要）
  crossOriginEmbedderPolicy: false
}));

// 信任代理（用于获取真实IP）
app.set('trust proxy', 1);

// HTTPS 重定向（生产环境）
if (isProduction()) {
  app.use((req, res, next) => {
    if (req.headers['x-forwarded-proto'] !== 'https') {
      return res.redirect('https://' + req.headers.host + req.url);
    }
    next();
  });
}

// 中间件
// CORS 配置（默认白名单 + 通过 ENV 扩展）
//   CORS_ALLOWED_ORIGINS  : 逗号分隔的 origin 列表（精确匹配）
//   CORS_ALLOWED_PATTERNS : 逗号分隔的正则字符串（按 RegExp 解析）
const defaultOrigins = [
  'https://orangedl.com',
  'https://www.orangedl.com',
  'https://api.orangedl.com',
  /^https:\/\/frontend-.*\.vercel\.app$/, // Vercel preview
  /^http:\/\/localhost:\d+$/              // 本地开发
];
const extraOrigins = String(process.env.CORS_ALLOWED_ORIGINS || '')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean);
const extraPatterns = String(process.env.CORS_ALLOWED_PATTERNS || '')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean)
  .map(p => {
    try { return new RegExp(p); } catch { return null; }
  })
  .filter(Boolean);
const allowedOrigins = [...defaultOrigins, ...extraOrigins, ...extraPatterns];

app.use(cors({
  origin: function (origin, callback) {
    // 允许无 origin 的请求（如 curl、服务器间调用）
    if (!origin) return callback(null, true);
    const allowed = allowedOrigins.some(pattern =>
      typeof pattern === 'string' ? origin === pattern : pattern.test(origin)
    );
    if (allowed) return callback(null, true);
    callback(new Error('Not allowed by CORS'));
  },
  credentials: true
}));

// LemonSqueezy webhook 必须拿到原始 body 才能做 HMAC 校验，
// 因此对 /api/subscribe/webhook 单独使用 express.raw，不参与全局 JSON 解析。
app.use('/api/subscribe/webhook', express.raw({ type: '*/*', limit: '1mb' }));

// 其它请求统一走 JSON
app.use((req, res, next) => {
  if (req.originalUrl === '/api/subscribe/webhook') return next();
  return express.json({ limit: '1mb' })(req, res, next);
});

// 全局速率限制
app.use('/api', apiLimiter);

// API 路由
app.use('/api', apiRouter);
app.use('/api/auth', authRouter);
app.use('/api/subscribe', subscribeRouter);
app.use('/health', healthRouter);

// 静态提供下载文件（带正确的 Content-Disposition 头）
app.use('/download', (req, res, next) => {
  // 防止路径遍历攻击
  const normalized = path.normalize(req.path);
  if (normalized.includes('..')) {
    return res.status(403).send('Forbidden');
  }
  const filePath = path.join(DOWNLOAD_DIR, normalized);
  if (fs.existsSync(filePath)) {
    const rawFilename = path.basename(filePath);
    const ext = path.extname(rawFilename).toLowerCase();
    
    // 从任务元数据获取视频标题作为下载文件名
    let downloadFilename = rawFilename;
    try {
      const taskId = rawFilename.replace(/_thumb|_cover|_audio|\.mp4|\.mp3|\.jpg|\.jpeg|\.png|\.webp|\.srt|\.vtt/gi, '');
      const task = store.get(taskId);
      if (task?.title) {
        const safeTitle = task.title.replace(/[\\/:*?"<>|]/g, '_').slice(0, 120);
        if (rawFilename.includes('_thumb') || rawFilename.includes('_cover')) {
          downloadFilename = safeTitle + '_cover' + ext;
        } else if (rawFilename.includes('_audio') || ext === '.mp3') {
          downloadFilename = safeTitle + ext;
        } else {
          downloadFilename = safeTitle + ext;
        }
      }
    } catch (e) {
      // fallback to raw filename
    }
    
    // 设置正确的 MIME 类型
    const mimeTypes = {
      '.mp4': 'video/mp4',
      '.mp3': 'audio/mpeg',
      '.jpg': 'image/jpeg',
      '.jpeg': 'image/jpeg',
      '.png': 'image/png',
      '.webp': 'image/webp',
      '.srt': 'text/plain',
      '.vtt': 'text/vtt',
    };
    
    const mimeType = mimeTypes[ext] || 'application/octet-stream';
    res.setHeader('Content-Type', mimeType);

    // 视频/音频强制下载（不用 inline，避免浏览器拦截）
    // 图片保持 inline（可以预览）
    const encodedFilename = encodeURIComponent(downloadFilename);
    const isMedia = ['.mp4', '.mp3', '.avi', '.mov', '.mkv', '.flv', '.webm'].includes(ext);
    const disposition = isMedia ? 'attachment' : 'inline';
    res.setHeader('Content-Disposition', `${disposition}; filename*=UTF-8''${encodedFilename}`);
    
    // 允许跨域访问
    res.setHeader('Access-Control-Allow-Origin', '*');
    
    // 禁用缓存，确保每次下载都是最新的
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate, max-age=0');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
    
    // 发送文件
    res.sendFile(filePath);
  } else {
    res.status(404).json({ error: 'File not found' });
  }
});

// Root route - return a simple health check or welcome message
app.get('/', (req, res) => {
  res.json({ 
    message: 'Orange后端运行中',
    api: '/api',
    status: 'ok'
  });
});

// 管理面板
app.get('/admin', (req, res) => {
  try {
    const html = fs.readFileSync(path.join(__dirname, 'admin.html'), 'utf-8');
    res.setHeader('Content-Type', 'text/html');
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.send(html);
  } catch (e) {
    res.status(500).send('admin.html not found: ' + e.message);
  }
});

// 前端静态文件 (生产环境)
const frontendDist = path.join(__dirname, '../../frontend/dist');
if (fs.existsSync(frontendDist)) {
  app.use(express.static(frontendDist));
  app.get('*', (req, res) => {
    res.sendFile(path.join(frontendDist, 'index.html'));
  });
}

// 全局错误处理 - 防止未捕获的 async 错误导致进程崩溃
process.on('uncaughtException', (err) => {
  logger.error('[FATAL] Uncaught Exception:', err);
  // 生产环境不退出，记录错误后继续运行
  if (!isProduction()) {
    process.exit(1);
  }
});

process.on('unhandledRejection', (reason, promise) => {
  logger.error('[FATAL] Unhandled Rejection at:', promise, 'reason:', reason?.message || reason);
});

// 启动文件清理任务
startCleanupSchedule();

// 启动
app.listen(PORT, '0.0.0.0', () => {
  logger.info(`🚀 Orange后端启动成功`);
  logger.info(`   环境: ${process.env.NODE_ENV || 'development'}`);
  logger.info(`   地址: http://0.0.0.0:${PORT}`);
  logger.info(`   API: http://0.0.0.0:${PORT}/api`);
  logger.info(`   下载目录: ${DOWNLOAD_DIR}`);
});

module.exports = app;

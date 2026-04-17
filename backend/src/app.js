/**
 * 小电驴 - 后端入口
 */

const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const apiRouter = require('./routes/api');
const authRouter = require('./routes/auth');
const subscribeRouter = require('./routes/subscribe');
const { DOWNLOAD_DIR } = require('./services/yt-dlp');

const backend = require('path').join(__dirname, '..', '..');
if (!fs.existsSync(path.join(backend, 'data'))) {
  fs.mkdirSync(path.join(backend, 'data'), { recursive: true });
}
if (!fs.existsSync(path.join(backend, 'downloads'))) {
  fs.mkdirSync(path.join(backend, 'downloads'), { recursive: true });
}

const app = express();
const PORT = process.env.PORT || 3000;

// 中间件
// CORS 配置
const allowedOrigins = [
  'https://orangedl.com',
  'https://www.orangedl.com',
  /^https:\/\/frontend-.*\.vercel\.app$/, // Vercel preview
  /^http:\/\/localhost:\d+$/,             // 本地开发
];

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
app.use(express.json());

// API 路由
app.use('/api', apiRouter);
app.use('/api/auth', authRouter);
app.use('/api/subscribe', subscribeRouter);

// 静态提供下载文件（带正确的 Content-Disposition 头）
app.use('/download', (req, res, next) => {
  // 防止路径遍历攻击
  const normalized = path.normalize(req.path);
  if (normalized.includes('..')) {
    return res.status(403).send('Forbidden');
  }
  const filePath = path.join(DOWNLOAD_DIR, normalized);
  if (fs.existsSync(filePath)) {
    const filename = path.basename(filePath);
    const ext = path.extname(filename).toLowerCase();
    
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
    
    // inline 播放（浏览器会尝试播放而不是下载）
    const encodedFilename = encodeURIComponent(filename);
    res.setHeader('Content-Disposition', `inline; filename*=UTF-8''${encodedFilename}`);
    
    // 允许跨域访问
    res.setHeader('Access-Control-Allow-Origin', '*');
    
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
  res.sendFile(path.join(__dirname, '../admin.html'));
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
  console.error('[FATAL] Uncaught Exception:', err.message);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('[FATAL] Unhandled Rejection at:', promise, 'reason:', reason?.message || reason);
});

// 启动
app.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 Orange后端启动成功`);
  console.log(`   http://0.0.0.0:${PORT}`);
  console.log(`   API: http://0.0.0.0:${PORT}/api`);
  console.log(`   下载目录: ${DOWNLOAD_DIR}`);
});

module.exports = app;
// force deploy 1774513672
// deploy 1774516790

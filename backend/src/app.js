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
app.use(cors());
app.use(express.json());

// API 路由
app.use('/api', apiRouter);
app.use('/api/auth', authRouter);
app.use('/api/subscribe', subscribeRouter);

// 静态提供下载文件（带正确的 Content-Disposition 头）
app.use('/download', (req, res, next) => {
  const filePath = path.join(DOWNLOAD_DIR, req.path);
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
    message: '小电驴后端运行中',
    api: '/api',
    status: 'ok'
  });
});

// 前端静态文件 (生产环境)
const frontendDist = path.join(__dirname, '../../frontend/dist');
if (fs.existsSync(frontendDist)) {
  app.use(express.static(frontendDist));
  app.get('*', (req, res) => {
    res.sendFile(path.join(frontendDist, 'index.html'));
  });
}

// 启动
app.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 小电驴后端启动成功`);
  console.log(`   http://0.0.0.0:${PORT}`);
  console.log(`   API: http://0.0.0.0:${PORT}/api`);
  console.log(`   下载目录: ${DOWNLOAD_DIR}`);
});

module.exports = app;
// force deploy 1774513672
// deploy 1774516790

/**
 * API 路由 v2
 */

const express = require('express');
const fs = require('fs');
const path = require('path');
const auth = require('../auth');
const {
  createDownload,
  getInfo,
  getStatus,
  getHistory,
  getSystemStatus,
  getAdminStats,
  deleteTask,
  clearHistory,
  adminClearAllHistory,
  getVideoInfo
} = require('../controllers/download');

// 动态读取真实版本号
const packageJson = JSON.parse(fs.readFileSync(path.join(__dirname, '../../package.json'), 'utf8'));
const APP_VERSION = packageJson.version || '1.0.0';

const router = express.Router();

// 创建下载任务
router.post('/download', createDownload);

// 获取视频信息（不下载）
router.get('/info', getInfo);
router.post('/video-info', getVideoInfo);

// 查询任务状态
router.get('/status/:taskId', getStatus);

// 获取历史记录
router.get('/history', getHistory);

// 删除任务
router.delete('/tasks/:taskId', auth.required, deleteTask);
router.delete('/history', auth.optional, clearHistory);
router.delete('/history/all', adminClearAllHistory);

// 系统状态
router.get('/system/status', getSystemStatus);
router.get('/admin/stats', getAdminStats);

// 健康检查
router.get('/health', (req, res) => {
  res.json({
    code: 0,
    data: {
      status: 'ok',
      version: APP_VERSION
    }
  });
});


// YouTube Cookies 上传（管理员）
const multer = require('multer');
const cookiesUpload = multer({ dest: '/tmp/' });
router.post('/admin/cookies', cookiesUpload.single('cookies'), (req, res) => {
  try {
    if (!req.file) return res.json({ code: 400, message: 'No file' });
    const fs = require('fs');
    const destPath = require('path').join(__dirname, '../../data/youtube_cookies.txt');
    fs.mkdirSync(require('path').dirname(destPath), { recursive: true });
    fs.copyFileSync(req.file.path, destPath);
    fs.unlinkSync(req.file.path);
    res.json({ code: 0, message: 'Cookies uploaded successfully' });
  } catch (e) {
    console.error('[cookies] Upload error:', e.message);
    res.status(500).json({ code: 500, message: e.message });
  }
});


// Debug: 检查 cookies 文件
router.get('/admin/cookies-debug', (req, res) => {
  const fs = require('fs');
  const path = require('path');
  
  // 检查多个可能的路径
  const paths = [
    path.join(__dirname, '../../data/youtube_cookies.txt'),
    path.join(process.cwd(), 'data/youtube_cookies.txt'),
    '/app/data/youtube_cookies.txt',
    '/app/backend/data/youtube_cookies.txt'
  ];
  
  const results = {};
  for (const p of paths) {
    try {
      const exists = fs.existsSync(p);
      const size = exists ? fs.statSync(p).size : 0;
      const firstLine = exists ? fs.readFileSync(p, 'utf-8').split(String.fromCharCode(10))[0] : '';
      results[p] = { exists, size, firstLine };
    } catch (e) {
      results[p] = { error: e.message };
    }
  }
  
  res.json({ code: 0, data: { __dirname, cwd: process.cwd(), results } });
});


router.get('/admin/env-debug', (req, res) => {
  const vars = ['TIKHUB_API_KEY_INSTAGRAM', 'TIKHUB_API_KEY_DOUYIN', 'TIKHUB_API_KEY_YT', 'CLOUDFLARE_ACCOUNT_ID'];
  const result = {};
  for (const v of vars) {
    const val = process.env[v];
    result[v] = val ? 'SET (' + val.length + ' chars)' : 'NOT SET';
  }
  res.json({ code: 0, data: result });
});

module.exports = router;

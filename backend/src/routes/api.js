/**
 * API 路由 v2
 */

const express = require('express');
const fs = require('fs');
const path = require('path');
const auth = require('../auth');
const logger = require('../utils/logger');
const { downloadLimiter } = require('../middleware/rateLimiter');
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

// 创建下载任务（带速率限制）
router.post('/download', downloadLimiter, createDownload);

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
router.delete('/history/all', auth.requireAdminKey, adminClearAllHistory);

// 系统状态
router.get('/system/status', auth.requireAdminKey, getSystemStatus);
router.get('/admin/stats', auth.requireAdminKey, getAdminStats);

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
router.post('/admin/cookies', auth.requireAdminKey, cookiesUpload.single('cookies'), (req, res) => {
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
router.get('/admin/cookies-debug', auth.requireAdminKey, (req, res) => {
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


router.get('/admin/env-debug', auth.requireAdminKey, (req, res) => {
  const vars = ['TIKHUB_API_KEY_INSTAGRAM', 'TIKHUB_API_KEY_DOUYIN', 'TIKHUB_API_KEY_YT', 'CLOUDFLARE_ACCOUNT_ID'];
  const result = {};
  for (const v of vars) {
    const val = process.env[v];
    result[v] = val ? 'SET (' + val.length + ' chars)' : 'NOT SET';
  }
  res.json({ code: 0, data: result });
});

module.exports = router;

// ============ 会员管理 ============
router.get('/admin/users', auth.requireAdminKey, async (req, res) => {
  const userDb = require('../userDb');
  const { page = 1, limit = 20, tier, search } = req.query;
  try {
    let sql = 'SELECT id, email, tier, subscription_status, subscription_ends_at, downloads_count, created_at FROM users WHERE 1=1';
    const args = [];
    if (tier) { sql += ' AND tier = ?'; args.push(tier); }
    if (search) { sql += ' AND email LIKE ?'; args.push(`%${search}%`); }
    sql += ' ORDER BY created_at DESC LIMIT ? OFFSET ?';
    args.push(Number(limit), (Number(page) - 1) * Number(limit));
    const result = await userDb.db.execute({ sql, args });
    const totalR = await userDb.db.execute('SELECT COUNT(*) as count FROM users' + (tier ? ` WHERE tier='${tier}'` : ''));
    res.json({ code: 0, data: { users: result.rows, total: totalR.rows[0]?.count || 0, page: Number(page), limit: Number(limit) } });
  } catch (e) { res.status(500).json({ code: 1, message: e.message }); }
});

router.post('/admin/users/:id/set-tier', auth.requireAdminKey, async (req, res) => {
  const userDb = require('../userDb');
  const { id } = req.params;
  const { tier, subscription_status, subscription_ends_at } = req.body;
  try {
    await userDb.db.execute({
      sql: 'UPDATE users SET tier = ?, subscription_status = ?, subscription_ends_at = ? WHERE id = ?',
      args: [tier || 'free', subscription_status || 'inactive', subscription_ends_at || null, id]
    });
    res.json({ code: 0, message: '会员设置成功' });
  } catch (e) { res.status(500).json({ code: 1, message: e.message }); }
});

router.post('/admin/users/:id/set-downloads', auth.requireAdminKey, async (req, res) => {
  const userDb = require('../userDb');
  const { id } = req.params;
  const { downloads_count } = req.body;
  try {
    await userDb.db.execute({ sql: 'UPDATE users SET downloads_count = ? WHERE id = ?', args: [Number(downloads_count), id] });
    res.json({ code: 0, message: '下载次数已更新' });
  } catch (e) { res.status(500).json({ code: 1, message: e.message }); }
});

router.post('/admin/users/:id/set-daily-limit', auth.requireAdminKey, async (req, res) => {
  const userDb = require('../userDb');
  const { id } = req.params;
  const { daily_limit } = req.body;
  try {
    await userDb.db.execute({ sql: 'UPDATE users SET daily_limit = ? WHERE id = ?', args: [Number(daily_limit), id] });
    res.json({ code: 0, message: '每日限制已更新' });
  } catch (e) { res.status(500).json({ code: 1, message: e.message }); }
});

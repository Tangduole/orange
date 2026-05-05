/**
 * API 路由 v2
 */

const express = require('express');
const fs = require('fs');
const path = require('path');
const auth = require('../auth');
const logger = require('../utils/logger');
const { downloadLimiter } = require('../middleware/rateLimiter');
const { USER_TIER, SUBSCRIPTION_STATUS } = require('../config/constants');
const {
  createDownload,
  getInfo,
  getStatus,
  getHistory,
  getSystemStatus,
  getAdminStats,
  deleteTask,
  clearHistory,
  adminClearAllHistory
} = require('../controllers/download');
const { getVideoInfo } = require('../controllers/videoInfo');

// 动态读取真实版本号
const packageJson = JSON.parse(
  fs.readFileSync(path.join(__dirname, '../../package.json'), 'utf8')
);
const APP_VERSION = packageJson.version || '1.0.0';

const router = express.Router();

// 创建下载任务（带速率限制）
router.post('/download', downloadLimiter, auth.optional, createDownload);

// 获取视频信息（不下载）
router.get('/info', getInfo);
router.post('/video-info', auth.optional, getVideoInfo);

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

router.get('/admin/env-debug', auth.requireAdminKey, (req, res) => {
  const vars = [
    'TIKHUB_API_KEY_INSTAGRAM',
    'TIKHUB_API_KEY_DOUYIN',
    'TIKHUB_API_KEY_YT',
    'TIKHUB_API_KEY_XHS',
    'TIKHUB_API_KEY_WECHAT',
    'CLOUDFLARE_ACCOUNT_ID',
    'TURSO_DATABASE_URL',
    'RESEND_API_KEY',
    'LEMON_SQUEEZY_API_KEY',
    'LEMON_SQUEEZY_WEBHOOK_SECRET'
  ];
  const result = {};
  for (const v of vars) {
    // 仅返回是否设置，不返回长度/前缀，避免任何信息侧信道
    result[v] = process.env[v] ? 'SET' : 'NOT SET';
  }
  res.json({ code: 0, data: result });
});

// ============ 会员管理 ============

const ALLOWED_TIERS = new Set([USER_TIER.FREE, USER_TIER.PRO]);
const ALLOWED_SUB_STATUS = new Set([
  SUBSCRIPTION_STATUS.ACTIVE,
  SUBSCRIPTION_STATUS.CANCELLED,
  SUBSCRIPTION_STATUS.PAST_DUE,
  SUBSCRIPTION_STATUS.NONE,
  'expired',
  'inactive'
]);

router.get('/admin/users', auth.requireAdminKey, async (req, res) => {
  const userDb = require('../userDb');

  // 解析 + 校验 query
  let { page = 1, limit = 20, tier, search } = req.query;
  page = Math.max(1, Number(page) || 1);
  limit = Math.max(1, Math.min(200, Number(limit) || 20));

  // tier 仅允许白名单值，杜绝 SQL 注入
  if (tier && !ALLOWED_TIERS.has(String(tier))) {
    return res.status(400).json({ code: 400, message: 'invalid tier' });
  }

  try {
    let sql =
      'SELECT id, email, tier, subscription_status, subscription_ends_at, ' +
      'downloads_count, daily_downloads, created_at FROM users WHERE 1=1';
    const args = [];
    if (tier) { sql += ' AND tier = ?'; args.push(String(tier)); }
    if (search) { sql += ' AND email LIKE ?'; args.push(`%${String(search)}%`); }
    sql += ' ORDER BY created_at DESC LIMIT ? OFFSET ?';
    args.push(limit, (page - 1) * limit);

    const result = await userDb.db.execute({ sql, args });

    // 计数：同样使用参数化查询
    let countSql = 'SELECT COUNT(*) as count FROM users WHERE 1=1';
    const countArgs = [];
    if (tier) { countSql += ' AND tier = ?'; countArgs.push(String(tier)); }
    if (search) { countSql += ' AND email LIKE ?'; countArgs.push(`%${String(search)}%`); }
    const totalR = await userDb.db.execute({ sql: countSql, args: countArgs });

    res.json({
      code: 0,
      data: {
        users: result.rows,
        total: totalR.rows[0]?.count || 0,
        page,
        limit
      }
    });
  } catch (e) {
    logger.error('[admin] list users error: ' + e.message);
    res.status(500).json({ code: 1, message: 'list users failed' });
  }
});

router.post('/admin/users/:id/set-tier', auth.requireAdminKey, async (req, res) => {
  const userDb = require('../userDb');
  const { id } = req.params;
  const { tier, subscription_status, subscription_ends_at } = req.body || {};

  if (!id || typeof id !== 'string') {
    return res.status(400).json({ code: 400, message: 'invalid id' });
  }
  if (tier && !ALLOWED_TIERS.has(String(tier))) {
    return res.status(400).json({ code: 400, message: 'invalid tier' });
  }
  if (subscription_status && !ALLOWED_SUB_STATUS.has(String(subscription_status))) {
    return res.status(400).json({ code: 400, message: 'invalid subscription_status' });
  }

  let endsAt = null;
  if (subscription_ends_at !== undefined && subscription_ends_at !== null && subscription_ends_at !== '') {
    const n = Number(subscription_ends_at);
    if (!Number.isFinite(n) || n < 0) {
      return res.status(400).json({ code: 400, message: 'invalid subscription_ends_at' });
    }
    endsAt = n;
  }

  try {
    await userDb.db.execute({
      sql: 'UPDATE users SET tier = ?, subscription_status = ?, subscription_ends_at = ? WHERE id = ?',
      args: [
        String(tier || USER_TIER.FREE),
        String(subscription_status || 'inactive'),
        endsAt,
        id
      ]
    });
    res.json({ code: 0, message: '会员设置成功' });
  } catch (e) {
    logger.error('[admin] set-tier error: ' + e.message);
    res.status(500).json({ code: 1, message: 'set-tier failed' });
  }
});

router.post('/admin/users/:id/set-downloads', auth.requireAdminKey, async (req, res) => {
  const userDb = require('../userDb');
  const { id } = req.params;
  const { downloads_count } = req.body || {};

  const n = Number(downloads_count);
  if (!id || !Number.isFinite(n) || n < 0 || !Number.isInteger(n)) {
    return res.status(400).json({ code: 400, message: 'invalid downloads_count' });
  }

  try {
    // 注意：旧实现写的是 downloads_count（总累计），同时业务里真正用于限额的是 daily_downloads。
    // 这里同时重置 daily_downloads，与 admin 面板"设置今日下载次数"的语义对齐。
    await userDb.db.execute({
      sql: 'UPDATE users SET daily_downloads = ? WHERE id = ?',
      args: [n, id]
    });
    res.json({ code: 0, message: '下载次数已更新' });
  } catch (e) {
    logger.error('[admin] set-downloads error: ' + e.message);
    res.status(500).json({ code: 1, message: 'set-downloads failed' });
  }
});

// 旧路由 set-daily-limit 依赖一个 schema 中根本不存在的 daily_limit 列，
// 直接返回 410 Gone，前端发现后会感知到并停止使用。
router.post('/admin/users/:id/set-daily-limit', auth.requireAdminKey, (req, res) => {
  res.status(410).json({
    code: 410,
    message: 'set-daily-limit is removed; per-user daily_limit is not in schema'
  });
});

module.exports = router;

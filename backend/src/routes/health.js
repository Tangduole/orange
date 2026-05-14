/**
 * 健康检查路由
 */

const express = require('express');
const router = express.Router();
const fs = require('fs');
const path = require('path');
const logger = require('../utils/logger');

/**
 * GET /health
 * 基础健康检查（含数据库状态）
 */
router.get('/', async (req, res) => {
  let db = 'unknown';
  let users = 0;
  try {
    const userDb = require('../userDb');
    const r = await userDb.db.execute('SELECT COUNT(*) as c FROM users');
    users = r.rows[0].c;
    db = 'ok';
  } catch (e) {
    db = 'error: ' + e.message;
  }
  
  res.json({
    status: 'ok',
    db,
    users,
    timestamp: new Date().toISOString(),
    uptime: process.uptime()
  });
});

/**
 * GET /health/detailed
 * 详细健康检查
 */
router.get('/detailed', async (req, res) => {
  const health = {
    status: 'ok',
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    environment: process.env.NODE_ENV || 'development',
    checks: {}
  };

  // 检查数据库
  try {
    const userDb = require('../userDb');
    // 简单查询测试
    await userDb.getById('test');
    health.checks.database = { status: 'ok' };
  } catch (err) {
    health.checks.database = { status: 'error', message: err.message };
    health.status = 'degraded';
  }

  // 检查下载目录
  try {
    const downloadDir = path.join(__dirname, '../../downloads');
    if (!fs.existsSync(downloadDir)) {
      fs.mkdirSync(downloadDir, { recursive: true });
    }
    const stats = fs.statSync(downloadDir);
    const files = fs.readdirSync(downloadDir);
    let totalSize = 0;
    files.forEach(file => {
      try {
        const filePath = path.join(downloadDir, file);
        const fileStats = fs.statSync(filePath);
        if (fileStats.isFile()) {
          totalSize += fileStats.size;
        }
      } catch (err) {
        // 忽略单个文件错误
      }
    });
    health.checks.storage = {
      status: 'ok',
      files: files.length,
      totalSizeMB: (totalSize / 1024 / 1024).toFixed(2)
    };
  } catch (err) {
    health.checks.storage = { status: 'error', message: err.message };
    health.status = 'degraded';
  }

  // 检查内存使用
  const memUsage = process.memoryUsage();
  health.checks.memory = {
    status: 'ok',
    rss: `${(memUsage.rss / 1024 / 1024).toFixed(2)}MB`,
    heapUsed: `${(memUsage.heapUsed / 1024 / 1024).toFixed(2)}MB`,
    heapTotal: `${(memUsage.heapTotal / 1024 / 1024).toFixed(2)}MB`
  };

  // 检查环境变量
  const requiredEnvVars = ['JWT_SECRET', 'NODE_ENV'];
  const missingEnvVars = requiredEnvVars.filter(key => !process.env[key]);
  health.checks.environment = {
    status: missingEnvVars.length === 0 ? 'ok' : 'error',
    missing: missingEnvVars
  };
  if (missingEnvVars.length > 0) {
    health.status = 'error';
  }

  res.json(health);
});

/**
 * GET /health/ready
 * 就绪检查（用于 Kubernetes 等）
 */
router.get('/ready', async (req, res) => {
  try {
    // 检查关键服务是否就绪
    const userDb = require('../userDb');
    await userDb.getById('test');
    
    res.json({ status: 'ready' });
  } catch (err) {
    logger.error('[health] Readiness check failed:', err);
    res.status(503).json({ status: 'not ready', error: err.message });
  }
});

/**
 * GET /health/live
 * 存活检查（用于 Kubernetes 等）
 */
router.get('/live', (req, res) => {
  res.json({ status: 'alive' });
});

module.exports = router;

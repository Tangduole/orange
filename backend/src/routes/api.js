/**
 * API 路由 v2
 */

const express = require('express');
const fs = require('fs');
const path = require('path');
const auth = require('../auth');
const logger = require('../utils/logger');
const store = require('../store');
const { downloadLimiter } = require('../middleware/rateLimiter');
const { USER_TIER, SUBSCRIPTION_STATUS } = require('../config/constants');
const {
  createDownload,
  createBatchDownload,
  getBatchStatus,
  getInfo,
  getStatus,
  getHistory,
  getSystemStatus,
  getAdminStats,
  deleteTask,
  clearHistory,
  updateHistoryItem,
  extractCopywriteForTask,
  rewriteCopywriteForTask,
  getAiUsageStatus,
  getAsrLexicon,
  updateAsrLexicon,
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

// 批量下载（VIP only）
router.post('/download/batch', auth.required, createBatchDownload);

// 查询批量任务状态
router.get('/download/batch/:batchId', auth.required, getBatchStatus);

// 获取视频信息（不下载）
router.get('/info', downloadLimiter, getInfo);
router.post('/video-info', auth.optional, getVideoInfo);

// 查询任务状态
router.get('/status/:taskId', auth.optional, getStatus);

// 获取历史记录
router.get('/history', auth.optional, getHistory);
router.patch('/history/:taskId', auth.optional, updateHistoryItem);

// AI 文案提取（Pro）
router.post('/copywrite', downloadLimiter, auth.required, extractCopywriteForTask);
router.post('/copywrite/rewrite', downloadLimiter, auth.required, rewriteCopywriteForTask);
router.get('/ai/usage', auth.required, getAiUsageStatus);
router.get('/asr/lexicon', auth.required, getAsrLexicon);
router.put('/asr/lexicon', auth.required, updateAsrLexicon);

// 删除任务
router.delete('/tasks/:taskId', auth.optional, deleteTask);
router.delete('/history', auth.optional, clearHistory);

module.exports = router;

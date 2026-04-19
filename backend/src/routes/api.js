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

module.exports = router;

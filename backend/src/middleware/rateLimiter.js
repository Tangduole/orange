/**
 * API 速率限制中间件
 */

const rateLimit = require('express-rate-limit');

// 通用 API 限制：每15分钟100个请求
const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15分钟
  max: 100,
  message: { code: 429, message: '请求过于频繁，请稍后再试' },
  standardHeaders: true,
  legacyHeaders: false,
  // 跳过成功的请求（可选）
  skipSuccessfulRequests: false,
  // 根据IP限制
  keyGenerator: (req) => {
    return req.ip || req.headers['x-forwarded-for']?.split(',')[0] || 'unknown';
  }
});

// 下载接口限制：每分钟10个请求
const downloadLimiter = rateLimit({
  windowMs: 60 * 1000, // 1分钟
  max: 10,
  message: { code: 429, message: '下载请求过于频繁，请稍后再试' },
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => {
    return req.ip || req.headers['x-forwarded-for']?.split(',')[0] || 'unknown';
  }
});

// 认证接口限制：每15分钟5个请求
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15分钟
  max: 5,
  message: { code: 429, message: '登录尝试过于频繁，请15分钟后再试' },
  standardHeaders: true,
  legacyHeaders: false,
  skipSuccessfulRequests: true, // 成功的登录不计入限制
  keyGenerator: (req) => {
    return req.ip || req.headers['x-forwarded-for']?.split(',')[0] || 'unknown';
  }
});

// 严格限制（用于敏感操作）：每小时3个请求
const strictLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1小时
  max: 3,
  message: { code: 429, message: '操作过于频繁，请1小时后再试' },
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => {
    return req.ip || req.headers['x-forwarded-for']?.split(',')[0] || 'unknown';
  }
});

module.exports = {
  apiLimiter,
  downloadLimiter,
  authLimiter,
  strictLimiter
};

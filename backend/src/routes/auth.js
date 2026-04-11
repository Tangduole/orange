/**
 * 认证路由
 */

const express = require('express');
const router = express.Router();
const userDb = require('../userDb');
const auth = require('../auth');

// 简单的登录频率限制（5分钟内失败5次封IP）
const loginAttempts = new Map();
const LOGIN_LIMIT = 5;
const LOGIN_WINDOW = 5 * 60 * 1000; // 5分钟

function checkLoginRateLimit(ip) {
  const now = Date.now();
  const record = loginAttempts.get(ip);
  
  if (!record) {
    loginAttempts.set(ip, { count: 1, firstAttempt: now });
    return true;
  }
  
  // 超过窗口时间，重置
  if (now - record.firstAttempt > LOGIN_WINDOW) {
    loginAttempts.set(ip, { count: 1, firstAttempt: now });
    return true;
  }
  
  if (record.count >= LOGIN_LIMIT) {
    return false;
  }
  
  record.count++;
  return true;
}

/**
 * POST /api/auth/register
 * 注册
 */
router.post('/register', async (req, res) => {
  const { email, password } = req.body;
  
  if (!email || !password) {
    return res.json({ code: 400, message: '邮箱和密码不能为空' });
  }
  
  if (password.length < 6) {
    return res.json({ code: 400, message: '密码至少6位' });
  }
  
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!emailRegex.test(email)) {
    return res.json({ code: 400, message: '邮箱格式不正确' });
  }
  
  try {
    const user = await userDb.create(email, password);
    const token = auth.generateToken(user);
    
    res.json({
      code: 0,
      data: {
        token,
        user: {
          id: user.id,
          email: user.email,
          tier: user.tier
        }
      }
    });
  } catch (e) {
    res.json({ code: 400, message: e.message });
  }
});

/**
 * POST /api/auth/login
 * 登录
 */
router.post('/login', async (req, res) => {
  const clientIp = req.ip || req.headers['x-forwarded-for']?.split(',')[0] || 'unknown';
  
  // 检查频率限制
  if (!checkLoginRateLimit(clientIp)) {
    return res.status(429).json({ code: 429, message: '登录尝试过于频繁，请5分钟后再试' });
  }
  
  const { email, password } = req.body;
  
  if (!email || !password) {
    return res.json({ code: 400, message: '邮箱和密码不能为空' });
  }
  
  const user = await userDb.verifyPassword(email, password);
  if (!user) {
    return res.json({ code: 401, message: '邮箱或密码错误' });
  }
  
  const token = auth.generateToken(user);
  
  res.json({
    code: 0,
    data: {
      token,
      user: {
        id: user.id,
        email: user.email,
        tier: user.tier,
        subscriptionStatus: user.subscription_status
      }
    }
  });
});

/**
 * GET /api/auth/me
 * 获取当前用户信息
 */
router.get('/me', auth.required, async (req, res) => {
  const usage = await userDb.getUsage(req.user.id);
  
  res.json({
    code: 0,
    data: {
      id: req.user.id,
      email: req.user.email,
      tier: req.user.tier,
      subscriptionStatus: req.user.subscription_status,
      subscriptionEndsAt: req.user.subscription_ends_at,
      usage
    }
  });
});

// 忘记密码 - 发送重置邮件
router.post('/forgot-password', async (req, res) => {
  try {
    const { email } = req.body;
    if (!email) return res.status(400).json({ code: 400, message: '请提供邮箱' });
    
    const user = await userDb.getByEmail(email);
    
    // 即使用户不存在也返回成功，防止枚举攻击
    if (!user) {
      return res.json({ code: 0, message: '如果邮箱存在，重置链接已发送' });
    }
    
    // 生成重置令牌
    const token = require('uuid').v4();
    const expiresAt = Date.now() + 30 * 60 * 1000; // 30分钟过期
    
    // TODO: 存储令牌到数据库（目前内存存储）
    global.resetTokens = global.resetTokens || {};
    global.resetTokens[token] = { email, expiresAt };
    
    // 发送邮件
    const { sendPasswordResetEmail } = require('../services/email');
    await sendPasswordResetEmail(email, token);
    
    res.json({ code: 0, message: '如果邮箱存在，重置链接已发送' });
  } catch (err) {
    console.error('[auth] Forgot password error:', err);
    res.status(500).json({ code: 500, message: '发送失败' });
  }
});

// 重置密码
router.post('/reset-password', async (req, res) => {
  try {
    const { token, password } = req.body;
    if (!token || !password) return res.status(400).json({ code: 400, message: '缺少参数' });
    
    // 验证令牌
    const resetData = global.resetTokens?.[token];
    if (!resetData || resetData.expiresAt < Date.now()) {
      return res.status(400).json({ code: 400, message: '令牌已过期' });
    }
    
    // 更新密码
    const user = await userDb.getByEmail(resetData.email);
    if (!user) {
      return res.status(400).json({ code: 400, message: '用户不存在' });
    }
    
    // 直接更新密码（bcrypt hash）
    const bcrypt = require('bcryptjs');
    const passwordHash = bcrypt.hashSync(password, 10);
    
    // 使用 getByEmail 获取的用户更新
    // 注意：需要在 userDb 添加 updatePassword 方法
    await db.execute({
      sql: 'UPDATE users SET password_hash = ? WHERE email = ?',
      args: [passwordHash, resetData.email.toLowerCase()]
    });
    
    // 删除令牌
    delete global.resetTokens[token];
    
    res.json({ code: 0, message: '密码重置成功' });
  } catch (err) {
    console.error('[auth] Reset password error:', err);
    res.status(500).json({ code: 500, message: '重置失败' });
  }
});

module.exports = router;

// 注销账号
router.post('/delete-account', auth.required, async (req, res) => {
  try {
    const userId = req.user.id;
    const email = req.user.email;
    
    // 删除用户
    await userDb.deleteUser(email);
    
    res.json({ code: 0, message: '账号已注销' });
  } catch (err) {
    console.error('[auth] Delete account error:', err);
    res.status(500).json({ code: 500, message: '注销失败' });
  }
});

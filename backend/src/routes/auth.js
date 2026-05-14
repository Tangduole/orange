/**
 * 认证路由
 */

const express = require('express');
const router = express.Router();
const userDb = require('../userDb');
const auth = require('../auth');
const logger = require('../utils/logger');
const { authLimiter, strictLimiter } = require('../middleware/rateLimiter');

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
 * 注册（带速率限制）
 */
router.post('/register', authLimiter, async (req, res) => {
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
  
  // 验证邮箱域名有 MX 记录（防止虚假邮箱）
  const domain = email.split('@')[1];
  try {
    const { Resolver } = require('dns').promises;
    const resolver = new Resolver();
    resolver.setServers(['8.8.8.8', '1.1.1.1']); // 使用公共 DNS
    let hasMx = false;
    try {
      const mxRecords = await resolver.resolve(domain, 'MX');
      hasMx = mxRecords && mxRecords.length > 0;
    } catch (mxErr) {
      // MX 查询失败，尝试 A 记录
      try {
        await resolver.resolve(domain, 'A');
        hasMx = true; // 有 A 记录也算有效域名
      } catch {}
    }
    if (!hasMx) {
      return res.json({ code: 400, message: '邮箱域名无效，请使用真实邮箱' });
    }
  } catch (dnsErr) {
    console.error('[auth] DNS validation error:', dnsErr.message);
    // DNS 检查失败时拒绝注册，防止虚假邮箱
    return res.json({ code: 400, message: '邮箱验证失败，请使用真实邮箱' });
  }
  
  try {
    const user = await userDb.create(email, password);
    const token = auth.generateToken(user);
    
    // 生成验证令牌
    const verifyToken = require('uuid').v4();
    const expiresAt = Date.now() + 24 * 60 * 60 * 1000;
    await userDb.storeVerificationToken(user.id, verifyToken, expiresAt);
    
    // 发送验证邮件
    let emailSent = false;
    try {
      const { sendVerificationEmail } = require('../services/email');
      await sendVerificationEmail(email, verifyToken);
      emailSent = true;
    } catch (emailErr) {
      // 邮件发送失败，删除已创建的用户
      console.error('[auth] Email send failed, deleting user:', emailErr.message);
      await userDb.deleteUser(email);
      return res.json({ code: 500, message: '验证邮件发送失败，请检查邮箱是否有效' });
    }
    
    // 注册成功，不自动登录，提示用户去验证邮箱
    return res.json({
      code: 0,
      message: '注册成功，请查收验证邮件完成账号激活',
      data: { needsEmailVerification: true }
    });
  } catch (e) {
    res.json({ code: 400, message: e.message });
  }
});

/**
 * POST /api/auth/login
 * 登录（带速率限制）
 */
router.post('/login', authLimiter, async (req, res) => {
  const clientIp = req.ip || req.headers['x-forwarded-for']?.split(',')[0] || 'unknown';
  
  // 检查频率限制
  if (!checkLoginRateLimit(clientIp)) {
    return res.status(429).json({ code: 429, message: '登录尝试过于频繁，请5分钟后再试' });
  }
  
  const { email, password } = req.body;

  if (!email || !password) {
    return res.json({ code: 400, message: '邮箱和密码不能为空' });
  }

  // —— 防用户枚举：邮箱不存在与密码错误一律返回相同提示 ——
  const user = await userDb.verifyPassword(email, password);
  if (!user) {
    return res.json({ code: 401, message: '邮箱或密码不正确' });
  }

  // —— 邮箱必须已验证才能登录；老账号不再自动通过，强制走"重发验证邮件" ——
  if (user.email_verified !== 1) {
    return res.json({
      code: 403,
      message: '邮箱尚未验证，请前往注册邮箱完成验证',
      data: { needsEmailVerification: true, email: user.email }
    });
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
        subscriptionStatus: user.subscription_status,
        emailVerified: true
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

// 忘记密码 - 发送重置邮件（严格限制）
router.post('/forgot-password', strictLimiter, async (req, res) => {
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
    
    // 存储令牌到数据库
    await userDb.storeResetToken(token, email, expiresAt);
    
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
router.post('/reset-password', strictLimiter, async (req, res) => {
  try {
    const { token, password } = req.body;
    if (!token || !password) return res.status(400).json({ code: 400, message: '缺少参数' });
    
    // 密码强度校验（与注册保持一致）
    if (password.length < 6) {
      return res.status(400).json({ code: 400, message: '密码至少6位' });
    }
    
    // 验证令牌
    const resetData = await userDb.getResetToken(token);
    if (!resetData) {
      return res.status(400).json({ code: 400, message: '令牌已过期' });
    }
    
    // 先删除令牌（防止重放攻击），再更新密码
    await userDb.deleteResetToken(token);
    
    // 更新密码
    const user = await userDb.getByEmail(resetData.email);
    if (!user) {
      return res.status(400).json({ code: 400, message: '用户不存在' });
    }
    
    const bcrypt = require('bcryptjs');
    const passwordHash = bcrypt.hashSync(password, 10);
    
    await userDb.updatePassword(resetData.email, passwordHash);
    // 递增 token_version 使所有旧 JWT 失效
    await userDb.incrementTokenVersion(user.id);
    
    res.json({ code: 0, message: '密码重置成功，请重新登录' });
  } catch (err) {
    console.error('[auth] Reset password error:', err);
    res.status(500).json({ code: 500, message: '重置失败' });
  }
});

// 验证邮箱
router.get('/verify-email', async (req, res) => {
  try {
    const { token } = req.query;
    if (!token) {
      return res.status(400).json({ code: 400, message: 'Missing token' });
    }
    
    const result = await userDb.verifyEmail(token);
    if (!result.success) {
      // 返回 HTML 页面显示错误
      return res.send(`
        <!DOCTYPE html>
        <html>
        <head>
          <meta charset="utf-8">
          <meta name="viewport" content="width=device-width, initial-scale=1">
          <title>邮箱验证失败 - Orange</title>
          <style>
            body { font-family: -apple-system, BlinkMacSystemFont, sans-serif; background: #1a1a2e; color: white; min-height: 100vh; display: flex; align-items: center; justify-content: center; margin: 0; }
            .container { text-align: center; padding: 40px; background: #16213e; border-radius: 16px; max-width: 400px; }
            h1 { color: #ff6b35; margin-bottom: 20px; }
            p { color: #ccc; line-height: 1.6; }
            .btn { display: inline-block; background: #ff6b35; color: white; text-decoration: none; padding: 12px 24px; border-radius: 8px; margin-top: 20px; }
          </style>
        </head>
        <body>
          <div class="container">
            <h1>❌ 验证失败</h1>
            <p>${result.error}</p>
            <p>可能原因：链接已过期或无效。</p>
            <a href="https://orangedl.com" class="btn">返回首页</a>
          </div>
        </body>
        </html>
      `);
    }
    
    // 验证成功，发送欢迎邮件
    try {
      const { sendWelcomeEmail } = require('../services/email');
      await sendWelcomeEmail(result.email);
      // 复用全局 userDb.db，避免重复建立 Turso 连接
      await userDb.db.execute({
        sql: 'CREATE TABLE IF NOT EXISTS email_logs (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT NOT NULL, email_type TEXT NOT NULL, sent_at INTEGER NOT NULL, UNIQUE(user_id, email_type))'
      });
      await userDb.db.execute({
        sql: 'INSERT OR IGNORE INTO email_logs (user_id, email_type, sent_at) VALUES (?, ?, ?)',
        args: [result.userId, 'welcome', Date.now()]
      });
    } catch (e) {
      logger.error('[auth] Welcome email failed: ' + e.message);
    }
    
    // 返回成功 HTML 页面
    res.send(`
      <!DOCTYPE html>
      <html>
      <head>
        <meta charset="utf-8">
        <meta name="viewport" content="width=device-width, initial-scale=1">
        <title>邮箱验证成功 - Orange</title>
        <style>
          body { font-family: -apple-system, BlinkMacSystemFont, sans-serif; background: #1a1a2e; color: white; min-height: 100vh; display: flex; align-items: center; justify-content: center; margin: 0; }
          .container { text-align: center; padding: 40px; background: #16213e; border-radius: 16px; max-width: 400px; }
          h1 { color: #4ade80; margin-bottom: 20px; }
          p { color: #ccc; line-height: 1.6; margin: 10px 0; }
          .note { background: #fff3cd; color: #856404; padding: 12px; border-radius: 8px; margin: 15px 0; font-size: 14px; }
          .btn { display: inline-block; background: #ff6b35; color: white; text-decoration: none; padding: 12px 24px; border-radius: 8px; margin-top: 15px; }
          .btn-secondary { background: #475569; margin-left: 10px; }
        </style>
      </head>
      <body>
        <div class="container">
          <h1>✅ 验证成功</h1>
          <p>您的邮箱已验证成功！</p>
          <div class="note">⚠️ 如果您之前登录过其他账号，请先登出旧账号，再用此邮箱登录。</div>
          <a href="https://orangedl.com" class="btn">开始使用</a>
        </div>
      </body>
      </html>
    `);
  } catch (err) {
    console.error('[auth] Verify email error:', err);
    res.status(500).send(`
      <!DOCTYPE html>
      <html>
      <head>
        <meta charset="utf-8">
        <title>邮箱验证失败 - Orange</title>
        <style>
          body { font-family: sans-serif; background: #1a1a2e; color: white; min-height: 100vh; display: flex; align-items: center; justify-content: center; margin: 0; }
          .container { text-align: center; padding: 40px; }
          h1 { color: #ff6b35; }
          .btn { display: inline-block; background: #ff6b35; color: white; text-decoration: none; padding: 12px 24px; border-radius: 8px; margin-top: 20px; }
        </style>
      </head>
      <body>
        <div class="container">
          <h1>❌ 验证失败</h1>
          <p>服务器错误，请稍后重试。</p>
          <a href="https://orangedl.com" class="btn">返回首页</a>
        </div>
      </body>
      </html>
    `);
  }
});

// 注销账号（严格限制）
router.post('/delete-account', auth.required, strictLimiter, async (req, res) => {
  try {
    const { password } = req.body;
    if (!password) {
      return res.json({ code: 400, message: '请输入密码确认' });
    }
    
    // 验证密码
    const verified = await userDb.verifyPassword(req.user.email, password);
    if (!verified) {
      return res.json({ code: 401, message: '密码错误' });
    }
    
    // 删除用户
    await userDb.deleteUser(req.user.email);
    
    res.json({ code: 0, message: '账号已注销' });
  } catch (err) {
    console.error('[auth] Delete account error:', err);
    res.status(500).json({ code: 500, message: '注销失败' });
  }
});

// 推荐系统
router.get('/referral', auth.required, async (req, res) => {
  try {
    const stats = await userDb.getReferralStats(req.user.id);
    res.json({ code: 0, data: stats });
  } catch (err) {
    console.error('[auth] Get referral error:', err);
    res.status(500).json({ code: 500, message: '获取失败' });
  }
});

router.post('/referral/apply', auth.required, async (req, res) => {
  try {
    const { code } = req.body;
    const result = await userDb.applyReferralCode(req.user.id, code);
    if (!result.success) {
      return res.json({ code: 400, message: result.error });
    }
    res.json({ code: 0, message: '推荐码使用成功！您和推荐人都获得了 +5次/天的下载加成（30天有效）' });
  } catch (err) {
    console.error('[auth] Apply referral error:', err);
    res.status(500).json({ code: 500, message: '应用推荐码失败' });
  }
});

// 管理员：触发生命周期邮件（复用统一的 admin key 中间件）
router.post('/admin/lifecycle-emails', auth.requireAdminKey, async (req, res) => {
  let lifecycle;
  try {
    lifecycle = require('../lifecycle');
  } catch (e) {
    return res.status(501).json({
      code: 501,
      message: 'lifecycle module not implemented'
    });
  }
  try {
    const result = await lifecycle.run();
    res.json({ code: 0, data: result });
  } catch (err) {
    logger.error('[admin] Lifecycle emails error: ' + err.message);
    res.status(500).json({ code: 500, message: 'lifecycle run failed' });
  }
});

module.exports = router;

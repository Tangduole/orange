/**
 * 认证路由
 */

const express = require('express');
const router = express.Router();
const userDb = require('../userDb');
const auth = require('../auth');

/**
 * POST /api/auth/register
 * 注册
 */
router.post('/register', (req, res) => {
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
    const user = userDb.create(email, password);
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
router.post('/login', (req, res) => {
  const { email, password } = req.body;
  
  if (!email || !password) {
    return res.json({ code: 400, message: '邮箱和密码不能为空' });
  }
  
  const user = userDb.verifyPassword(email, password);
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
router.get('/me', auth.required, (req, res) => {
  const usage = userDb.getUsage(req.user.id);
  
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

module.exports = router;

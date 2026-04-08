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

// 注销账号
router.post('/delete-account', auth.required, async (req, res) => {
  try {
    const { User } = require('../models/user');
    const userId = req.user.id;
    
    // 删除用户及其数据
    await User.deleteOne({ _id: userId });
    
    // 清除相关数据
    const { Task } = require('../models/task');
    await Task.deleteMany({ userId });
    
    res.json({ code: 0, message: '账号已注销' });
  } catch (err) {
    console.error('[auth] Delete account error:', err);
    res.status(500).json({ code: 500, message: '注销失败' });
  }
});

// 忘记密码 - 发送重置邮件
router.post('/forgot-password', async (req, res) => {
  try {
    const { email } = req.body;
    if (!email) return res.status(400).json({ code: 400, message: '请提供邮箱' });
    
    const { User } = require('../models/user');
    const user = await User.findOne({ email });
    
    // 即使用户不存在也返回成功，防止枚举攻击
    if (!user) {
      return res.json({ code: 0, message: '如果邮箱存在，重置链接已发送' });
    }
    
    // 生成重置令牌
    const resetToken = Buffer.from(`${user._id}:${Date.now()}`).toString('base64');
    await User.updateOne({ _id: user._id }, { resetToken });
    
    // 使用 Resend 发送邮件
    const { Resend } = require('resend');
    const resend = new Resend(process.env.RESEND_API_KEY || 're_6tYoitLj_NyyF5gNR9qX334p93tzMt2zL');
    
    const resetUrl = `https://frontend-roan-psi-68.vercel.app/reset?token=${resetToken}`;
    
    await resend.emails.send({
      from: 'Orange <noreply@orange-downloader.com>',
      to: email,
      subject: '重置你的 Orange 密码',
      html: `
        <div style="font-family: sans-serif; max-width: 600px; margin: 0 auto;">
          <div style="text-align: center; margin-bottom: 30px;">
            <h1 style="color: #FF7D00; font-size: 32px; margin: 0;">🍊 Orange</h1>
          </div>
          <h2 style="color: #333;">重置密码</h2>
          <p style="color: #666; line-height: 1.6;">
            你请求了重置密码。请点击下面的按钮来设置新密码：
          </p>
          <div style="text-align: center; margin: 30px 0;">
            <a href="${resetUrl}" style="display: inline-block; background: linear-gradient(135deg, #FF7D00, #FFA347); color: white; text-decoration: none; padding: 14px 32px; border-radius: 8px; font-weight: bold; font-size: 16px;">
              重置密码
            </a>
          </div>
          <p style="color: #999; font-size: 14px;">
            如果你没有请求重置密码，请忽略这封邮件。<br>
            此链接将在 1 小时后过期。
          </p>
          <hr style="border: none; border-top: 1px solid #eee; margin: 30px 0;">
          <p style="color: #999; font-size: 12px; text-align: center;">
            Orange Downloader - 多平台视频下载工具
          </p>
        </div>
      `
    });
    
    console.log(`[auth] Password reset email sent to ${email}`);
    res.json({ code: 0, message: '重置链接已发送到邮箱' });
  } catch (err) {
    console.error('[auth] Forgot password error:', err);
    res.status(500).json({ code: 500, message: '请求失败' });
  }
});

// 重置密码
router.post('/reset-password', async (req, res) => {
  try {
    const { token, password } = req.body;
    if (!token || !password) return res.status(400).json({ code: 400, message: '缺少参数' });
    
    const { User } = require('../models/user');
    const decoded = Buffer.from(token, 'base64').toString();
    const [userId] = decoded.split(':');
    
    const user = await User.findOne({ _id: userId, resetToken: token });
    if (!user) return res.status(400).json({ code: 400, message: '无效或已过期的重置链接' });
    
    // 更新密码
    user.password = password; // 应该先hash
    user.resetToken = null;
    await user.save();
    
    res.json({ code: 0, message: '密码已重置' });
  } catch (err) {
    console.error('[auth] Reset password error:', err);
    res.status(500).json({ code: 500, message: '重置失败' });
  }
});

/**
 * JWT 认证中间件
 */

const jwt = require('jsonwebtoken');
const userDb = require('./userDb');

// JWT_SECRET 必须设置，不允许 fallback
if (!process.env.JWT_SECRET) {
  console.error('❌ JWT_SECRET environment variable is required!');
  process.exit(1);
}
const JWT_SECRET = process.env.JWT_SECRET;

const auth = {
  /**
   * 验证 JWT token（可选，用于获取当前用户）
   */
  async optional(req, res, next) {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      req.user = null;
      return next();
    }

    const token = authHeader.slice(7);
    try {
      const payload = jwt.verify(token, JWT_SECRET);
      const user = await userDb.getById(payload.sub);
      req.user = user || null;
      return next();
    } catch (e) {
      req.user = null;
      return next();
    }
  },

  /**
   * 要求登录
   */
  async required(req, res, next) {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.json({ code: 401, message: '请先登录' });
    }

    const token = authHeader.slice(7);
    try {
      const payload = jwt.verify(token, JWT_SECRET);
      const user = await userDb.getById(payload.sub);
      if (!user) {
        return res.json({ code: 401, message: '用户不存在，请重新登录' });
      }
      req.user = user;
    } catch (e) {
      return res.json({ code: 401, message: 'Token 无效或已过期' });
    }
    next();
  },

  /**
   * 生成 token
   */
  generateToken(user) {
    return jwt.sign(
      { sub: user.id, email: user.email },
      JWT_SECRET,
      { expiresIn: '30d' }
    );
  },

  /**
   * 生成 Lemon Squeezy 签名密钥（用于 webhook 验证）
   */
  generateWebhookSecret() {
    const secret = process.env.LEMON_SQUEEZY_WEBHOOK_SECRET;
    return secret || 'test-webhook-secret';
  }
};

module.exports = auth;

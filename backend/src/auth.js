/**
 * JWT 认证中间件
 */

const jwt = require('jsonwebtoken');
const userDb = require('./userDb');
const logger = require('./utils/logger');

// JWT_SECRET 必须设置，不允许 fallback
if (!process.env.JWT_SECRET) {
  console.error('❌ JWT_SECRET environment variable is required!');
  process.exit(1);
}
const JWT_SECRET = process.env.JWT_SECRET;

const auth = {
  /**
   * 验证 JWT token（可选）
   *
   * 行为：
   *  - 没有 Authorization 头        → req.user = null, 继续（游客）
   *  - 头存在但 token 已过期/被吊销 → 401，避免被吊销 token 仍以"游客"身份消耗免费额度
   *  - 头存在且 token 合法但用户不存在 → 401
   */
  optional(req, res, next) {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      req.user = null;
      return next();
    }

    const token = authHeader.slice(7);
    Promise.resolve()
      .then(() => jwt.verify(token, JWT_SECRET))
      .then(payload => userDb.getById(payload.sub))
      .then(user => {
        if (!user) {
          return res
            .status(401)
            .json({ code: 401, message: '用户不存在，请重新登录' });
        }
        // 检查 token_version：密码重置后旧 token 失效
        if (payload.tv !== undefined && user.token_version !== undefined && payload.tv !== user.token_version) {
          return res
            .status(401)
            .json({ code: 401, message: '密码已变更，请重新登录' });
        }
        req.user = user;
        next();
      })
      .catch(err => {
        // 显式带了 Authorization 头但 token 非法 → 拒绝，而不是静默降级为游客
        logger.warn(`[auth.optional] reject invalid token: ${err.message}`);
        return res
          .status(401)
          .json({ code: 401, message: 'Token 无效或已过期，请重新登录' });
      });
  },

  /**
   * 要求登录
   */
  required(req, res, next) {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.json({ code: 401, message: '请先登录' });
    }

    const token = authHeader.slice(7);

    // 用 Promise 包裹确保所有异常都捕获
    Promise.resolve()
      .then(() => jwt.verify(token, JWT_SECRET))
      .then(payload => userDb.getById(payload.sub))
      .then(user => {
        if (!user) {
          return res.json({ code: 401, message: '用户不存在，请重新登录' });
        }
        // 检查 token_version：密码重置后旧 token 失效
        if (payload.tv !== undefined && user.token_version !== undefined && payload.tv !== user.token_version) {
          return res.json({ code: 401, message: '密码已变更，请重新登录' });
        }
        req.user = user;
        next();
      })
      .catch(e => {
        console.error('[auth] required error:', e.message);
        res.json({ code: 401, message: 'Token 无效或已过期' });
      });
  },

  /**
   * 要求管理员 API Key
   */
  requireAdminKey(req, res, next) {
    const adminKey = process.env.ADMIN_API_KEY;
    if (!adminKey) {
      console.error('[auth] ADMIN_API_KEY not configured');
      return res.status(500).json({ code: 500, message: '管理员功能未配置' });
    }

    const requestKey = req.headers['x-admin-key'];
    if (requestKey !== adminKey) {
      return res.status(403).json({ code: 403, message: '无权访问' });
    }

    next();
  },

  /**
   * 生成 token
   */
  generateToken(user) {
    return jwt.sign(
      { sub: user.id, email: user.email, tv: user.token_version || 0 },
      JWT_SECRET,
      { expiresIn: '30d' }
    );
  },

  /**
   * 生成 Lemon Squeezy 签名密钥（用于 webhook 验证）
   */
  generateWebhookSecret() {
    return process.env.LEMON_SQUEEZY_WEBHOOK_SECRET;
  }
};

module.exports = auth;

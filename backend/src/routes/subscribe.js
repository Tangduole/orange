/**
 * 订阅路由 - Lemon Squeezy 集成
 */

const express = require('express');
const crypto = require('crypto');
const router = express.Router();
const axios = require('axios');
const userDb = require('../userDb');
const auth = require('../auth');
const logger = require('../utils/logger');

// Lemon Squeezy 配置
const LS_API_KEY = process.env.LEMON_SQUEEZY_API_KEY || '';
const LS_STORE_ID = process.env.LEMON_SQUEEZY_STORE_ID || '';
const LS_VARIANT_ID_PRO = process.env.LEMON_SQUEEZY_VARIANT_ID_PRO || ''; // Pro 月付
const LS_VARIANT_ID_PRO_YEARLY = process.env.LEMON_SQUEEZY_VARIANT_ID_PRO_YEARLY || ''; // Pro 年付
const LS_VARIANT_ID_BASIC = process.env.LEMON_SQUEEZY_VARIANT_ID_BASIC || ''; // Basic 月付
const LS_VARIANT_ID_BASIC_YEARLY = process.env.LEMON_SQUEEZY_VARIANT_ID_BASIC_YEARLY || ''; // Basic 年付
const LS_WEBHOOK_SECRET = process.env.LEMON_SQUEEZY_WEBHOOK_SECRET || '';

// 套餐变体映射
const VARIANT_MAP = {
  'basic_monthly': LS_VARIANT_ID_BASIC,
  'basic_yearly': LS_VARIANT_ID_BASIC_YEARLY,
  'pro_monthly': LS_VARIANT_ID_PRO,
  'pro_yearly': LS_VARIANT_ID_PRO_YEARLY,
};

// Lemon Squeezy API Base
const LS_API_BASE = 'https://api.lemonsqueezy.com/v1';

// ---------- Webhook 幂等：在 Turso 上建一张事件去重表 ----------
let webhookTableReady = false;
async function ensureWebhookTable() {
  if (webhookTableReady) return;
  try {
    await userDb.db.execute({
      sql: `CREATE TABLE IF NOT EXISTS webhook_events (
        event_id TEXT PRIMARY KEY,
        event_name TEXT,
        received_at INTEGER NOT NULL
      )`
    });
    webhookTableReady = true;
  } catch (e) {
    logger.error('[webhook] ensureWebhookTable failed: ' + e.message);
  }
}

/**
 * 创建 Pro 订阅 checkout
 * POST /api/subscribe/checkout
 */
router.post('/checkout', auth.required, async (req, res) => {
  const { email } = req.user;
  const { plan = 'pro_monthly' } = req.body; // 默认 Pro 月付

  const variantId = VARIANT_MAP[plan] || LS_VARIANT_ID_PRO;

  if (!LS_API_KEY || !LS_STORE_ID || !variantId) {
    return res.json({
      code: 500,
      message: '订阅服务未配置，请联系管理员'
    });
  }

  try {
    const response = await axios.post(
      `${LS_API_BASE}/checkouts`,
      {
        data: {
          type: 'checkouts',
          attributes: {
            checkout_data: {
              email: email,
              custom: {
                user_id: req.user.id,
                plan
              }
            },
            product_options: {
              redirect_url: `${process.env.FRONTEND_URL || 'https://orangedl.com'}/subscription?success=true`
            }
          },
          relationships: {
            store: { data: { type: 'stores', id: LS_STORE_ID } },
            variant: { data: { type: 'variants', id: variantId } }
          }
        }
      },
      {
        headers: {
          'Authorization': `Bearer ${LS_API_KEY}`,
          'Accept': 'application/vnd.api+json',
          'Content-Type': 'application/vnd.api+json'
        }
      }
    );

    const checkoutUrl = response.data.data.attributes.url;
    const checkoutId = response.data.data.id;

    res.json({
      code: 0,
      data: {
        checkoutUrl,
        checkoutId
      }
    });
  } catch (e) {
    logger.error('[subscribe] Checkout error: ' + (e.response?.data ? JSON.stringify(e.response.data) : e.message));
    res.json({
      code: 500,
      message: '创建订阅失败，请稍后重试'
    });
  }
});

/**
 * 获取当前订阅状态
 * GET /api/subscribe/status
 */
router.get('/status', auth.required, async (req, res) => {
  const usage = await userDb.getUsage(req.user.id);

  // 检查订阅是否过期
  let subscriptionStatus = req.user.subscription_status;
  const endsAt = req.user.subscription_ends_at;
  if (endsAt && endsAt > 0 && endsAt * 1000 < Date.now()) {
    // 订阅已过期，降级为 free
    subscriptionStatus = 'expired';
  }

  res.json({
    code: 0,
    data: {
      tier: req.user.tier,
      subscriptionStatus,
      subscriptionEndsAt: req.user.subscription_ends_at,
      usage
    }
  });
});

// Lemon Squeezy Webhook - 处理订阅事件
// POST /api/subscribe/webhook
//
// 注意：本路由的 raw body 解析在 app.js 中通过
//   app.use('/api/subscribe/webhook', express.raw({ type: '*\/*' }))
// 完成；这里直接使用 req.body（Buffer）。
router.post('/webhook', async (req, res) => {
  const signature = req.headers['x-signature'] || '';

  if (!LS_WEBHOOK_SECRET) {
    logger.error('[webhook] LEMON_SQUEEZY_WEBHOOK_SECRET not configured, webhook disabled');
    return res.status(500).json({ error: 'Webhook not configured' });
  }

  // req.body 必须是 Buffer，否则说明中间件顺序错了
  if (!Buffer.isBuffer(req.body)) {
    logger.error('[webhook] req.body is not a Buffer; check express middleware order in app.js');
    return res.status(500).json({ error: 'Webhook body parser misconfigured' });
  }

  // —— 安全的 HMAC 校验 —— //
  const expectedHex = crypto
    .createHmac('sha256', LS_WEBHOOK_SECRET)
    .update(req.body)
    .digest('hex');

  let valid = false;
  try {
    const sigBuf = Buffer.from(String(signature), 'hex');
    const expBuf = Buffer.from(expectedHex, 'hex');
    valid =
      sigBuf.length === expBuf.length &&
      crypto.timingSafeEqual(sigBuf, expBuf);
  } catch {
    valid = false;
  }

  if (!valid) {
    logger.warn('[webhook] Invalid signature');
    return res.status(403).json({ error: 'Invalid signature' });
  }

  // —— 解析 JSON —— //
  let event;
  try {
    event = JSON.parse(req.body.toString('utf8'));
  } catch (e) {
    logger.error('[webhook] Parse error: ' + e.message);
    return res.status(400).json({ error: 'Invalid JSON' });
  }

  const eventName = event?.meta?.event_name;
  // LemonSqueezy 推荐的幂等键：webhook_id（来自 meta），降级用 X-Event-Id 头
  const eventId =
    event?.meta?.webhook_id ||
    req.headers['x-event-id'] ||
    `${eventName}:${event?.data?.id}:${event?.data?.attributes?.updated_at || ''}`;

  // —— 幂等去重 —— //
  await ensureWebhookTable();
  try {
    await userDb.db.execute({
      sql: 'INSERT INTO webhook_events (event_id, event_name, received_at) VALUES (?, ?, ?)',
      args: [String(eventId), String(eventName || ''), Date.now()]
    });
  } catch (e) {
    if (String(e.message || '').includes('UNIQUE')) {
      logger.info(`[webhook] Duplicate event ignored: ${eventId}`);
      return res.json({ success: true, deduped: true });
    }
    logger.error('[webhook] Idempotency insert failed: ' + e.message);
    // 即便去重表写入失败，也继续处理，不要把订阅事件丢了
  }

  const email = event?.data?.attributes?.user_email?.toLowerCase();
  const subscriptionStatus = event?.data?.attributes?.status;
  const endsAt = event?.data?.attributes?.ends_at
    ? Math.floor(new Date(event.data.attributes.ends_at).getTime() / 1000)
    : null;
  const renewsAt = event?.data?.attributes?.renews_at
    ? Math.floor(new Date(event.data.attributes.renews_at).getTime() / 1000)
    : null;

  if (!email) {
    return res.status(400).json({ error: 'Missing email' });
  }

  try {
    switch (eventName) {
      case 'subscription_created':
      case 'subscription_updated':
        if (subscriptionStatus === 'active' || subscriptionStatus === 'past_due') {
          await userDb.upgradeToPro(email, renewsAt || endsAt);
          logger.info(`[webhook] Upgraded ${email} to Pro (status=${subscriptionStatus})`);
        } else if (
          subscriptionStatus === 'cancelled' ||
          subscriptionStatus === 'expired' ||
          subscriptionStatus === 'unpaid'
        ) {
          await userDb.downgradeToFree(email);
          logger.info(`[webhook] Downgraded ${email} to Free (status=${subscriptionStatus})`);
        }
        break;

      case 'subscription_cancelled':
        // LemonSqueezy 的 cancelled 会在 ends_at 之前继续可用，这里仅打日志
        // 真正的下线交给 ends_at 到期 + status_check 触发的 updated 事件，或本次 status === 'expired'
        if (subscriptionStatus === 'expired') {
          await userDb.downgradeToFree(email);
        }
        logger.info(`[webhook] Cancelled ${email} (ends_at=${endsAt})`);
        break;

      case 'subscription_resumed':
        await userDb.upgradeToPro(email, renewsAt || endsAt);
        logger.info(`[webhook] Resumed ${email}`);
        break;

      case 'subscription_expired':
        await userDb.downgradeToFree(email);
        logger.info(`[webhook] Expired ${email}`);
        break;

      case 'subscription_payment_success':
        if (renewsAt) {
          await userDb.upgradeToPro(email, renewsAt);
        }
        logger.info(`[webhook] Payment success for ${email}`);
        break;

      case 'subscription_payment_failed':
        // 标记为 past_due，但保留 Pro 权益直到到期，便于用户补卡
        try {
          await userDb.db.execute({
            sql: `UPDATE users SET subscription_status = 'past_due' WHERE email = ?`,
            args: [email]
          });
        } catch (e) {
          logger.error('[webhook] mark past_due failed: ' + e.message);
        }
        logger.warn(`[webhook] Payment failed for ${email}`);
        break;

      default:
        logger.info(`[webhook] Unhandled event: ${eventName}`);
    }
  } catch (e) {
    logger.error('[webhook] handler failed: ' + e.message);
    return res.status(500).json({ error: '处理失败' });
  }

  res.json({ success: true });
});

// ============== 管理员路由 ==============

/**
 * 管理员密钥验证（要求 X-Admin-Key 头与 ADMIN_API_KEY 一致）
 */
function requireAdmin(req, res, next) {
  const key = req.headers['x-admin-key'];
  const adminKey = process.env.ADMIN_API_KEY;

  if (!adminKey) {
    logger.error('[admin] ADMIN_API_KEY not set');
    return res.status(500).json({ code: 500, message: '管理员功能未配置' });
  }

  if (!key || key !== adminKey) {
    return res.status(403).json({ code: 403, message: '无权访问' });
  }

  next();
}

// 管理员：手动赋予会员资格
router.post('/admin/grant-vip', requireAdmin, async (req, res) => {
  try {
    const { email, days = 365 } = req.body || {};
    if (!email || typeof email !== 'string') {
      return res.status(400).json({ code: 400, message: '请提供邮箱' });
    }
    const safeDays = Math.max(1, Math.min(3650, Number(days) || 365));

    // 验证用户存在
    const user = await userDb.getByEmail(email);
    if (!user) {
      return res.status(404).json({ code: 404, message: '用户不存在' });
    }

    const endsAt = Math.floor(Date.now() / 1000) + safeDays * 24 * 60 * 60;
    await userDb.upgradeToPro(email.toLowerCase(), endsAt);

    logger.info(`[admin] VIP granted to ${email} for ${safeDays} days`);
    res.json({ code: 0, message: `已赋予 ${email} 会员资格 ${safeDays} 天` });
  } catch (err) {
    logger.error('[admin] Grant VIP error: ' + err.message);
    res.status(500).json({ code: 500, message: '操作失败' });
  }
});

// 管理员：撤销会员资格
router.post('/admin/revoke-vip', requireAdmin, async (req, res) => {
  try {
    const { email } = req.body || {};
    if (!email || typeof email !== 'string') {
      return res.status(400).json({ code: 400, message: '请提供邮箱' });
    }

    const user = await userDb.getByEmail(email);
    if (!user) {
      return res.status(404).json({ code: 404, message: '用户不存在' });
    }

    await userDb.downgradeToFree(email);

    logger.info(`[admin] VIP revoked from ${email}`);
    res.json({ code: 0, message: `已撤销 ${email} 会员资格` });
  } catch (err) {
    logger.error('[admin] Revoke VIP error: ' + err.message);
    res.status(500).json({ code: 500, message: '操作失败' });
  }
});

module.exports = router;

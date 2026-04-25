/**
 * Creem Payment Provider
 * https://docs.creem.io/
 *
 * Creem 是「商户记录商」(Merchant of Record) 模型，自动处理：
 *   - 全球税务（含中国发票/欧盟 VAT/美国 sales tax）
 *   - 多种支付方式（Stripe / 银联 / Apple Pay / Google Pay / 加密货币 / 微信/支付宝海外）
 *   - 退款 / 拒付 / 反欺诈
 *
 * 与 LemonSqueezy 同样定位，但对中文用户体验更友好（更稳的国际卡支付 + 更低费率）。
 *
 * 启用方式:
 *   1. 在 Creem dashboard 创建 Product / Subscription (拿到 product_id)
 *   2. 创建 Webhook endpoint, 把 secret 填到 CREEM_WEBHOOK_SECRET
 *   3. 在 .env 设置:
 *        PAYMENT_PROVIDER=creem
 *        CREEM_API_KEY=creem_xxx
 *        CREEM_PRODUCT_ID_PRO_MONTHLY=prod_xxx
 *        CREEM_PRODUCT_ID_PRO_YEARLY=prod_xxx
 *        CREEM_PRODUCT_ID_BASIC_MONTHLY=prod_xxx
 *        CREEM_PRODUCT_ID_BASIC_YEARLY=prod_xxx
 *        CREEM_WEBHOOK_SECRET=whsec_xxx
 *   4. 重启后端 → 现有 /api/subscribe/checkout 和 /api/subscribe/webhook 路由自动切到 Creem
 *
 * 切换前 / 切换后行为对比:
 *   - LS 用户的 active 订阅: 不受影响（事件继续从 LS 来；除非你在 LS 后台关闭店铺）
 *   - 新订单: 走 Creem
 *   - 建议运行双通道一段时间, 确认 Creem 稳定后再关闭 LS
 */

const crypto = require('crypto');
const axios = require('axios');
const logger = require('../../utils/logger');

const CREEM_API_KEY = process.env.CREEM_API_KEY || '';
const CREEM_WEBHOOK_SECRET = process.env.CREEM_WEBHOOK_SECRET || '';
const CREEM_API_BASE = (process.env.CREEM_API_BASE || 'https://api.creem.io').replace(/\/+$/, '');

const PRODUCT_MAP = {
  'basic_monthly': process.env.CREEM_PRODUCT_ID_BASIC_MONTHLY || '',
  'basic_yearly': process.env.CREEM_PRODUCT_ID_BASIC_YEARLY || '',
  'pro_monthly': process.env.CREEM_PRODUCT_ID_PRO_MONTHLY || '',
  'pro_yearly': process.env.CREEM_PRODUCT_ID_PRO_YEARLY || '',
};

function isConfigured() {
  return !!(CREEM_API_KEY && CREEM_WEBHOOK_SECRET);
}

/**
 * 创建 checkout session
 * @param {object} args
 * @param {object} args.user  { id, email }
 * @param {string} args.plan  basic_monthly | basic_yearly | pro_monthly | pro_yearly
 * @param {string} args.redirectUrl
 * @returns {Promise<{checkoutUrl, checkoutId}>}
 */
async function createCheckout({ user, plan, redirectUrl }) {
  const productId = PRODUCT_MAP[plan];
  if (!productId) {
    throw new Error(`Creem product_id not configured for plan: ${plan}`);
  }
  if (!CREEM_API_KEY) {
    throw new Error('CREEM_API_KEY not configured');
  }

  const response = await axios.post(
    `${CREEM_API_BASE}/v1/checkouts`,
    {
      product_id: productId,
      customer: { email: user.email },
      success_url: redirectUrl,
      metadata: {
        user_id: String(user.id),
        plan,
      },
    },
    {
      headers: {
        'x-api-key': CREEM_API_KEY,
        'Content-Type': 'application/json',
      },
      timeout: 15000,
    },
  );

  const data = response.data || {};
  const checkoutUrl = data.checkout_url || data.url;
  const checkoutId = data.id || data.checkout_id;
  if (!checkoutUrl) throw new Error('Creem returned no checkout_url');

  return { checkoutUrl, checkoutId };
}

/**
 * 验证 webhook 签名（HMAC SHA256）
 * Creem 在 'creem-signature' 头里给出 hex 签名
 */
function verifyWebhook(rawBody, headers) {
  if (!CREEM_WEBHOOK_SECRET) return false;
  if (!Buffer.isBuffer(rawBody)) return false;

  const signature = String(headers['creem-signature'] || headers['x-creem-signature'] || '');
  if (!signature) return false;

  const expected = crypto
    .createHmac('sha256', CREEM_WEBHOOK_SECRET)
    .update(rawBody)
    .digest('hex');

  try {
    const sigBuf = Buffer.from(signature, 'hex');
    const expBuf = Buffer.from(expected, 'hex');
    return sigBuf.length === expBuf.length && crypto.timingSafeEqual(sigBuf, expBuf);
  } catch {
    return false;
  }
}

/**
 * 把 Creem 的事件解析成统一格式
 * @returns {{
 *   eventId: string,
 *   eventName: string,
 *   email: string|null,
 *   subscriptionStatus: string|null,
 *   endsAt: number|null,
 *   renewsAt: number|null,
 *   raw: object,
 * }|null}
 */
function parseEvent(rawBody, headers) {
  let event;
  try {
    event = JSON.parse(rawBody.toString('utf8'));
  } catch (e) {
    logger.error('[creem] webhook parse error: ' + e.message);
    return null;
  }

  // Creem 事件 schema (v1):
  //   { id, eventType: 'subscription.active' | 'subscription.canceled' | ..., createdAt, object: {...} }
  const eventName = event.eventType || event.type || event.event || '';
  const obj = event.object || event.data || {};
  const eventId =
    event.id ||
    headers['creem-event-id'] ||
    headers['x-event-id'] ||
    `${eventName}:${obj.id || ''}:${obj.updated_at || obj.updatedAt || ''}`;

  // 邮箱 / 订阅状态 / 时间字段在不同事件里位置可能不同，做容错抽取
  const email = (
    obj.customer && (obj.customer.email || obj.customer.emailAddress) ||
    obj.email ||
    (obj.metadata && obj.metadata.email) ||
    ''
  ).toLowerCase() || null;

  const subscriptionStatus = obj.status || obj.subscriptionStatus || null;

  const toUnixSec = (v) => {
    if (!v) return null;
    if (typeof v === 'number') return v > 1e12 ? Math.floor(v / 1000) : v;
    const t = Date.parse(v);
    return Number.isFinite(t) ? Math.floor(t / 1000) : null;
  };
  const endsAt = toUnixSec(obj.ends_at || obj.endsAt || obj.cancel_at);
  const renewsAt = toUnixSec(obj.renews_at || obj.renewsAt || obj.current_period_end);

  return {
    eventId: String(eventId),
    eventName: String(eventName),
    email,
    subscriptionStatus,
    endsAt,
    renewsAt,
    raw: event,
  };
}

/**
 * 把 Creem 事件名归一到我们内部使用的事件名
 * （内部事件名沿用 LemonSqueezy 那一套，方便 subscribe.js 复用 switch 分支）
 */
function normalizeEventName(creemEventName) {
  const map = {
    'subscription.active': 'subscription_created',
    'subscription.created': 'subscription_created',
    'subscription.update': 'subscription_updated',
    'subscription.updated': 'subscription_updated',
    'subscription.paid': 'subscription_payment_success',
    'subscription.canceled': 'subscription_cancelled',
    'subscription.cancelled': 'subscription_cancelled',
    'subscription.expired': 'subscription_expired',
    'subscription.trialing': 'subscription_updated',
    'subscription.past_due': 'subscription_payment_failed',
    'checkout.completed': 'subscription_created',
  };
  return map[creemEventName] || creemEventName;
}

module.exports = {
  name: 'creem',
  isConfigured,
  createCheckout,
  verifyWebhook,
  parseEvent,
  normalizeEventName,
};

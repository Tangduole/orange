/**
 * 订阅路由 - Lemon Squeezy 集成
 */

const express = require('express');
const router = express.Router();
const axios = require('axios');
const userDb = require('../userDb');
const auth = require('../auth');

// Lemon Squeezy 配置
const LS_API_KEY = process.env.LEMON_SQUEEZY_API_KEY || '';
const LS_STORE_ID = process.env.LEMON_SQUEEZY_STORE_ID || '';
const LS_VARIANT_ID_PRO = process.env.LEMON_SQUEEZY_VARIANT_ID_PRO || ''; // Pro 版本产品变体ID
const LS_WEBHOOK_SECRET = process.env.LEMON_SQUEEZY_WEBHOOK_SECRET || '';

// Lemon Squeezy API Base
const LS_API_BASE = 'https://api.lemonsqueezy.com/v1';

/**
 * 创建 Pro 订阅 checkout
 * POST /api/subscribe/checkout
 */
router.post('/checkout', auth.required, async (req, res) => {
  const { email } = req.user;
  
  if (!LS_API_KEY || !LS_STORE_ID || !LS_VARIANT_ID_PRO) {
    return res.json({
      code: 500,
      message: '订阅服务未配置，请联系管理员'
    });
  }

  try {
    // 创建 Lemon Squeezy Checkout
    const response = await axios.post(
      `${LS_API_BASE}/checkouts`,
      {
        data: {
          type: 'checkouts',
          attributes: {
            checkout_data: {
              email: email,
              custom: {
                user_id: req.user.id
              }
            },
            product_options: {
              redirect_url: `${process.env.FRONTEND_URL || 'https://orange-app.vercel.app'}/subscription?success=true`
            }
          },
          relationships: {
            store: { data: { type: 'stores', id: LS_STORE_ID } },
            variant: { data: { type: 'variants', id: LS_VARIANT_ID_PRO } }
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
    console.error('[subscribe] Checkout error:', e.response?.data || e.message);
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
  
  res.json({
    code: 0,
    data: {
      tier: req.user.tier,
      subscriptionStatus: req.user.subscription_status,
      subscriptionEndsAt: req.user.subscription_ends_at,
      usage
    }
  });
});

/**
 * Lemon Squeezy Webhook - 处理订阅事件
 * POST /api/subscribe/webhook
 */
router.post('/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  const signature = req.headers['x-signature'];
  
  // 验证签名（生产环境必须验证）
  if (process.env.NODE_ENV === 'production' && LS_WEBHOOK_SECRET) {
    const crypto = require('crypto');
    const hmac = crypto.createHmac('sha256', LS_WEBHOOK_SECRET);
    hmac.update(req.body);
    const expectedSignature = hmac.digest('hex');
    
    if (signature !== expectedSignature) {
      console.error('[webhook] Invalid signature');
      return res.status(403).json({ error: 'Invalid signature' });
    }
  }

  let event;
  try {
    event = JSON.parse(req.body.toString());
  } catch (e) {
    console.error('[webhook] Parse error:', e.message);
    return res.status(400).json({ error: 'Invalid JSON' });
  }

  console.log('[webhook] Received event:', event.meta?.event_name);

  const eventName = event.meta?.event_name;
  const email = event.data?.attributes?.user_email?.toLowerCase();
  const subscriptionStatus = event.data?.attributes?.status;
  const endsAt = event.data?.attributes?.ends_at ? new Date(event.data.attributes.ends_at).getTime() : null;
  const renewsAt = event.data?.attributes?.renews_at ? new Date(event.data.attributes.renews_at).getTime() : null;

  if (!email) {
    return res.status(400).json({ error: 'Missing email' });
  }

  try {
    switch (eventName) {
      case 'subscription_created':
      case 'subscription_updated':
        if (subscriptionStatus === 'active' || subscriptionStatus === 'past_due') {
          await userDb.upgradeToPro(email, renewsAt || endsAt);
          console.log(`[webhook] Upgraded ${email} to Pro`);
        } else if (subscriptionStatus === 'cancelled' || subscriptionStatus === 'expired') {
          await userDb.downgradeToFree(email);
          console.log(`[webhook] Downgraded ${email} to Free`);
        }
        break;

      case 'subscription_cancelled':
        await userDb.downgradeToFree(email);
        console.log(`[webhook] Cancelled ${email}`);
        break;

      case 'subscription_payment_success':
        // 续费成功，保持 Pro
        if (renewsAt) {
          await userDb.upgradeToPro(email, renewsAt);
        }
        console.log(`[webhook] Payment success for ${email}`);
        break;

      case 'subscription_payment_failed':
        console.log(`[webhook] Payment failed for ${email}`);
        break;

      default:
        console.log(`[webhook] Unhandled event: ${eventName}`);
    }
  } catch (e) {
    console.error('[webhook]处理失败:', e.message);
    return res.status(500).json({ error: '处理失败' });
  }

  res.json({ success: true });
});

module.exports = router;

// 管理员 API 密钥验证中间件
const ADMIN_KEY = process.env.ADMIN_API_KEY;

// 管理员密钥验证
function requireAdmin(req, res, next) {
  const key = req.headers['x-admin-key'];
  if (!ADMIN_KEY) {
    console.error('[admin] ADMIN_API_KEY not configured!');
    return res.status(500).json({ code: 500, message: '管理员功能未配置' });
  }
  if (key !== ADMIN_KEY) {
    return res.status(403).json({ code: 403, message: '无权访问' });
  }
  next();
}

// 管理员：手动赋予会员资格
router.post('/admin/grant-vip', requireAdmin, async (req, res) => {
  try {
    const { email, days = 365 } = req.body;
    if (!email) return res.status(400).json({ code: 400, message: '请提供邮箱' });
    
    const endsAt = Math.floor(Date.now() / 1000) + days * 24 * 60 * 60;
    await userDb.upgradeToPro(email.toLowerCase(), endsAt);
    
    console.log(`[admin] VIP granted to ${email} for ${days} days, expires: ${new Date(endsAt * 1000).toISOString()}`);
    res.json({ code: 0, message: `已赋予 ${email} 会员资格 ${days} 天` });
  } catch (err) {
    console.error('[admin] Grant VIP error:', err);
    res.status(500).json({ code: 500, message: '操作失败: ' + err.message });
  }
});

// 管理员：撤销会员资格
router.post('/admin/revoke-vip', requireAdmin, async (req, res) => {
  try {
    const { email } = req.body;
    if (!email) return res.status(400).json({ code: 400, message: '请提供邮箱' });
    
    await userDb.downgradeToFree(email);
    
    console.log(`[admin] VIP revoked from ${email}`);
    res.json({ code: 0, message: `已撤销 ${email} 会员资格` });
  } catch (err) {
    console.error('[admin] Revoke VIP error:', err);
    res.status(500).json({ code: 500, message: '操作失败' });
  }
});

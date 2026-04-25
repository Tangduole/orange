# Creem 支付迁移指南

> 把 orange 从 LemonSqueezy 迁到 [Creem](https://creem.io) 的完整步骤。
> 现有 LS 通道**不会**被破坏：通过 `PAYMENT_PROVIDER` 一行环境变量切换，可以安全双跑、逐步切换。

## 为什么换 Creem

| 维度                  | LemonSqueezy                    | Creem                                              |
| --------------------- | ------------------------------- | -------------------------------------------------- |
| 商户记录商 (MoR)      | ✅                              | ✅                                                 |
| 支持中国大陆用卡      | ⚠️ 部分国际卡受限               | ✅ 微信/支付宝海外、Stripe、Apple/Google Pay 全开  |
| 加密货币结算          | ❌                              | ✅                                                 |
| 自动开发票/税务       | ✅                              | ✅                                                 |
| 费率                  | 5% + $0.50                      | 4% + $0.40                                         |
| 中国用户结算稳定性    | 一般（拒付率偏高）              | 较好（Stripe 风控调优 + 替代支付方式更多）         |
| 退款流程              | 后台手动                        | API + 后台                                         |

如果你的目标人群同时覆盖**全球 + 中国大陆**，Creem 体验更好。

---

## 一、零停机迁移流程

总共 4 步：

### 1. 在 Creem 后台创建 4 个 Product

去 [creem.io/dashboard/products](https://creem.io/dashboard/products) 各创建一个：

| Product 名字（建议）  | 类型           | 价格        | 周期 |
| --------------------- | -------------- | ----------- | ---- |
| Orange Basic Monthly  | Subscription   | $4.99       | 月   |
| Orange Basic Yearly   | Subscription   | $39 (≈35% off)  | 年   |
| Orange Pro Monthly    | Subscription   | $9.99       | 月   |
| Orange Pro Yearly     | Subscription   | $79 (≈35% off)  | 年   |

> 每个 Product 创建完会有一个 `prod_xxxxx` ID，记下来。

### 2. 创建 Webhook endpoint

去 [creem.io/dashboard/webhooks](https://creem.io/dashboard/webhooks) 新建：

- **URL**: `https://你的域名/api/subscribe/webhook`
- **Events**: 至少订阅以下：
  - `subscription.active`
  - `subscription.update`
  - `subscription.canceled`
  - `subscription.expired`
  - `subscription.paid`
  - `subscription.past_due`
  - `checkout.completed`

创建完拿到 `whsec_xxxxx` 这是 webhook secret。

### 3. 拿 API Key

去 [creem.io/dashboard/api-keys](https://creem.io/dashboard/api-keys) 新建一个 server-side key（建议命名 `orange-prod`），格式 `creem_live_xxxxx`。

### 4. 配置 .env 并重启后端

```env
# 切到 Creem
PAYMENT_PROVIDER=creem

# Creem 凭证
CREEM_API_KEY=creem_live_xxxxx
CREEM_WEBHOOK_SECRET=whsec_xxxxx
CREEM_API_BASE=https://api.creem.io

# 4 个产品 ID
CREEM_PRODUCT_ID_BASIC_MONTHLY=prod_xxxxx
CREEM_PRODUCT_ID_BASIC_YEARLY=prod_xxxxx
CREEM_PRODUCT_ID_PRO_MONTHLY=prod_xxxxx
CREEM_PRODUCT_ID_PRO_YEARLY=prod_xxxxx
```

重启后端。`POST /api/subscribe/checkout` 自动转向 Creem，`POST /api/subscribe/webhook` 验签也切到 Creem。

> 注意：**LS 的 webhook 也会继续打到同一个 endpoint**。这没关系——`webhook_events` 表的去重 key 加了 provider 前缀（`lemonsqueezy:xxx` / `creem:xxx`），不会冲突。
> 但因为本路由根据 `PAYMENT_PROVIDER` 决定**用哪个 provider 验签**，在 `PAYMENT_PROVIDER=creem` 期间到来的 LS webhook 会被「Invalid signature」拒掉。

---

## 二、双通道平滑过渡（推荐）

如果你已经有活跃的 LS 订阅用户，**不要直接切**，按下面流程做：

```
T+0     PAYMENT_PROVIDER=lemonsqueezy（现状），新订单用 LS
        在 Creem 后台准备好 4 个 product 和 webhook
T+0     在 LS 后台关闭新订阅入口（保留续费、保留 webhook 推送）
T+0     上线一个新版本：PAYMENT_PROVIDER=creem
        新订单走 Creem；LS 老订单的「续费/取消」事件因为签名错被拒
T+1d    手动从 LS 后台导出活跃订阅列表，
        在 Creem 后台给这些用户发引导邮件，让他们重订（或代为创建）
T+30d   LS 上没有活跃订阅了，可以彻底关闭 LS 店铺
```

如果你不想手动迁老订阅（懒人模式）：
- 让 LS 老订阅自然到期 / 自然续费失败 → 后端在 `subscription_ends_at` 到点后自动降级
- Creem 一上来全都是新订单，不存在迁移问题

---

## 三、回滚

若 Creem 出问题，**一行回滚**：

```env
PAYMENT_PROVIDER=lemonsqueezy
```

重启即可。LS 凭证一直保留，能立刻接管。

---

## 四、价格本地化（强烈推荐）

Creem 支持按地区显示本地货币和定价。你可以在每个 Product 配置：

| 地区 / 国家 | Basic Monthly | Pro Monthly |
| ----------- | ------------- | ----------- |
| US/EU       | $4.99 / €4.99 | $9.99 / €9.99 |
| CN          | ¥29           | ¥58         |
| IN          | ₹199          | ₹399        |
| BR          | R$19          | R$39        |
| JP          | ¥600          | ¥1200       |

按购买力调整一次，长期 LTV 提升通常 20–40%。
配置入口：每个 Product → Pricing → Add region pricing。

---

## 五、退款 / 客诉 SOP

Creem 自带商户后台，常用操作：

- **退款**：Dashboard → Orders → 找到订单 → Refund
- **延长免费试用**：Dashboard → Subscriptions → Customer → Add credit
- **批量赠送会员**：用我们后端自带的 admin endpoint
  ```
  POST /api/subscribe/admin/grant-vip
  X-Admin-Key: <ADMIN_API_KEY>
  body: { "email": "user@example.com", "days": 30 }
  ```
  无论用 LS 还是 Creem，这个 admin 接口都生效。

---

## 六、监控

强烈建议在 Sentry/UptimeKuma 上加监控：

```bash
curl -X POST https://你的域名/api/subscribe/webhook \
  -H "Content-Type: application/json" \
  -d '{}'
# 期望返回 403 Invalid signature（说明路由活着、签名校验生效）
```

如果返回 500，说明 `CREEM_WEBHOOK_SECRET` 没配。

---

## 七、Creem 已知坑

1. **沙箱 / 生产 API key 是分开的**
   测试用 `creem_test_xxx`、生产用 `creem_live_xxx`，对应 `CREEM_API_BASE`：
   - 沙箱 → `https://api-sandbox.creem.io`
   - 生产 → `https://api.creem.io`（默认）

2. **Webhook 签名头大小写**
   Creem 在不同事件类型/版本下有时返回 `creem-signature`，有时 `Creem-Signature`。我们的 provider 已经做了双 header 兜底（`creem-signature` + `x-creem-signature`），不需要你额外处理。

3. **价格修改不会自动应用到老订阅**
   改 Pricing 后，**已经在订阅中的用户**还是按老价格续费，直到他们手动重订。这是 MoR 的通用行为，不是 bug。

4. **退款会触发 `subscription.canceled` webhook**
   后端会调用 `userDb.downgradeToFree(email)`，与 LS 行为一致。

---

## 八、问题排查 checklist

- [ ] `PAYMENT_PROVIDER=creem` 设置了？
- [ ] 4 个 `CREEM_PRODUCT_ID_*` 都填了？
- [ ] 后端 logs 是否出现 `[webhook][creem] Invalid signature`？→ 检查 `CREEM_WEBHOOK_SECRET` 是否复制错
- [ ] checkout 返回 500？→ 看 logs `[subscribe][creem] Checkout error`，常见原因 product_id 错或试图给 sandbox key 用 live API_BASE
- [ ] 用户付完款没升级？→ 看 `webhook_events` 表里是否有 `creem:xxx` 记录；没有的话说明 Creem webhook 没送到（防火墙 / DNS / Webhook Endpoint URL 错）

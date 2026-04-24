# 🔑 API密钥迁移指南

## 📌 重要说明

本次改进**只移除了硬编码的密钥**，所有API密钥的值本身没有变化。如果你之前已经配置过 `.env` 文件，大部分密钥可以直接复用。

---

## 🆕 新增的密钥

### TIKHUB_API_KEY_WECHAT（新增）

**位置**：之前硬编码在 `tools/wechat-downloader.js` 中

**原值**：`lrwNPvEUzE2ph0K5Oces5Q/RNRHRZ5tTzTTogR7aU/mj1li7O0XfZgWPCQ==`

**现在需要**：添加到 `.env` 文件

```bash
TIKHUB_API_KEY_WECHAT=lrwNPvEUzE2ph0K5Oces5Q/RNRHRZ5tTzTTogR7aU/mj1li7O0XfZgWPCQ==
```

⚠️ **安全建议**：如果这个密钥已经公开（在GitHub上），建议从 TikHub 重新生成一个新的密钥。

---

## 📋 完整配置清单

### 必需配置（必须设置）

```bash
# 1. JWT密钥（用于用户认证）
JWT_SECRET=<随机生成64字符>

# 2. 运行环境
NODE_ENV=production
```

**生成JWT_SECRET**：
```bash
# 方法1：Node.js
node -e "console.log(require('crypto').randomBytes(64).toString('hex'))"

# 方法2：PowerShell（Windows）
-join ((48..57) + (65..90) + (97..122) | Get-Random -Count 64 | % {[char]$_})
```

---

### 数据库配置（推荐）

```bash
# Turso云数据库（推荐）
TURSO_DATABASE_URL=libsql://your-database.turso.io
TURSO_AUTH_TOKEN=your_token_here
```

如果不配置，会使用本地SQLite数据库（`data/users.db`）

---

### API密钥配置（按需）

#### TikHub API（视频下载核心）

```bash
# YouTube下载
TIKHUB_API_KEY_YT=your_youtube_key

# 抖音下载
TIKHUB_API_KEY_DOUYIN=your_douyin_key

# Instagram下载
TIKHUB_API_KEY_INSTAGRAM=your_instagram_key

# 小红书下载
TIKHUB_API_KEY_XHS=your_xiaohongshu_key

# 微信视频下载（新增）
TIKHUB_API_KEY_WECHAT=your_wechat_key
```

**获取方式**：访问 https://www.tikhub.io/ 注册并获取API密钥

**注意**：
- 如果某个平台的密钥未配置，该平台的下载功能将不可用
- 抖音下载使用自研解析器，不依赖TikHub API

---

#### 邮件服务（用户注册验证）

```bash
RESEND_API_KEY=re_your_resend_key
```

**获取方式**：访问 https://resend.com/ 注册并获取API密钥

**如果不配置**：用户注册时无法发送验证邮件

---

#### Cloudflare（ASR语音识别）

```bash
CLOUDFLARE_EMAIL=your@email.com
CLOUDFLARE_ACCOUNT_ID=your_account_id
CLOUDFLARE_API_KEY=your_api_key
CLOUDFLARE_AI_TOKEN=your_ai_token
ASR_MODE=cloudflare
```

**如果不配置**：ASR（语音转文字）功能不可用

---

#### Lemon Squeezy（会员支付）

```bash
LEMON_SQUEEZY_API_KEY=your_key
LEMON_SQUEEZY_STORE_ID=your_store_id
LEMON_SQUEEZY_PRODUCT_ID=your_product_id
LEMON_SQUEEZY_WEBHOOK_SECRET=your_webhook_secret
```

**如果不配置**：会员订阅功能不可用

---

### 可选配置

```bash
# 日志级别（默认：info）
LOG_LEVEL=info  # debug, info, warn, error

# 文件保留时间（默认：24小时）
FILE_RETENTION_HOURS=24

# 应用URL
APP_URL=https://www.orangedl.com

# 管理员API密钥
ADMIN_API_KEY=your_random_admin_key
```

---

## 🚀 快速配置步骤

### 方法1：从模板创建（推荐）

```bash
# 1. 复制模板
cd orange/backend
cp .env.example .env

# 2. 编辑 .env 文件
# Windows: notepad .env
# Linux/Mac: nano .env

# 3. 至少配置以下必需项：
# - JWT_SECRET（生成随机值）
# - NODE_ENV=production
# - TIKHUB_API_KEY_WECHAT（如果使用微信下载）
```

### 方法2：使用快速修复脚本（Linux/Mac）

```bash
cd orange/backend
bash scripts/quick-fix.sh
# 脚本会自动生成JWT_SECRET和创建.env文件
```

### 方法3：手动创建最小配置

创建 `orange/backend/.env` 文件，包含最小配置：

```bash
# 最小配置（仅核心功能）
PORT=3000
NODE_ENV=production
JWT_SECRET=<运行下面命令生成>
LOG_LEVEL=info
FILE_RETENTION_HOURS=24

# 如果使用微信下载，添加：
TIKHUB_API_KEY_WECHAT=lrwNPvEUzE2ph0K5Oces5Q/RNRHRZ5tTzTTogR7aU/mj1li7O0XfZgWPCQ==
```

生成JWT_SECRET：
```bash
node -e "console.log(require('crypto').randomBytes(64).toString('hex'))"
```

---

## ✅ 验证配置

### 1. 检查必需变量

```bash
cd orange/backend
npm start
```

如果配置正确，应该看到：
```
[env] ✅ All environment variables validated successfully
🚀 Orange后端启动成功
```

如果缺少必需变量，会看到：
```
❌ Missing required environment variable: JWT_SECRET
```

### 2. 检查功能可用性

```bash
# 测试健康检查
curl http://localhost:3000/health/detailed
```

查看返回的 JSON，检查各项服务状态。

---

## 🔒 安全建议

### 1. 重新生成已泄露的密钥

如果以下密钥曾经提交到GitHub或公开：

- ✅ `TIKHUB_API_KEY_WECHAT`（已硬编码，建议重新生成）
- ✅ 任何其他可能泄露的密钥

**操作步骤**：
1. 访问对应服务的控制台
2. 撤销旧密钥
3. 生成新密钥
4. 更新 `.env` 文件

### 2. 保护 .env 文件

```bash
# 设置文件权限（Linux/Mac）
chmod 600 .env

# 确保 .env 在 .gitignore 中
echo ".env" >> .gitignore
```

### 3. 使用不同的密钥

- 开发环境和生产环境使用不同的密钥
- 不要在多个项目间共享密钥
- 定期轮换密钥（建议每3-6个月）

---

## 🆚 配置对比

### 之前（硬编码）

```javascript
// tools/wechat-downloader.js
const API_KEY = 'lrwNPvEUzE2ph0K5Oces5Q/RNRHRZ5tTzTTogR7aU/mj1li7O0XfZgWPCQ==';
```

❌ 问题：
- 密钥暴露在代码中
- 无法在不同环境使用不同密钥
- 密钥泄露后需要修改代码

### 现在（环境变量）

```bash
# .env 文件
TIKHUB_API_KEY_WECHAT=lrwNPvEUzE2ph0K5Oces5Q/RNRHRZ5tTzTTogR7aU/mj1li7O0XfZgWPCQ==
```

```javascript
// tools/wechat-downloader.js
const API_KEY = process.env.TIKHUB_API_KEY_WECHAT;
```

✅ 优势：
- 密钥不在代码中
- 可以为不同环境配置不同密钥
- 密钥泄露后只需更新 .env 文件

---

## 📞 常见问题

### Q1: 我之前没有配置过 .env，现在需要所有密钥吗？

**A**: 不需要。只需要配置：
- `JWT_SECRET`（必需）
- `NODE_ENV`（必需）
- 你实际使用的功能对应的密钥

### Q2: 硬编码的微信密钥还能用吗？

**A**: 可以用，但建议重新生成：
1. 如果密钥已公开在GitHub，可能被滥用
2. 从安全角度，应该使用自己的密钥

### Q3: 如何知道哪些密钥是必需的？

**A**: 启动服务时会自动验证：
- 必需的密钥缺失会导致启动失败
- 推荐的密钥缺失会显示警告但不影响启动

### Q4: 可以只配置部分平台的密钥吗？

**A**: 可以。例如：
- 只配置抖音密钥 → 只能下载抖音视频
- 不配置邮件密钥 → 用户注册不需要邮箱验证

---

## 📚 相关文档

- [SECURITY.md](SECURITY.md) - 安全配置详细指南
- [UPGRADE_GUIDE.md](UPGRADE_GUIDE.md) - 升级步骤
- [DEPLOYMENT_CHECKLIST.md](DEPLOYMENT_CHECKLIST.md) - 部署检查清单

---

## ✅ 配置完成检查清单

- [ ] 已创建 `.env` 文件
- [ ] 已配置 `JWT_SECRET`
- [ ] 已配置 `NODE_ENV`
- [ ] 已配置需要使用的API密钥
- [ ] 已验证服务启动成功
- [ ] 已测试核心功能
- [ ] `.env` 文件已添加到 `.gitignore`
- [ ] 已考虑重新生成可能泄露的密钥

---

配置完成后，运行 `npm start` 启动服务！🚀

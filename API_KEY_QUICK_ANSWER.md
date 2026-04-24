# ❓ API密钥配置 - 快速解答

## 🎯 直接回答你的问题

### Q: 使用到的API key是否需要重新配置？

**A: 不需要重新配置，但需要迁移到 .env 文件中。**

---

## 📝 具体说明

### 1. 如果你之前已经有 .env 文件

✅ **大部分密钥不需要改动**，只需要添加一个新的：

```bash
# 在现有的 .env 文件中添加这一行：
TIKHUB_API_KEY_WECHAT=lrwNPvEUzE2ph0K5Oces5Q/RNRHRZ5tTzTTogR7aU/mj1li7O0XfZgWPCQ==
```

这个密钥之前是硬编码在代码里的，现在需要放到 .env 文件中。

---

### 2. 如果你之前没有 .env 文件

需要创建一个。最简单的方法：

#### Windows用户：
```bash
cd orange\backend
node scripts\setup-env.js
# 或者双击运行：scripts\setup-env.bat
```

#### Linux/Mac用户：
```bash
cd orange/backend
node scripts/setup-env.js
```

按照提示选择配置模式即可。

---

## 🔑 密钥清单

### 必需配置（2个）

| 密钥 | 说明 | 如何获取 |
|------|------|----------|
| `JWT_SECRET` | 用户认证密钥 | 自动生成（运行配置脚本） |
| `NODE_ENV` | 运行环境 | 设置为 `production` |

### 新增配置（1个）

| 密钥 | 说明 | 原值 |
|------|------|------|
| `TIKHUB_API_KEY_WECHAT` | 微信视频下载 | `lrwNPvEUzE2ph0K5Oces5Q/RNRHRZ5tTzTTogR7aU/mj1li7O0XfZgWPCQ==` |

⚠️ **安全提示**：这个密钥之前在代码中公开了，建议从 [TikHub](https://www.tikhub.io/) 重新生成一个新的。

### 其他配置（按需）

所有其他API密钥（YouTube、抖音、邮件等）如果你之前配置过，可以直接复用，不需要改动。

---

## ⚡ 快速开始（3步）

### 步骤1：创建配置文件

```bash
cd orange/backend
node scripts/setup-env.js
```

选择 "1. 最小配置" 即可。

### 步骤2：添加微信密钥（如果需要）

编辑 `.env` 文件，取消注释并填入：

```bash
TIKHUB_API_KEY_WECHAT=lrwNPvEUzE2ph0K5Oces5Q/RNRHRZ5tTzTTogR7aU/mj1li7O0XfZgWPCQ==
```

### 步骤3：启动服务

```bash
npm start
```

看到这个就成功了：
```
✅ All environment variables validated successfully
🚀 Orange后端启动成功
```

---

## 🔒 安全建议

### 建议重新生成的密钥

由于以下密钥曾经在代码中公开：

- `TIKHUB_API_KEY_WECHAT`

**建议操作**：
1. 访问 https://www.tikhub.io/
2. 登录你的账户
3. 撤销旧密钥
4. 生成新密钥
5. 更新 `.env` 文件

### 不需要重新生成的密钥

- `JWT_SECRET` - 配置脚本会自动生成新的
- 其他所有API密钥 - 如果之前没有公开，可以继续使用

---

## 📋 配置对比

### 之前（代码中硬编码）

```javascript
// tools/wechat-downloader.js
const API_KEY = 'lrwNPvEUzE2ph0K5Oces5Q/...';  // ❌ 不安全
```

### 现在（环境变量）

```bash
# .env 文件
TIKHUB_API_KEY_WECHAT=lrwNPvEUzE2ph0K5Oces5Q/...  # ✅ 安全
```

```javascript
// tools/wechat-downloader.js
const API_KEY = process.env.TIKHUB_API_KEY_WECHAT;  // ✅ 从环境变量读取
```

---

## 🆘 遇到问题？

### 问题1：启动时提示缺少 JWT_SECRET

**解决**：运行配置脚本自动生成
```bash
node scripts/setup-env.js
```

### 问题2：不知道哪些密钥是必需的

**解决**：启动服务会自动检查
```bash
npm start
# 会显示缺少哪些必需的密钥
```

### 问题3：想保留之前的配置

**解决**：配置脚本会自动备份
```bash
node scripts/setup-env.js
# 选择 "y" 备份现有配置
```

---

## 📚 详细文档

- [API_KEY_MIGRATION_GUIDE.md](API_KEY_MIGRATION_GUIDE.md) - 完整迁移指南
- [SECURITY.md](SECURITY.md) - 安全配置指南
- [UPGRADE_GUIDE.md](UPGRADE_GUIDE.md) - 升级步骤

---

## ✅ 总结

**简单来说**：

1. ✅ 大部分API密钥不需要重新配置
2. ✅ 只需要把密钥从代码移到 .env 文件
3. ✅ 新增一个微信API密钥配置
4. ✅ 运行配置脚本可以自动完成大部分工作

**最快的方法**：

```bash
cd orange/backend
node scripts/setup-env.js  # 选择 "1. 最小配置"
npm start                   # 启动服务
```

就这么简单！🎉

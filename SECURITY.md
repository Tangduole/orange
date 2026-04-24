# 安全配置指南

## 🔒 安全改进清单

本项目已实施以下安全措施：

### 1. 依赖包安全
- ✅ 更新所有依赖包到最新安全版本
- ✅ 修复 axios、uuid、path-to-regexp 等漏洞
- ✅ 添加 helmet 安全头中间件

### 2. API 速率限制
- ✅ 全局 API 限制：15分钟100次请求
- ✅ 下载接口限制：1分钟10次请求
- ✅ 认证接口限制：15分钟5次请求
- ✅ 敏感操作限制：1小时3次请求

### 3. 密钥管理
- ✅ 移除所有硬编码的 API 密钥
- ✅ 强制要求 JWT_SECRET 环境变量
- ✅ 环境变量验证机制

### 4. 日志系统
- ✅ Winston 日志框架
- ✅ 错误日志和综合日志分离
- ✅ 日志文件自动轮转（5MB × 5个文件）

### 5. 文件管理
- ✅ 自动清理过期下载文件（默认24小时）
- ✅ 磁盘使用监控
- ✅ 路径遍历攻击防护

### 6. 数据库安全
- ✅ 所有查询使用参数化（防SQL注入）
- ✅ 密码使用 bcrypt 加密
- ✅ JWT token 认证

### 7. HTTPS 和安全头
- ✅ 生产环境强制 HTTPS 重定向
- ✅ Helmet 安全头（CSP、XSS防护等）
- ✅ CORS 白名单配置

---

## 🚀 部署前检查清单

### 必须配置的环境变量

```bash
# 必需
JWT_SECRET=<随机生成的长字符串>
NODE_ENV=production

# 推荐
TURSO_DATABASE_URL=<你的数据库URL>
TURSO_AUTH_TOKEN=<你的数据库token>
TIKHUB_API_KEY_YT=<YouTube API密钥>
TIKHUB_API_KEY_DOUYIN=<抖音API密钥>
RESEND_API_KEY=<邮件服务密钥>
```

### 生成安全的 JWT_SECRET

```bash
# 方法1：使用 Node.js
node -e "console.log(require('crypto').randomBytes(64).toString('hex'))"

# 方法2：使用 OpenSSL
openssl rand -hex 64
```

### 检查文件权限

```bash
# .env 文件应该只有所有者可读
chmod 600 .env

# 日志目录权限
chmod 755 logs/
```

---

## 🔍 安全监控

### 日志位置

```
backend/logs/error.log      # 错误日志
backend/logs/combined.log   # 所有日志
```

### 监控指标

1. **错误率**：检查 error.log 中的异常
2. **磁盘使用**：监控 downloads/ 目录大小
3. **速率限制触发**：429 错误频率
4. **认证失败**：401 错误频率

### 推荐监控工具

- **日志分析**：ELK Stack、Grafana Loki
- **性能监控**：PM2 Monitor、New Relic
- **错误追踪**：Sentry

---

## 🛡️ 安全最佳实践

### 1. 定期更新依赖

```bash
# 每月检查一次
npm audit
npm update

# 自动修复
npm audit fix
```

### 2. 备份数据库

```bash
# Turso 数据库自动备份
# 本地 SQLite 备份
cp backend/data/users.db backend/data/users.db.backup
```

### 3. 监控异常登录

- 检查来自异常IP的登录尝试
- 监控短时间内大量失败的登录
- 考虑添加 2FA（双因素认证）

### 4. API 密钥轮换

- 定期更换 API 密钥（建议每3-6个月）
- 使用不同的密钥用于开发和生产环境
- 密钥泄露后立即更换

### 5. HTTPS 证书

- 使用 Let's Encrypt 免费证书
- 设置自动续期
- 启用 HSTS（HTTP Strict Transport Security）

---

## 🚨 安全事件响应

### 如果发现安全漏洞

1. **立即行动**
   - 停止受影响的服务
   - 更换所有可能泄露的密钥
   - 检查日志确定影响范围

2. **通知用户**
   - 如果用户数据可能泄露，及时通知
   - 建议用户更改密码

3. **修复漏洞**
   - 更新代码
   - 部署补丁
   - 验证修复效果

4. **事后分析**
   - 记录事件经过
   - 分析根本原因
   - 改进安全措施

---

## 📞 联系方式

如果发现安全问题，请通过以下方式报告：

- GitHub Issues（非敏感问题）
- 私密邮件：[你的安全邮箱]

---

## 📚 参考资源

- [OWASP Top 10](https://owasp.org/www-project-top-ten/)
- [Node.js Security Best Practices](https://nodejs.org/en/docs/guides/security/)
- [Express Security Best Practices](https://expressjs.com/en/advanced/best-practice-security.html)

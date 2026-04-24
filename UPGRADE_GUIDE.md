# 升级指南 - 安全改进版本

## 📦 升级步骤

### 1. 备份现有数据

```bash
# 备份数据库
cp backend/data/users.db backend/data/users.db.backup

# 备份环境变量
cp backend/.env backend/.env.backup
```

### 2. 拉取最新代码

```bash
git pull origin master
```

### 3. 安装新依赖

```bash
cd backend
npm install
```

### 4. 更新环境变量

在 `.env` 文件中添加新的配置项：

```bash
# 日志级别（可选，默认 info）
LOG_LEVEL=info

# 文件保留时间（可选，默认 24 小时）
FILE_RETENTION_HOURS=24

# 微信下载器 API 密钥（如果使用）
TIKHUB_API_KEY_WECHAT=your_wechat_api_key_here
```

### 5. 验证配置

```bash
# 启动服务，检查环境变量验证
npm start
```

你应该看到类似输出：
```
[env] Validating required environment variables...
✅ JWT_SECRET is set
✅ NODE_ENV is set
[env] ✅ All environment variables validated successfully
🚀 Orange后端启动成功
```

### 6. 测试功能

- 测试登录/注册
- 测试视频下载
- 检查日志文件是否正常生成

---

## 🆕 新功能说明

### 1. 日志系统

**位置**：`backend/logs/`

- `error.log` - 仅错误日志
- `combined.log` - 所有日志

**配置**：
```bash
# 设置日志级别
LOG_LEVEL=debug  # debug, info, warn, error
```

### 2. 自动文件清理

**功能**：自动删除超过指定时间的下载文件

**配置**：
```bash
# 文件保留时间（小时）
FILE_RETENTION_HOURS=24  # 默认 24 小时
```

**监控**：
- 每小时自动运行一次
- 日志中会显示清理结果
- 磁盘使用超过 1GB 会发出警告

### 3. API 速率限制

**自动启用**，无需配置

限制规则：
- 全局 API：15分钟 100 次
- 下载接口：1分钟 10 次
- 登录/注册：15分钟 5 次
- 敏感操作：1小时 3 次

超过限制会返回 429 错误。

### 4. 安全增强

- ✅ Helmet 安全头
- ✅ HTTPS 强制重定向（生产环境）
- ✅ 环境变量验证
- ✅ 改进的错误处理

---

## 🔧 故障排除

### 问题1：启动时提示缺少环境变量

**错误**：
```
❌ Missing required environment variable: JWT_SECRET
```

**解决**：
```bash
# 在 .env 文件中添加
JWT_SECRET=your_secret_here
```

### 问题2：日志文件权限错误

**错误**：
```
Error: EACCES: permission denied, mkdir 'logs'
```

**解决**：
```bash
# 创建日志目录并设置权限
mkdir -p backend/logs
chmod 755 backend/logs
```

### 问题3：速率限制过于严格

**症状**：频繁收到 429 错误

**解决**：
修改 `backend/src/middleware/rateLimiter.js` 中的限制参数：

```javascript
// 例如：将下载限制从 10 次/分钟改为 20 次/分钟
const downloadLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 20,  // 修改这里
  // ...
});
```

### 问题4：文件清理太频繁

**症状**：文件被过早删除

**解决**：
```bash
# 在 .env 中增加保留时间
FILE_RETENTION_HOURS=48  # 改为 48 小时
```

---

## 📊 性能影响

### 资源使用

新功能的资源消耗：

| 功能 | CPU | 内存 | 磁盘 |
|------|-----|------|------|
| 日志系统 | +1% | +10MB | +50MB/天 |
| 速率限制 | +2% | +5MB | 0 |
| 文件清理 | +1% (每小时) | 0 | -节省空间 |

### 性能优化建议

1. **日志轮转**：日志文件自动限制在 25MB（5个文件 × 5MB）
2. **速率限制缓存**：使用内存存储，重启后重置
3. **文件清理**：异步执行，不影响主服务

---

## 🔄 回滚步骤

如果升级后遇到问题，可以回滚：

```bash
# 1. 停止服务
pm2 stop orange-backend

# 2. 恢复旧版本代码
git checkout <previous-commit-hash>

# 3. 恢复依赖
cd backend
npm install

# 4. 恢复环境变量
cp .env.backup .env

# 5. 恢复数据库
cp data/users.db.backup data/users.db

# 6. 重启服务
pm2 restart orange-backend
```

---

## 📞 获取帮助

如果遇到问题：

1. 检查日志文件：`backend/logs/error.log`
2. 查看 GitHub Issues
3. 阅读 SECURITY.md 文档

---

## ✅ 升级检查清单

- [ ] 备份数据库和配置
- [ ] 拉取最新代码
- [ ] 安装新依赖
- [ ] 更新环境变量
- [ ] 验证启动成功
- [ ] 测试核心功能
- [ ] 检查日志正常
- [ ] 监控性能指标
- [ ] 更新部署文档

---

升级完成后，你的应用将拥有更强的安全性和更好的可维护性！🎉

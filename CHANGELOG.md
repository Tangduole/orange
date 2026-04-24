# 更新日志

## [2.1.0] - 2024-04-24

### 🔒 安全改进

#### 依赖包更新
- 更新 `axios` 从 1.6.0 到 1.7.9（修复 SSRF 漏洞）
- 更新 `uuid` 从 9.0.1 到 11.0.3（修复缓冲区溢出）
- 更新 `express` 从 4.18.2 到 4.21.2（修复 ReDoS 漏洞）
- 修复所有已知的中高危安全漏洞

#### 密钥管理
- ✅ 移除硬编码的 API 密钥
- ✅ 强制要求 JWT_SECRET 环境变量
- ✅ 添加环境变量验证机制

#### 安全中间件
- ✅ 添加 Helmet 安全头
- ✅ 生产环境强制 HTTPS 重定向
- ✅ 改进 CORS 配置

### 🚀 新功能

#### 1. 日志系统
- 使用 Winston 专业日志框架
- 错误日志和综合日志分离
- 日志文件自动轮转（5MB × 5个文件）
- 支持日志级别配置

#### 2. API 速率限制
- 全局 API 限制：15分钟 100 次请求
- 下载接口限制：1分钟 10 次请求
- 认证接口限制：15分钟 5 次请求
- 敏感操作限制：1小时 3 次请求

#### 3. 自动文件清理
- 定期清理过期下载文件（默认24小时）
- 磁盘使用监控和告警
- 可配置的文件保留时间

#### 4. 健康检查端点
- `/health` - 基础健康检查
- `/health/detailed` - 详细系统状态
- `/health/ready` - 就绪检查（K8s）
- `/health/live` - 存活检查（K8s）

### 📝 文档

- ✅ 添加 SECURITY.md 安全配置指南
- ✅ 添加 UPGRADE_GUIDE.md 升级指南
- ✅ 添加 CHANGELOG.md 更新日志
- ✅ 更新 .env.example 配置模板

### 🔧 工具

- ✅ 添加快速修复脚本 `scripts/quick-fix.sh`
- ✅ 自动依赖更新
- ✅ 自动环境变量配置

### 🐛 Bug 修复

- 修复路径遍历安全漏洞
- 改进错误处理机制
- 优化数据库连接管理

---

## [2.0.0] - 之前版本

### 功能
- 多平台视频下载（抖音、TikTok、YouTube、X、Bilibili）
- 用户认证系统
- 会员订阅功能
- 推荐系统
- 多语言支持
- 移动端支持

---

## 升级说明

从 2.0.0 升级到 2.1.0：

1. 备份数据：
   ```bash
   cp backend/data/users.db backend/data/users.db.backup
   cp backend/.env backend/.env.backup
   ```

2. 拉取代码：
   ```bash
   git pull origin master
   ```

3. 运行快速修复脚本：
   ```bash
   cd backend
   bash scripts/quick-fix.sh
   ```

4. 重启服务：
   ```bash
   pm2 restart orange-backend
   ```

详细升级指南请参考 [UPGRADE_GUIDE.md](UPGRADE_GUIDE.md)

---

## 安全公告

如果发现安全漏洞，请查看 [SECURITY.md](SECURITY.md) 了解报告流程。

---

## 贡献

欢迎提交 Issue 和 Pull Request！

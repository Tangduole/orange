# 🚀 部署检查清单

## 部署前准备

### 1. 环境准备
- [ ] Node.js 18+ 已安装
- [ ] npm 已安装
- [ ] Git 已安装
- [ ] 服务器已配置（如果远程部署）

### 2. 代码准备
- [ ] 已拉取最新代码
- [ ] 已备份现有数据库
- [ ] 已备份现有配置文件

### 3. 依赖安装
```bash
cd backend
npm install
```
- [ ] 依赖安装成功
- [ ] 无严重错误或警告

---

## 配置检查

### 1. 环境变量（.env）

#### 必需配置
- [ ] `JWT_SECRET` - 已设置（64字符随机字符串）
- [ ] `NODE_ENV` - 已设置为 `production`

#### 数据库配置
- [ ] `TURSO_DATABASE_URL` - 已设置
- [ ] `TURSO_AUTH_TOKEN` - 已设置

#### API 密钥
- [ ] `TIKHUB_API_KEY_YT` - YouTube API密钥
- [ ] `TIKHUB_API_KEY_DOUYIN` - 抖音API密钥
- [ ] `TIKHUB_API_KEY_INSTAGRAM` - Instagram API密钥
- [ ] `TIKHUB_API_KEY_WECHAT` - 微信API密钥（如需要）

#### 邮件服务
- [ ] `RESEND_API_KEY` - 邮件服务密钥

#### Cloudflare（可选）
- [ ] `CLOUDFLARE_EMAIL` - Cloudflare邮箱
- [ ] `CLOUDFLARE_ACCOUNT_ID` - 账户ID
- [ ] `CLOUDFLARE_API_KEY` - API密钥
- [ ] `CLOUDFLARE_AI_TOKEN` - AI Token

#### 支付服务（可选）
- [ ] `LEMON_SQUEEZY_API_KEY` - Lemon Squeezy API密钥
- [ ] `LEMON_SQUEEZY_STORE_ID` - 店铺ID
- [ ] `LEMON_SQUEEZY_PRODUCT_ID` - 产品ID
- [ ] `LEMON_SQUEEZY_WEBHOOK_SECRET` - Webhook密钥

#### 其他配置
- [ ] `APP_URL` - 应用URL（如 https://www.orangedl.com）
- [ ] `LOG_LEVEL` - 日志级别（默认 info）
- [ ] `FILE_RETENTION_HOURS` - 文件保留时间（默认 24）

### 2. 目录权限
```bash
mkdir -p logs data downloads
chmod 755 logs data downloads
```
- [ ] logs/ 目录已创建
- [ ] data/ 目录已创建
- [ ] downloads/ 目录已创建
- [ ] 权限设置正确

### 3. 文件检查
- [ ] .env 文件存在且配置正确
- [ ] .env 文件权限为 600（仅所有者可读写）
- [ ] package.json 依赖版本正确
- [ ] 所有新增文件已提交

---

## 安全检查

### 1. 依赖安全
```bash
npm audit
```
- [ ] 无高危漏洞
- [ ] 无中危漏洞（或已知晓并接受）

### 2. 密钥安全
- [ ] 无硬编码密钥
- [ ] .env 文件不在版本控制中
- [ ] JWT_SECRET 足够复杂（64+字符）

### 3. 网络安全
- [ ] HTTPS 已配置
- [ ] 防火墙规则已设置
- [ ] 仅开放必要端口（80, 443, 22）

---

## 功能测试

### 1. 启动测试
```bash
npm start
```
- [ ] 服务启动成功
- [ ] 无错误日志
- [ ] 环境变量验证通过
- [ ] 端口监听正常

### 2. 健康检查
```bash
curl http://localhost:3000/health
```
- [ ] 返回 200 状态码
- [ ] 返回 JSON 格式数据
- [ ] status 为 "ok"

### 3. 详细健康检查
```bash
curl http://localhost:3000/health/detailed
```
- [ ] 数据库检查通过
- [ ] 存储检查通过
- [ ] 内存检查正常
- [ ] 环境变量检查通过

### 4. API 测试
```bash
# 测试注册
curl -X POST http://localhost:3000/api/auth/register \
  -H "Content-Type: application/json" \
  -d '{"email":"test@example.com","password":"test123456"}'

# 测试登录
curl -X POST http://localhost:3000/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"test@example.com","password":"test123456"}'
```
- [ ] 注册功能正常
- [ ] 登录功能正常
- [ ] 返回正确的响应格式

### 5. 速率限制测试
```bash
# 快速发送多个请求
for i in {1..15}; do curl http://localhost:3000/api/health; done
```
- [ ] 超过限制后返回 429 错误
- [ ] 错误消息正确

### 6. 下载功能测试
- [ ] 抖音视频下载正常
- [ ] YouTube视频下载正常
- [ ] 其他平台下载正常
- [ ] 文件保存正确

---

## 日志检查

### 1. 日志文件
```bash
ls -lh backend/logs/
```
- [ ] error.log 已创建
- [ ] combined.log 已创建
- [ ] 文件权限正确

### 2. 日志内容
```bash
tail -f backend/logs/combined.log
```
- [ ] 启动日志正常
- [ ] 无异常错误
- [ ] 日志格式正确

### 3. 错误日志
```bash
tail -f backend/logs/error.log
```
- [ ] 无严重错误
- [ ] 错误信息清晰

---

## 性能检查

### 1. 内存使用
```bash
curl http://localhost:3000/health/detailed | jq '.checks.memory'
```
- [ ] 内存使用合理（< 500MB）
- [ ] 无内存泄漏迹象

### 2. 磁盘使用
```bash
du -sh backend/downloads/
```
- [ ] 磁盘使用合理
- [ ] 文件清理任务已启动

### 3. 响应时间
```bash
time curl http://localhost:3000/health
```
- [ ] 响应时间 < 100ms
- [ ] 无明显延迟

---

## 生产环境配置

### 1. 进程管理（PM2）
```bash
npm install -g pm2
pm2 start backend/src/app.js --name orange-backend
pm2 save
pm2 startup
```
- [ ] PM2 已安装
- [ ] 服务已添加到 PM2
- [ ] 开机自启动已配置
- [ ] PM2 配置已保存

### 2. 反向代理（Nginx）
```nginx
server {
    listen 80;
    server_name api.orangedl.com;
    
    location / {
        proxy_pass http://localhost:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_cache_bypass $http_upgrade;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```
- [ ] Nginx 已配置
- [ ] 反向代理正常工作
- [ ] SSL 证书已配置

### 3. 防火墙
```bash
ufw allow 22/tcp
ufw allow 80/tcp
ufw allow 443/tcp
ufw enable
```
- [ ] 防火墙已启用
- [ ] 必要端口已开放
- [ ] 不必要端口已关闭

---

## 监控配置

### 1. 日志监控
- [ ] 日志轮转已配置
- [ ] 日志告警已设置
- [ ] 日志备份已配置

### 2. 性能监控
- [ ] CPU 使用率监控
- [ ] 内存使用率监控
- [ ] 磁盘使用率监控
- [ ] 网络流量监控

### 3. 应用监控
- [ ] 健康检查定时任务
- [ ] 错误率监控
- [ ] 响应时间监控
- [ ] API 调用量监控

---

## 备份配置

### 1. 数据库备份
```bash
# 每日备份脚本
0 2 * * * cp /path/to/backend/data/users.db /path/to/backup/users.db.$(date +\%Y\%m\%d)
```
- [ ] 备份脚本已创建
- [ ] 定时任务已配置
- [ ] 备份存储位置已确认

### 2. 配置备份
- [ ] .env 文件已备份
- [ ] Nginx 配置已备份
- [ ] PM2 配置已备份

### 3. 代码备份
- [ ] Git 仓库已推送
- [ ] 标签已创建
- [ ] 发布版本已记录

---

## 文档更新

- [ ] README.md 已更新
- [ ] CHANGELOG.md 已更新
- [ ] API 文档已更新
- [ ] 部署文档已更新

---

## 最终检查

### 1. 功能完整性
- [ ] 所有核心功能正常
- [ ] 所有API端点可访问
- [ ] 前端页面正常显示

### 2. 性能稳定性
- [ ] 压力测试通过
- [ ] 长时间运行稳定
- [ ] 无内存泄漏

### 3. 安全合规
- [ ] 所有安全检查通过
- [ ] 无已知漏洞
- [ ] 符合安全标准

### 4. 用户体验
- [ ] 响应速度快
- [ ] 错误提示清晰
- [ ] 功能易用

---

## 部署完成

### 签署确认

- 部署人员：__________________
- 部署日期：__________________
- 版本号：__________________
- 环境：__________________

### 备注

```
记录任何特殊配置或注意事项：




```

---

## 回滚计划

如果部署失败，执行以下步骤：

1. 停止服务
   ```bash
   pm2 stop orange-backend
   ```

2. 恢复代码
   ```bash
   git checkout <previous-version>
   ```

3. 恢复数据库
   ```bash
   cp backend/data/users.db.backup backend/data/users.db
   ```

4. 恢复配置
   ```bash
   cp backend/.env.backup backend/.env
   ```

5. 重启服务
   ```bash
   pm2 restart orange-backend
   ```

---

## 联系方式

- 技术支持：__________________
- 紧急联系：__________________
- 文档地址：__________________

---

✅ 检查清单完成！

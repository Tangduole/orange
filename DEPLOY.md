# 部署文档

## 换服务器（全新部署）

### 第一步：创建新服务器
- 推荐：Vultr 美西节点（Los Angeles），Ubuntu 22.04 LTS
- 需要打开 22（SSH）、80（HTTP）、443（HTTPS）端口

### 第二步：一键初始化
```bash
curl -fsSL https://raw.githubusercontent.com/Tangduole/orange/master/backend/scripts/setup.sh | \
  SERVER_IP=你的服务器IP \
  SSH_USER=root \
  SSH_KEY_PATH=~/.ssh/id_rsa \
  bash
```

### 第三步：填入真实密钥
```bash
ssh root@你的服务器IP
nano /opt/orange/backend/.env
# 填入所有 API 密钥
pm2 restart orange-backend
```

### 第四步：更新 DNS
将 `api.orangedl.com` 的 A 记录指向新服务器 IP（Cloudflare DNS Only 模式）

---

## 日常代码更新

推送代码到 GitHub master 分支 → **自动部署**（GitHub Actions）

```bash
git add .
git commit -m "your changes"
git push origin master
# GitHub Actions 自动完成部署
```

---

## 手动部署（备用）

如果 GitHub Actions 不可用：

```bash
# 在本地执行
scp -i ~/.ssh/id_rsa deploy.sh root@服务器IP:/opt/orange/backend/deploy.sh
ssh -i ~/.ssh/id_rsa root@服务器IP "bash /opt/orange/backend/deploy.sh"
```

---

## 环境变量说明

所有密钥都在 `/opt/orange/backend/.env`（不上传 GitHub）。

| 变量 | 来源 |
|------|------|
| `TURSO_DATABASE_URL` | Turso Cloud 控制台 |
| `TURSO_AUTH_TOKEN` | Turso Cloud 控制台 |
| `TIKHUB_API_KEY_*` | tikhub.io API 密钥 |
| `RESEND_API_KEY` | resend.com API 密钥 |
| `JWT_SECRET` | 随机字符串（用于签名 JWT） |
| `CLOUDFLARE_*` | Cloudflare 账户 |

---

## 常用 PM2 命令

```bash
pm2 status              # 查看状态
pm2 logs orange-backend --lines 50  # 查看日志
pm2 restart orange-backend         # 重启
pm2 monit              # 监控面板
```

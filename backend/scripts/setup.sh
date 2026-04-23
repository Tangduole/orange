#!/bin/bash
# ============================================
# 橙子下载器 - 新服务器初始化脚本
# ============================================
# 使用方式: curl -fsSL https://raw.githubusercontent.com/Tangduole/orange/master/backend/scripts/setup.sh | bash
#
# 运行前需要设置环境变量（或替换下面的值）：
#   export SERVER_IP="你的服务器IP"
#   export SSH_USER="root"
#   export SSH_KEY_PATH="~/.ssh/id_rsa"
#   export GITHUB_REPO="git@github.com:Tangduole/orange.git"

set -e

# --------------- 配置区（修改这里）---------------
SERVER_IP="${SERVER_IP:-}"
SSH_USER="${SSH_USER:-root}"
SSH_KEY_PATH="${SSH_KEY_PATH:-$HOME/.ssh/id_rsa}"
GITHUB_REPO="${GITHUB_REPO:-git@github.com:Tangduole/orange.git}"
BACKEND_DIR="/opt/orange/backend"
APP_NAME="orange-backend"
# -------------------------------------------------

echo "=========================================="
echo "  橙子下载器 - 服务器初始化"
echo "=========================================="
echo "服务器: $SERVER_IP"
echo "目录:   $BACKEND_DIR"

if [ -z "$SERVER_IP" ]; then
  echo "❌ 错误: 请设置 SERVER_IP 环境变量"
  echo "   示例: SERVER_IP=1.2.3.4 bash <(curl -fsSL ...)"
  exit 1
fi

echo ""
echo "[1/8] 检查 SSH 连接..."
ssh -i "$SSH_KEY_PATH" -o StrictHostKeyChecking=no "$SSH_USER@$SERVER_IP" "echo 'SSH连接成功'" || {
  echo "❌ SSH 连接失败，请检查 IP、用户名、密钥是否正确"
  exit 1
}

echo ""
echo "[2/8] 更新系统..."
ssh -i "$SSH_KEY_PATH" "$SSH_USER@$SERVER_IP" "
  apt-get update -qq && apt-get upgrade -y -qq
" 2>&1 | tail -3

echo ""
echo "[3/8] 安装基础软件 (Node.js, PM2, nginx, certbot, ffmpeg)..."
ssh -i "$SSH_KEY_PATH" "$SSH_USER@$SERVER_IP" "
  # Node.js 18.x
  curl -fsSL https://deb.nodesource.com/setup_18.x | bash -
  apt-get install -y nodejs

  # PM2
  npm install -g pm2

  # nginx, certbot, ffmpeg
  apt-get install -y nginx certbot python3-certbot-nginx ffmpeg

  # 创建目录
  mkdir -p $BACKEND_DIR/downloads
  mkdir -p /root/.pm2/logs

  echo '基础软件安装完成'
" 2>&1 | grep -E '(Setting up|done|安装完成|Complete)' | tail -10

echo ""
echo "[4/8] 从 GitHub 拉取代码..."
ssh -i "$SSH_KEY_PATH" "$SSH_USER@$SERVER_IP" "
  if [ -d '$BACKEND_DIR/.git' ]; then
    echo '代码已存在，执行 git pull...'
    cd $BACKEND_DIR && git pull origin master
  else
    echo '克隆新代码...'
    git clone $GITHUB_REPO $BACKEND_DIR
  fi
"

echo ""
echo "[5/8] 安装依赖..."
ssh -i "$SSH_KEY_PATH" "$SSH_USER@$SERVER_IP" "
  cd $BACKEND_DIR/backend && npm install --production
"

echo ""
echo "[6/8] 配置环境变量 (.env)..."
ssh -i "$SSH_KEY_PATH" "$SSH_USER@$SERVER_IP" "
  if [ ! -f $BACKEND_DIR/.env ]; then
    cp $BACKEND_DIR/backend/.env.example $BACKEND_DIR/.env 2>/dev/null || true
    echo '请手动编辑 $BACKEND_DIR/.env 填入真实的 API 密钥'
  fi
"

echo ""
echo "[7/8] 配置 PM2 开机自启..."
ssh -i "$SSH_KEY_PATH" "$SSH_USER@$SERVER_IP" "
  cd $BACKEND_DIR/backend
  pm2 start ecosystem.config.js
  pm2 save
  env PATH=\$(which node):\$PATH pm2 startup | grep -v 'PM2' | head -1 | bash 2>/dev/null || true
  echo 'PM2 配置完成'
"

echo ""
echo "[8/8] 配置 Nginx + SSL..."
ssh -i "$SSH_KEY_PATH" "$SSH_USER@$SERVER_IP" "
  # 创建 nginx 配置（Let\'s Encrypt 证书由 certbot 自动管理）
  DOMAIN='api.orangedl.com'
  cat > /etc/nginx/sites-available/\$DOMAIN << 'NGINX_EOF'
server {
    server_name \$DOMAIN;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_cache_bypass \$http_upgrade;
    }

    listen 80;
}
NGINX_EOF

  ln -sf /etc/nginx/sites-available/\$DOMAIN /etc/nginx/sites-enabled/\$DOMAIN
  nginx -t && systemctl reload nginx

  # 申请 SSL 证书（需要 DNS 已指向此服务器）
  certbot --nginx -d \$DOMAIN --noninteractive --agree-tos -m admin@orangedl.com || {
    echo 'SSL 证书申请失败，请确保 DNS 已正确指向此服务器'
  }

  echo 'Nginx + SSL 配置完成'
"

echo ""
echo "=========================================="
echo "  初始化完成！"
echo "=========================================="
echo ""
echo "下一步："
echo "1. 编辑 $BACKEND_DIR/.env 填入真实的 API 密钥"
echo "2. 重启后端: pm2 restart $APP_NAME"
echo "3. 测试: curl https://api.orangedl.com/api/health"
echo ""
echo "如果需要 GitHub Actions 自动部署，还需要："
echo "4. 在 GitHub Secrets 添加 VULTR_SSH_PRIVATE_KEY 和 VULTR_HOST"

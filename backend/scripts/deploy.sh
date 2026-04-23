#!/bin/bash
# ============================================
# 橙子下载器 - 代码部署脚本
# ============================================
# 使用方式: bash deploy.sh
# 或通过 GitHub Actions SSH 自动调用

set -e

BACKEND_DIR="/opt/orange/backend"
APP_NAME="orange-backend"

echo "[1/3] Git pull..."
cd $BACKEND_DIR && git pull origin master

echo "[2/3] 安装依赖..."
cd $BACKEND_DIR/backend && npm install --production

echo "[3/3] 重启 PM2..."
pm2 restart $APP_NAME
pm2 save
pm2 logs $APP_NAME --lines 3 --nostream

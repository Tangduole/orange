#!/bin/bash
# ============================================
# 橙子下载器 - 代码部署脚本
# ============================================
# 使用方式: bash deploy.sh
# 或通过 GitHub Actions SSH 自动调用

set -e

BACKEND_DIR="/root/orange-backend"
APP_NAME="orange-backend"

echo "[1/4] Git pull..."
cd $BACKEND_DIR && git pull origin master

echo "[2/4] 安装后端依赖..."
cd $BACKEND_DIR/backend && npm install --no-audit --no-fund

echo "[3/4] 重启 PM2..."
pm2 restart $APP_NAME --update-env
pm2 save
pm2 logs $APP_NAME --lines 3 --nostream

echo "[4/4] 构建前端..."
cd $BACKEND_DIR/frontend && npm install --no-audit --no-fund && npm run build

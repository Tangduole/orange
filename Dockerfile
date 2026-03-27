# 小电驴 - Docker 配置
FROM node:18-alpine

WORKDIR /app

# 安装系统依赖
RUN apk add --no-cache python3 py3-pip make g++ ffmpeg curl
RUN pip3 install --break-system-packages --upgrade yt-dlp

# 复制后端
COPY backend/package*.json ./
RUN npm install --production

COPY backend/ ./backend/

# 复制前端构建产物（稍后由构建命令生成）
COPY frontend/dist/ ./frontend/dist/

# 端口
EXPOSE 3000

# 启动
CMD ["node", "backend/src/app.js"]

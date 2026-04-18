# 橙子下载器 - Docker 配置
# 多阶段构建

# 阶段 1: 构建前端
FROM node:18-alpine as frontend-builder
WORKDIR /app/frontend
COPY frontend/package*.json ./
RUN npm install
COPY frontend/ .
RUN npm run build

# 阶段 2: 后端 + 全栈
FROM python:3.11-slim as final

# Install system dependencies
RUN apt-get update && apt-get install -y \
    nodejs \
    npm \
    ffmpeg \
    wget \
    curl \
    && rm -rf /var/lib/apt/lists/*

# Install yt-dlp
RUN pip3 install --break-system-packages --upgrade yt-dlp

# Install faster-whisper for ASR
RUN pip install --no-cache-dir faster-whisper
# Pre-download small model for Chinese ASR (medium too large for Railway free tier)
RUN python3 -c "from faster_whisper import WhisperModel; WhisperModel('small', device='cpu', compute_type='int8')"

WORKDIR /app

# Copy backend
COPY backend/package*.json ./backend/
WORKDIR /app/backend
RUN npm install --production
WORKDIR /app

# Copy backend source
COPY backend/src ./backend/src

# Copy built frontend
COPY --from=frontend-builder /app/frontend/dist ./frontend/dist

# Copy scripts
COPY scripts ./scripts

# Create downloads directory
RUN mkdir -p /app/downloads

# Expose port
EXPOSE 3000

# Start
CMD ["node", "backend/src/app.js"]

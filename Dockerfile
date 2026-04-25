# 橙子下载器 - Docker 配置（多阶段构建）
#
# 安全要点：
#  - 以非 root 用户 node 运行。
#  - 暴露 HEALTHCHECK 给编排平台。

# ---------- 阶段 1：构建前端 ----------
FROM node:20-bookworm-slim AS frontend-builder
WORKDIR /app/frontend
COPY frontend/package*.json ./
# 优先用 lockfile 走 ci，没有 lockfile 时回退到 install
RUN if [ -f package-lock.json ]; then npm ci; else npm install; fi
COPY frontend/ .
RUN npm run build

# ---------- 阶段 2：运行时（Node + ffmpeg + python+yt-dlp） ----------
FROM node:20-bookworm-slim AS final

ENV NODE_ENV=production \
    NPM_CONFIG_LOGLEVEL=warn \
    PIP_BREAK_SYSTEM_PACKAGES=1

# 系统依赖：ffmpeg（音频转码） + python3/pip（yt-dlp & faster-whisper） + curl（healthcheck）
RUN apt-get update && apt-get install -y --no-install-recommends \
        ffmpeg \
        python3 \
        python3-pip \
        curl \
        ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# yt-dlp + faster-whisper
RUN pip3 install --no-cache-dir --upgrade yt-dlp \
 && pip3 install --no-cache-dir faster-whisper

# 预下载 tiny 模型（约 75MB）
RUN python3 -c "from faster_whisper import WhisperModel; WhisperModel('tiny', device='cpu', compute_type='int8')"

WORKDIR /app

# 安装后端依赖
COPY backend/package*.json ./backend/
WORKDIR /app/backend
RUN if [ -f package-lock.json ]; then npm ci --omit=dev; else npm install --omit=dev; fi
WORKDIR /app

# 拷贝后端源码
COPY backend/src ./backend/src

# 拷贝前端构建产物
COPY --from=frontend-builder /app/frontend/dist ./frontend/dist

# 拷贝必要脚本（如果存在）
COPY scripts ./scripts

# 运行时目录（写入权限交给 node 用户）
RUN mkdir -p /app/downloads /app/logs \
 && chown -R node:node /app

# 切换到非 root 用户
USER node

EXPOSE 3000

# 健康检查（依赖 /health 路由）
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
    CMD curl -fsS http://127.0.0.1:3000/health || exit 1

CMD ["node", "backend/src/app.js"]

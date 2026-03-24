# 橙子下载器 - 多平台视频下载工具

🎵 支持抖音 / TikTok / YouTube / X / Bilibili 等平台视频下载

## 功能

- 🎬 视频下载（无水印）
- 📝 文案提取
- 🖼️ 封面提取
- 🎤 原声音频（ASR）
- 📄 字幕下载

## 技术栈

- **前端**: React + TypeScript + Tailwind CSS + Vite
- **后端**: Node.js + Express
- **下载核心**: yt-dlp + 原生解析器
- **部署**: Docker + Render

## 本地开发

```bash
# 安装依赖
cd backend && npm install
cd ../frontend && npm install

# 启动后端
cd backend && npm start

# 启动前端（另一个终端）
cd frontend && npm run dev
```

## 部署

推送代码到 GitHub，Render 会自动构建部署。

## 支持平台

| 平台 | 状态 | 说明 |
|------|------|------|
| 抖音 | ✅ | 原生解析器 |
| X/Twitter | ✅ | vxtwitter API |
| YouTube | ✅ | yt-dlp |
| TikTok | ✅ | yt-dlp |
| Bilibili | ✅ | yt-dlp |

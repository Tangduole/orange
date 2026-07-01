/**
 * 小电驴 - 后端入口
 */

require('dotenv').config();

const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');
const logger = require('./utils/logger');
const { validateEnv, validateDatabase, isProduction } = require('./utils/envValidator');
const { startCleanupSchedule } = require('./utils/fileCleanup');
const { apiLimiter } = require('./middleware/rateLimiter');
const apiRouter = require('./routes/api');
const authRouter = require('./routes/auth');
const subscribeRouter = require('./routes/subscribe');
const healthRouter = require('./routes/health');
const { verifyDownloadRequest } = require('./utils/downloadToken');
const { DOWNLOAD_DIR } = require('./services/yt-dlp');
const store = require('./store');

function buildAsciiFilename(filename) {
  return filename
    .replace(/[^\x20-\x7E]/g, '_')
    .replace(/["\\]/g, '_')
    .slice(0, 150) || 'download';
}

function setDownloadHeaders(res, {
  mimeType,
  disposition,
  encodedFilename,
  asciiFilename,
  stat,
  cacheTtl,
  etag,
}) {
  res.setHeader('Content-Type', mimeType);
  res.setHeader('Content-Disposition', `${disposition}; filename="${asciiFilename}"; filename*=UTF-8''${encodedFilename}`);
  res.setHeader('Accept-Ranges', 'bytes');
  res.setHeader('Last-Modified', stat.mtime.toUTCString());
  res.setHeader('ETag', etag);
  res.setHeader('Cache-Control', `private, max-age=${cacheTtl}`);
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Expose-Headers', 'Accept-Ranges, Content-Length, Content-Range, Content-Disposition, ETag, Last-Modified');
}

function parseRangeHeader(rangeHeader, fileSize) {
  if (!rangeHeader) return null;
  const match = String(rangeHeader).match(/^bytes=(\d*)-(\d*)$/);
  if (!match) return { invalid: true };

  let start = match[1] === '' ? null : Number(match[1]);
  let end = match[2] === '' ? null : Number(match[2]);

  if (start === null && end === null) return { invalid: true };
  if ((start !== null && !Number.isSafeInteger(start)) || (end !== null && !Number.isSafeInteger(end))) return { invalid: true };

  if (start === null) {
    const suffixLength = end;
    if (!suffixLength || suffixLength <= 0) return { invalid: true };
    start = Math.max(fileSize - suffixLength, 0);
    end = fileSize - 1;
  } else {
    if (start < 0 || start >= fileSize) return { invalid: true };
    if (end === null || end >= fileSize) end = fileSize - 1;
  }

  if (end < start) return { invalid: true };
  return { start, end };
}

// 验证环境变量
validateEnv();

// 确保关键目录存在（注意：__dirname 是 backend/src，向上一级才是 backend/）
const backendRoot = path.join(__dirname, '..');
for (const dir of ['downloads']) {
  const p = path.join(backendRoot, dir);
  if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
}

const app = express();
const PORT = process.env.PORT || 3000;

// 安全中间件
app.use(helmet({
  contentSecurityPolicy: false, // 允许内联脚本（前端需要）
  crossOriginEmbedderPolicy: false,
  crossOriginResourcePolicy: { policy: 'cross-origin' } // 允许前端跨域加载图片/视频
}));

// 信任代理（用于获取真实IP）
app.set('trust proxy', 1);

// HTTPS 重定向（生产环境）
if (isProduction()) {
  app.use((req, res, next) => {
    if (req.headers['x-forwarded-proto'] !== 'https') {
      return res.redirect('https://' + req.headers.host + req.url);
    }
    next();
  });
}

// 中间件
// CORS 配置（默认白名单 + 通过 ENV 扩展）
//   CORS_ALLOWED_ORIGINS  : 逗号分隔的 origin 列表（精确匹配）
//   CORS_ALLOWED_PATTERNS : 逗号分隔的正则字符串（按 RegExp 解析）
const defaultOrigins = [
  'https://orangedl.com',
  'https://www.orangedl.com',
  'https://api.orangedl.com',
  /^https:\/\/frontend-.*\.vercel\.app$/, // Vercel preview
  /^http:\/\/localhost:\d+$/              // 本地开发
];
const extraOrigins = String(process.env.CORS_ALLOWED_ORIGINS || '')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean);
const extraPatterns = String(process.env.CORS_ALLOWED_PATTERNS || '')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean)
  .map(p => {
    try { return new RegExp(p); } catch { return null; }
  })
  .filter(Boolean);
const allowedOrigins = [...defaultOrigins, ...extraOrigins, ...extraPatterns];

app.use(cors({
  origin: function (origin, callback) {
    // 允许无 origin 的请求（如 curl、服务器间调用）
    if (!origin) return callback(null, true);
    const allowed = allowedOrigins.some(pattern =>
      typeof pattern === 'string' ? origin === pattern : pattern.test(origin)
    );
    if (allowed) return callback(null, true);
    callback(new Error('Not allowed by CORS'));
  },
  credentials: true
}));

// LemonSqueezy webhook 必须拿到原始 body 才能做 HMAC 校验，
// 因此对 /api/subscribe/webhook 单独使用 express.raw，不参与全局 JSON 解析。
app.use('/api/subscribe/webhook', express.raw({ type: '*/*', limit: '1mb' }));

// Telegram Bot Webhook (在全局JSON解析之前处理)
app.post('/api/bot/telegram', express.json({ limit: '5mb' }), async (req, res) => {
  try {
    if (process.env.TELEGRAM_BOT_TOKEN) {
      const expected = process.env.TELEGRAM_WEBHOOK_SECRET || '';
      const received = String(req.headers['x-telegram-bot-api-secret-token'] || '');
      if (!expected) {
        logger.error('[Bot] TELEGRAM_WEBHOOK_SECRET not configured; rejecting webhook');
        return res.status(500).json({ ok: false });
      }
      const expectedBuf = Buffer.from(expected);
      const receivedBuf = Buffer.from(received);
      if (expectedBuf.length !== receivedBuf.length || !crypto.timingSafeEqual(expectedBuf, receivedBuf)) {
        logger.warn('[Bot] Invalid Telegram webhook secret');
        return res.status(403).json({ ok: false });
      }
    }
    const { handleWebhook } = require('./services/telegramBot');
    const result = await handleWebhook(req.body);
    res.json(result);
  } catch (e) {
    logger.error('[Bot] Webhook error:', e.message);
    res.json({ ok: false });
  }
});

// 其它请求统一走 JSON
app.use((req, res, next) => {
  if (req.originalUrl === '/api/subscribe/webhook') return next();
  return express.json({ limit: '1mb' })(req, res, next);
});

// 全局速率限制
app.use('/api', apiLimiter);

// API 路由
app.use('/api', apiRouter);
app.use('/api/auth', authRouter);
app.use('/api/subscribe', subscribeRouter);
app.use('/health', healthRouter);

// 静态提供下载文件（带正确的 Content-Disposition 头）
app.use('/download', (req, res, next) => {
  // 防止路径遍历攻击
  const normalized = path.normalize(req.path).replace(/^\//, '');
  if (normalized.includes('..') || path.isAbsolute(normalized)) {
    return res.status(403).send('Forbidden');
  }
  const filePath = path.resolve(DOWNLOAD_DIR, normalized);
  const relative = path.relative(DOWNLOAD_DIR, filePath);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    return res.status(403).send('Forbidden');
  }
  if (fs.existsSync(filePath)) {
    const stat = fs.statSync(filePath);
    if (!stat.isFile()) {
      return res.status(404).json({ error: 'File not found' });
    }

    const rawFilename = path.basename(filePath);
    if (!verifyDownloadRequest(rawFilename, req.query.exp, req.query.sig)) {
      return res.status(403).json({ error: 'Invalid or expired download link' });
    }
    const ext = path.extname(rawFilename).toLowerCase();
    
    // 从任务元数据获取视频标题作为下载文件名
    let downloadFilename = rawFilename;
    try {
      const taskId = rawFilename.replace(/_thumb|_cover|_audio|\.mp4|\.mp3|\.jpg|\.jpeg|\.png|\.webp|\.srt|\.vtt/gi, '');
      const task = store.get(taskId);
      if (task?.title) {
        const safeTitle = task.title.replace(/[\\/:*?"<>|]/g, '_').slice(0, 120);
        if (rawFilename.includes('_thumb') || rawFilename.includes('_cover')) {
          downloadFilename = safeTitle + '_cover' + ext;
        } else if (rawFilename.includes('_audio') || ext === '.mp3') {
          downloadFilename = safeTitle + ext;
        } else {
          downloadFilename = safeTitle + ext;
        }
      }
    } catch (e) {
      // fallback to raw filename
    }
    
    // 设置正确的 MIME 类型
    const mimeTypes = {
      '.mp4': 'video/mp4',
      '.mp3': 'audio/mpeg',
      '.jpg': 'image/jpeg',
      '.jpeg': 'image/jpeg',
      '.png': 'image/png',
      '.webp': 'image/webp',
      '.srt': 'text/plain',
      '.vtt': 'text/vtt',
    };
    
    const mimeType = mimeTypes[ext] || 'application/octet-stream';

    // 默认视频/音频用于保存时走 attachment；播放器预览显式带 preview=1 时走 inline。
    // 图片保持 inline（可以预览）
    let encodedFilename;
    try {
      // 安全的 URI 编码：先替换可能导致 malformed 的高位代理对字符
      const safeTitle = downloadFilename.replace(/[\uD800-\uDFFF]/g, '_');
      encodedFilename = encodeURIComponent(safeTitle);
    } catch (uriErr) {
      // downloadFilename 可能含 emoji/特殊字符导致 encodeURIComponent 抛异常
      // 回退到安全的原始文件名
      logger.warn(`[download] encodeURIComponent failed for "${String(downloadFilename).substring(0,50)}": ${uriErr.message}, falling back to raw filename`);
      try {
        encodedFilename = encodeURIComponent(rawFilename);
      } catch {
        // 终极兜底：只用 taskId
        encodedFilename = 'download_' + rawFilename.replace(/[^a-zA-Z0-9._-]/g, '_');
      }
    }
    const isMedia = ['.mp4', '.mp3', '.avi', '.mov', '.mkv', '.flv', '.webm'].includes(ext);
    const isPreview = req.query.preview === '1';
    const disposition = isMedia && !isPreview ? 'attachment' : 'inline';
    const asciiFilename = buildAsciiFilename(downloadFilename);
    const expSeconds = Number(req.query.exp || 0);
    const nowSeconds = Math.floor(Date.now() / 1000);
    const cacheTtl = Math.max(0, Math.min(expSeconds - nowSeconds, 6 * 60 * 60));
    const etag = `"${stat.size.toString(16)}-${Math.floor(stat.mtimeMs).toString(16)}"`;

    setDownloadHeaders(res, {
      mimeType,
      disposition,
      encodedFilename,
      asciiFilename,
      stat,
      cacheTtl,
      etag,
    });

    const range = parseRangeHeader(req.headers.range, stat.size);
    if (range?.invalid) {
      res.setHeader('Content-Range', `bytes */${stat.size}`);
      return res.status(416).end();
    }

    if (req.method === 'HEAD') {
      res.setHeader('Content-Length', stat.size);
      return res.status(200).end();
    }

    const streamOptions = { highWaterMark: 1024 * 1024 };
    if (range) {
      const chunkSize = range.end - range.start + 1;
      res.status(206);
      res.setHeader('Content-Length', chunkSize);
      res.setHeader('Content-Range', `bytes ${range.start}-${range.end}/${stat.size}`);
      streamOptions.start = range.start;
      streamOptions.end = range.end;
    } else {
      res.status(200);
      res.setHeader('Content-Length', stat.size);
    }

    const stream = fs.createReadStream(filePath, streamOptions);
    stream.on('error', err => {
      logger.error(`[download] stream failed for ${rawFilename}: ${err.message}`);
      if (!res.headersSent) res.status(500).end();
      else res.destroy(err);
    });
    req.on('close', () => stream.destroy());
    stream.pipe(res);
  } else {
    res.status(404).json({ error: 'File not found' });
  }
});

// Root route - return a simple health check or welcome message
app.get('/', (req, res) => {
  res.json({ 
    message: 'Orange后端运行中',
    api: '/api',
    status: 'ok'
  });
});

// 前端静态文件 (生产环境)
const frontendDist = path.join(__dirname, '../../frontend/dist');
if (fs.existsSync(frontendDist)) {
  app.use(express.static(frontendDist));
  app.get('*', (req, res) => {
    res.sendFile(path.join(frontendDist, 'index.html'));
  });
}

// 全局错误处理 - 防止未捕获的 async 错误导致进程崩溃
process.on('uncaughtException', (err) => {
  logger.error('[FATAL] Uncaught Exception:', err);
  // 生产环境不退出，记录错误后继续运行
  if (!isProduction()) {
    process.exit(1);
  }
});

process.on('unhandledRejection', (reason, promise) => {
  logger.error('[FATAL] Unhandled Rejection at:', promise, 'reason:', reason?.message || reason);
});

// 启动文件清理任务
startCleanupSchedule();

// 启动
app.listen(PORT, '0.0.0.0', async () => {
  logger.info(`🚀 Orange后端启动成功`);
  logger.info(`   环境: ${process.env.NODE_ENV || 'development'}`);
  logger.info(`   地址: http://0.0.0.0:${PORT}`);
  logger.info(`   API: http://0.0.0.0:${PORT}/api`);
  logger.info(`   下载目录: ${DOWNLOAD_DIR}`);

  // 数据库健康检查（商业化运维）
  const userDb = require('./userDb');
  await validateDatabase(userDb);

  // 注册 Telegram Bot Webhook
  const baseUrl = process.env.API_URL || process.env.APP_URL || `http://localhost:${PORT}`;
  const { setupWebhook } = require('./services/telegramBot');
  setupWebhook(baseUrl).catch(e => logger.error('[Bot] Webhook setup error:', e.message));
});

module.exports = app;

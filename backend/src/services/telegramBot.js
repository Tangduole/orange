/**
 * Telegram Bot 服务
 *
 * 转发链接 → 自动下载 → 发回视频
 * 复用现有平台下载函数 (parseDouyin, parseXiaohongshu, parseBilibili 等)
 */

const axios = require('axios');
const path = require('path');
const fs = require('fs');
const logger = require('../utils/logger');
const { detectPlatform } = require('../utils/media');

// Bot 配置
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
const BOT_WEBHOOK_PATH = '/api/bot/telegram';
const TELEGRAM_API = 'https://api.telegram.org';

// 下载并发限制 (每个用户同时只能下载1个)
const userLocks = new Map();

/**
 * 调用 Telegram API
 */
async function tgApi(method, params = {}, fileField = null) {
  const url = `${TELEGRAM_API}/bot${BOT_TOKEN}/${method}`;
  try {
    if (fileField) {
      const FormData = require('form-data');
      const form = new FormData();
      for (const [k, v] of Object.entries(params)) form.append(k, v);
      form.append(fileField.field, fileField.data, fileField.filename);
      const res = await axios.post(url, form, { headers: form.getHeaders(), timeout: 180000 });
      return res.data;
    }
    const res = await axios.post(url, params, { timeout: 30000 });
    return res.data;
  } catch (e) {
    logger.error(`[Bot] Telegram API error (${method}): ${e.message}`);
    return { ok: false };
  }
}

/**
 * 发送文本消息
 */
async function sendMessage(chatId, text, replyTo = null) {
  return tgApi('sendMessage', {
    chat_id: chatId,
    text,
    reply_to_message_id: replyTo,
    parse_mode: 'HTML',
  });
}

/**
 * 发送视频文件
 */
async function sendVideo(chatId, filePath, caption = '', replyTo = null) {
  const stat = fs.statSync(filePath);
  const sizeMB = stat.size / 1024 / 1024;
  
  if (sizeMB > 50) {
    // 超过 50MB 限制，发文件链接
    return sendMessage(chatId, `⚠️ 文件过大 (${sizeMB.toFixed(1)}MB)，无法直接发送。\n请使用网页版下载：https://orangedl.com`, replyTo);
  }

  const buffer = fs.readFileSync(filePath);
  return tgApi('sendVideo', {
    chat_id: chatId,
    caption,
    reply_to_message_id: replyTo,
  }, {
    field: 'video',
    data: buffer,
    filename: path.basename(filePath),
  });
}

/**
 * 发送图片
 */
async function sendPhoto(chatId, filePath, caption = '', replyTo = null) {
  const buffer = fs.readFileSync(filePath);
  return tgApi('sendPhoto', {
    chat_id: chatId,
    caption,
    reply_to_message_id: replyTo,
  }, {
    field: 'photo',
    data: buffer,
    filename: path.basename(filePath),
  });
}

/**
 * 提取消息中的 URL
 */
function extractUrls(text) {
  const pattern = /https?:\/\/[^\s]+/g;
  return text.match(pattern) || [];
}

/**
 * 处理单条消息
 */
async function handleMessage(msg) {
  const chatId = msg.chat?.id;
  const messageId = msg.message_id;
  const text = msg.text || msg.caption || '';
  
  if (!chatId || !text) return;
  
  // 检查并发锁
  if (userLocks.get(chatId)) {
    await sendMessage(chatId, '⏳ 上一个任务还在处理中，请稍候...', messageId);
    return;
  }

  // /start 命令 - 欢迎消息
  if (text.startsWith('/start')) {
    const welcome = `👋 欢迎使用 Orange 下载助手！

📥 使用方法：直接发送视频链接给我，我会自动下载并发回给你。

🎬 支持的平台：
• 抖音 / TikTok
• 小红书
• YouTube
• Bilibili (B站)
• Instagram
• X / Twitter

💡 访问网页版：https://orangedl.com`;
    await sendMessage(chatId, welcome, messageId);
    return;
  }

  const urls = extractUrls(text);
  if (urls.length === 0) {
    return;
  }

  userLocks.set(chatId, true);
  
  try {
    // 发确认消息
    await sendMessage(chatId, '🔍 正在解析链接...', messageId);

    for (const url of urls) {
      const platform = detectPlatform(url);
      if (!platform) {
        await sendMessage(chatId, `❌ 不支持的链接：${url.substring(0, 60)}...`);
        continue;
      }

      // 生成任务 ID
      const { v4: uuidv4 } = require('uuid');
      const taskId = uuidv4();
      const DOWNLOAD_DIR = path.join(__dirname, '../../downloads');

      logger.info(`[Bot] ${chatId} → ${platform}: ${url.substring(0, 80)}`);

      // 分发到对应下载器
      let result;
      try {
        result = await downloadForPlatform(url, taskId, platform, chatId, messageId);
      } catch (e) {
        logger.error(`[Bot] Download failed: ${e.message}`);
        await sendMessage(chatId, `❌ 下载失败：${e.message}`);
        continue;
      }

      if (!result?.filePath) {
        await sendMessage(chatId, '❌ 未能获取到文件');
        continue;
      }

      // 发送结果
      const caption = `${result.title || ''}\n🎬 ${result.quality || ''} | ${(fs.statSync(result.filePath).size / 1024 / 1024).toFixed(1)}MB`;
      
      if (result.isNote && result.imageFiles?.length > 0) {
        // 图文笔记：发图片
        await sendMessage(chatId, `📸 ${result.title} (${result.imageFiles.length}张)`, messageId);
        for (let i = 0; i < Math.min(result.imageFiles.length, 5); i++) {
          await sendPhoto(chatId, result.imageFiles[i].path, `${i + 1}/${result.imageFiles.length}`, messageId);
          await new Promise(r => setTimeout(r, 500));
        }
      } else {
        // 视频
        await sendVideo(chatId, result.filePath, caption, messageId);
      }

      // 清理文件
      setTimeout(() => {
        try { if (result.filePath) fs.unlinkSync(result.filePath); } catch {}
        if (result.imageFiles) {
          for (const img of result.imageFiles) {
            try { fs.unlinkSync(img.path); } catch {}
          }
        }
      }, 60000);
    }
  } catch (e) {
    logger.error(`[Bot] Handle message error: ${e.message}`);
    await sendMessage(chatId, '❌ 处理失败，请稍后重试');
  } finally {
    userLocks.delete(chatId);
  }
}

/**
 * 按平台分发下载
 */
async function downloadForPlatform(url, taskId, platform, chatId, messageId) {
  const { downloadDouyin } = require('../services/douyin');
  const { 
    parseXiaohongshu, 
    parseYouTube, 
    parseBilibili, 
    parseInstagram,
    downloadFile 
  } = require('../services/tikhub');

  const onProgress = async (percent, label) => {
    // 只在关键节点更新（10%, 50%, 90%）
    if (percent === 10 || percent === 50 || percent === 90) {
      try {
        await tgApi('editMessageText', {
          chat_id: chatId,
          message_id: messageId,
          text: `⏳ ${label || '下载中'}... ${percent}%`,
        });
        // messageId 会变，但不影响主流程
      } catch {}
    }
  };

  if (platform === 'douyin' || platform === 'tiktok') {
    return downloadDouyin(url, taskId, onProgress, { quality: '1080p' });
  }
  if (platform === 'xiaohongshu') {
    return parseXiaohongshu(url, taskId, onProgress);
  }
  if (platform === 'youtube') {
    return parseYouTube(url, taskId, onProgress);
  }
  if (platform === 'bilibili') {
    return parseBilibili(url, taskId, onProgress);
  }
  if (platform === 'instagram') {
    return parseInstagram(url, taskId, onProgress);
  }
  // Twitter/X
  if (platform === 'x') {
    const { downloadViaCobalt, isCobaltConfigured } = require('../services/cobalt');
    if (isCobaltConfigured()) {
      return downloadViaCobalt(url, taskId, onProgress);
    }
  }

  throw new Error(`暂不支持 ${platform} 平台`);
}

/**
 * 注册 Webhook
 */
async function setupWebhook(baseUrl) {
  if (!BOT_TOKEN) {
    logger.warn('[Bot] TELEGRAM_BOT_TOKEN not configured, bot disabled');
    return false;
  }
  
  const webhookUrl = `${baseUrl}${BOT_WEBHOOK_PATH}`;
  try {
    const res = await tgApi('setWebhook', { url: webhookUrl });
    logger.info(`[Bot] Webhook set to ${webhookUrl}: ${JSON.stringify(res)}`);
    return res.ok;
  } catch (e) {
    logger.error(`[Bot] Webhook setup failed: ${e.message}`);
    return false;
  }
}

/**
 * 处理 Webhook 回调
 */
async function handleWebhook(body) {
  if (!BOT_TOKEN) return { ok: false, error: 'Bot not configured' };

  const message = body?.message || body?.edited_message;
  if (!message) return { ok: true };

  // 异步处理（不阻塞 webhook 响应）
  handleMessage(message).catch(e => logger.error(`[Bot] Async error: ${e.message}`));
  
  return { ok: true };
}

module.exports = { handleWebhook, setupWebhook };

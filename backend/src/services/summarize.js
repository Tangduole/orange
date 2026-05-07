/**
 * AI 摘要服务
 *
 * 使用 Cloudflare Workers AI (Llama 3 8B) 对视频字幕进行摘要。
 * ASR → 转录文字 → LLM 摘要 → 返回简洁摘要
 */

const axios = require('axios');
const logger = require('../utils/logger');

const CONFIG = {
  accountId: process.env.CLOUDFLARE_ACCOUNT_ID || '',
  token: process.env.CLOUDFLARE_API_KEY || '',
  email: process.env.CLOUDFLARE_EMAIL || '',
};

/**
 * 调用 Cloudflare Workers AI 进行文本摘要
 * 使用 @cf/meta/llama-3-8b-instruct (免费额度)
 */
async function summarizeText(transcript, language = 'zh') {
  if (!CONFIG.accountId || !CONFIG.token) {
    logger.warn('[summarize] Cloudflare AI not configured, skipping');
    return null;
  }
  if (!transcript || transcript.trim().length < 50) {
    logger.info('[summarize] Transcript too short, skipping');
    return null;
  }

  // 根据语言选择提示词语言
  const isZh = language.startsWith('zh') || language.startsWith('ja') || language.startsWith('ko');
  const systemPrompt = isZh
    ? '你是一个视频内容摘要助手。请用简洁的中文总结以下视频字幕，突出核心主题和关键信息。控制在2-4句话以内，避免重复原文。'
    : 'You are a video content summarizer. Summarize the following video transcript concisely, highlighting the core topic and key points. Keep it to 2-4 sentences. Do not repeat the original text verbatim.';

  const prompt = `${systemPrompt}\n\n字幕内容/Transcript:\n${transcript.substring(0, 4000)}`;

  try {
    logger.info(`[summarize] Requesting Cloudflare AI summary (${transcript.length} chars)`);

    const response = await axios.post(
      `https://api.cloudflare.com/client/v4/accounts/${CONFIG.accountId}/ai/run/@cf/meta/llama-3-8b-instruct`,
      {
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: prompt },
        ],
        max_tokens: 300,
        temperature: 0.3,
      },
      {
        headers: {
          'X-Auth-Email': CONFIG.email,
          'X-Auth-Key': CONFIG.token,
          'Content-Type': 'application/json',
        },
        timeout: 30000,
      }
    );

    const summary = response.data?.result?.response?.trim() || '';
    if (summary) {
      logger.info(`[summarize] Summary generated: ${summary.substring(0, 80)}...`);
    }
    return summary || null;
  } catch (e) {
    logger.error('[summarize] Cloudflare AI failed:', e.message);
    return null;
  }
}

module.exports = { summarizeText };

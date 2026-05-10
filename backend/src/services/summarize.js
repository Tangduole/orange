/**
 * AI 摘要服务
 *
 * 使用 Cloudflare Workers AI (Llama 3 8B) 对视频字幕进行摘要。
 * ASR → 转录文字 → LLM 同音纠错 → LLM 摘要 → 返回简洁摘要
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

  const prompt = systemPrompt + '\n\n字幕内容/Transcript:\n' + transcript.substring(0, 4000);

  try {
    logger.info('[summarize] Requesting Cloudflare AI summary (' + transcript.length + ' chars)');

    const response = await axios.post(
      'https://api.cloudflare.com/client/v4/accounts/' + CONFIG.accountId + '/ai/run/@cf/meta/llama-3-8b-instruct',
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
      logger.info('[summarize] Summary generated: ' + summary.substring(0, 80) + '...');
    }
    return summary || null;
  } catch (e) {
    logger.error('[summarize] Cloudflare AI failed:', e.message);
    return null;
  }
}

/**
 * ASR 同音错别字纠正
 * 使用 Cloudflare Workers AI (Llama 3 8B) 纠正中文语音识别中的同音错误
 * 纠错失败不影响主流程，返回原文
 */
async function correctAsrText(text, language = 'zh') {
  if (!CONFIG.accountId || !CONFIG.token) {
    logger.info('[asr-correct] Cloudflare AI not configured, skipping');
    return text;
  }
  if (!text || text.trim().length < 10) {
    return text;
  }

  const isZh = language.startsWith('zh');

  const systemPrompt = isZh
    ? '你是一个中文语音识别纠错助手。请纠正以下语音转文字结果中的同音错别字（如：在/再、的/得/地、它/他/她、做/作、那/哪 等）。只纠正明显的错别字，保持原意和句式不变。直接返回纠正后的文本，不要加任何解释。'
    : 'You are a speech-to-text correction assistant. Fix any homophone or spelling errors in the transcript while preserving the original meaning and style. Return only the corrected text without explanation.';

  const prompt = systemPrompt + '\n\n' + text.substring(0, 4000);

  try {
    logger.info('[asr-correct] Correcting homophone errors...');

    const response = await axios.post(
      'https://api.cloudflare.com/client/v4/accounts/' + CONFIG.accountId + '/ai/run/@cf/meta/llama-3-8b-instruct',
      {
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: prompt },
        ],
        max_tokens: Math.min(text.length * 2, 4096),
        temperature: 0.1,
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

    const corrected = response.data?.result?.response?.trim() || '';
    if (corrected && corrected.length >= text.length * 0.5) {
      logger.info('[asr-correct] Corrected successfully');
      return corrected;
    }
    logger.warn('[asr-correct] Correction result too short, using original');
    return text;
  } catch (e) {
    logger.warn('[asr-correct] Cloudflare AI failed:', e.message);
    return text; // 纠错失败不影响主流程
  }
}

module.exports = { summarizeText, correctAsrText };

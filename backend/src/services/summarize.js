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
async function correctAsrText(text, language = 'zh', context = '') {
  if (!CONFIG.accountId || !CONFIG.token) {
    logger.info('[asr-correct] Cloudflare AI not configured, skipping');
    return text;
  }
  if (!text || text.trim().length < 10) {
    return text;
  }

  const isZh = language.startsWith('zh');

  const systemPrompt = isZh
    ? `你是中文语音识别纠错专家。请逐句检查并纠正错误。
核心原则：
1. 组合合理性检查：两个词组合在一起是否合理？（如"慈禧积木"不合理→应为"磁吸积木"）
2. 语义连贯性：整句话的意思是否通顺？
3. 常识判断：是否符合日常生活常识？
4. 上下文推理：根据视频标题和前后文判断最可能的正确词汇
5. 常见同音纠正：在/再、的/得/地、做/作、象/像、那/哪、他/她/它
6. 只返回纠正后的全文，不加解释`
    : 'You are a speech-to-text correction assistant. Fix homophone and context errors in the transcript. Use context to determine the most likely correct word. Preserve original meaning and style. Return only corrected text.';

  let prompt = text.substring(0, 4000);
  if (context) {
    prompt = `视频标题：${context}\n\n${prompt}`;
  }
  prompt = systemPrompt + '\n\n' + prompt;

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

/**
 * AI 翻译润色（使用 Llama 3 8B 免费）
 * M2M-100 粗译 → Llama 3 润色为自然表达
 */
async function polishTranslation(rawTranslation, targetLang) {
  if (!CONFIG.accountId || !CONFIG.token) return rawTranslation;
  if (!rawTranslation || rawTranslation.length < 10) return rawTranslation;

  const langNames = { zh: 'Chinese', en: 'English', ja: 'Japanese', ko: 'Korean' };
  const langName = langNames[targetLang] || targetLang;

  const prompt = `Polish this machine translation to sound natural in ${langName}. Fix grammar, word choice, and flow. Keep the same meaning. Do NOT add or remove information. Return ONLY the polished text, no explanations.\n\nRaw translation:\n${rawTranslation}`;

  try {
    const axios = require('axios');
    const response = await axios.post(
      'https://api.cloudflare.com/client/v4/accounts/' + CONFIG.accountId + '/ai/run/@cf/meta/llama-3-8b-instruct',
      {
        messages: [
          { role: 'system', content: 'You are a professional translator. Output polished translation only.' },
          { role: 'user', content: prompt },
        ],
        max_tokens: rawTranslation.length * 2,
        temperature: 0.2,
      },
      {
        headers: {
          'X-Auth-Email': CONFIG.email,
          'X-Auth-Key': CONFIG.token,
          'Content-Type': 'application/json'
        },
        timeout: 30000
      }
    );
    const polished = response.data.result?.response?.trim() || rawTranslation;
    logger.info(`[polish] Translation polished (${rawTranslation.length} → ${polished.length} chars)`);
    return polished;
  } catch (e) {
    logger.warn('[polish] Failed:', e.message);
    return rawTranslation;
  }
}

module.exports = { summarizeText, correctAsrText, polishTranslation, correctWithDeepSeek, translateWithDeepSeek };

/**
 * DeepSeek 翻译（替代 M2M-100，支持长文本，质量更好）
 */
async function translateWithDeepSeek(text, sourceLang, targetLang) {
  const deepseekKey = process.env.AI_API_KEY || '';
  const deepseekUrl = (process.env.AI_API_URL || 'https://api.deepseek.com/v1').replace(/\/+$/, '');
  if (!deepseekKey || !text) return null;
  
  const langNames = { zh: 'Chinese', en: 'English', ja: 'Japanese', ko: 'Korean' };
  const src = langNames[sourceLang] || sourceLang;
  const tgt = langNames[targetLang] || targetLang;
  
  try {
    const axios = require('axios');
    const res = await axios.post(`${deepseekUrl}/chat/completions`, {
      model: 'deepseek-chat',
      messages: [
        { role: 'system', content: `Translate from ${src} to ${tgt}. Keep the style natural. Return only the translation.` },
        { role: 'user', content: text }
      ],
      temperature: 0.1,
      max_tokens: text.length * 2
    }, {
      headers: { 'Authorization': `Bearer ${deepseekKey}`, 'Content-Type': 'application/json' },
      timeout: 60000
    });
    const translated = res.data?.choices?.[0]?.message?.content?.trim();
    if (translated && translated !== text) {
      logger.info(`[deepseek-translate] ${sourceLang}→${targetLang}, ${text.length}→${translated.length} chars`);
      return translated;
    }
    return null;
  } catch (e) {
    logger.warn('[deepseek-translate] Failed:', e.message);
    return null;
  }
}

/**
 * DeepSeek 中文纠错（比 Llama 3 8B 强得多，几乎免费）
 * 作为 correctAsrText 的前置增强
 */
async function correctWithDeepSeek(text, language = 'zh', context = '') {
  const deepseekKey = process.env.AI_API_KEY || '';
  const deepseekUrl = (process.env.AI_API_URL || 'https://api.deepseek.com/v1').replace(/\/+$/, '');
  
  console.error(`[deepseek-correct] called: key=${!!deepseekKey}, lang=${language}, textLen=${(text||'').length}`);
  
  if (!deepseekKey || !language.startsWith('zh')) {
    console.error('[deepseek-correct] SKIP: no key or not zh');
    return text;
  }
  
  let prompt = `纠正以下语音识别的同音错别字。逐句检查：词汇组合是否合理？语义是否通顺？符合常识吗？\n\n`;
  if (context) prompt += `视频标题：${context}\n`;
  prompt += `文本：\n${text.substring(0, 3000)}`;
  
  try {
    const axios = require('axios');
    const res = await axios.post(`${deepseekUrl}/chat/completions`, {
      model: 'deepseek-chat',
      messages: [
        { role: 'system', content: '你是中文纠错专家。纠正同音错别字，检查词汇组合合理性。只返回纠正后的全文。' },
        { role: 'user', content: prompt }
      ],
      temperature: 0.1,
      max_tokens: text.length * 2
    }, {
      headers: { 'Authorization': `Bearer ${deepseekKey}`, 'Content-Type': 'application/json' },
      timeout: 30000
    });
    const corrected = res.data?.choices?.[0]?.message?.content?.trim() || text;
    if (corrected !== text) logger.info('[deepseek-correct] Fixed homophone errors');
    return corrected;
  } catch (e) {
    logger.warn('[deepseek-correct] Failed, falling back:', e.message);
    return text;
  }
}

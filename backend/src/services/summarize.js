/**
 * AI 摘要服务
 *
 * 使用 Cloudflare Workers AI (Llama 3 8B) 对视频字幕进行摘要。
 * ASR → 转录文字 → LLM 同音纠错 → LLM 摘要 → 返回简洁摘要
 */

const axios = require('axios');
const logger = require('../utils/logger');
const { applyHomophoneCorrections, buildCorrectionHints } = require('../utils/asrCorrectionRules');

// 主动加载 .env（确保 AI_API_KEY 等可用）
(function loadEnv() {
  const fs = require('fs');
  const path = require('path');
  for (const p of [path.join(__dirname, '../../.env'), path.join(__dirname, '../../../.env')]) {
    if (fs.existsSync(p)) {
      try { require('dotenv').config({ path: p }); break; } catch {}
    }
  }
})();

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
  const ruleCorrected = applyHomophoneCorrections(text, context);
  if (!CONFIG.accountId || !CONFIG.token) {
    logger.info('[asr-correct] Cloudflare AI not configured, skipping');
    return ruleCorrected;
  }
  if (!text || text.trim().length < 10) {
    return text;
  }

  const isZh = language.startsWith('zh');

  const hints = buildCorrectionHints(context, language);
  const systemPrompt = isZh
    ? `你是中文语音识别纠错专家。逐句检查并纠正同音错别字，只修正明显 ASR 错误，不总结、不改写、不扩写。${hints} 只返回纠正后全文。`
    : 'You are a speech-to-text correction assistant. Fix homophone and context errors in the transcript. Use context to determine the most likely correct word. Preserve original meaning and style. Return only corrected text.';

  let prompt = ruleCorrected.substring(0, 4000);
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
        max_tokens: Math.min(ruleCorrected.length * 2, 4096),
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
    if (corrected && corrected.length >= ruleCorrected.length * 0.5) {
      logger.info('[asr-correct] Corrected successfully');
      return applyHomophoneCorrections(corrected, context);
    }
    logger.warn('[asr-correct] Correction result too short, using original');
    return ruleCorrected;
  } catch (e) {
    logger.warn('[asr-correct] Cloudflare AI failed:', e.message);
    return ruleCorrected; // 纠错失败不影响主流程
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

module.exports = { summarizeText, correctAsrText, polishTranslation, correctWithDeepSeek, translateWithDeepSeek, translateSubtitleSegments, videoSummary };

/**
 * AI 视频内容总结（DeepSeek，VIP 专属）
 * 输入：ASR 文字 + 视频标题
 * 输出：摘要 + 标签 + 推荐平台 + 推荐标题
 */
async function videoSummary(transcript, title = '', language = 'zh') {
  const deepseekKey = process.env.AI_API_KEY || '';
  if (!deepseekKey) return null;
  
  const isZh = language.startsWith('zh');
  const prompt = isZh
    ? `你是视频内容分析师。根据以下视频字幕和标题，输出一个 JSON：
{
  "summary": "2-3句话概括核心内容",
  "tags": ["标签1", "标签2", "标签3", "标签4", "标签5"],
  "platforms": ["适合发布的平台"],
  "titles": ["推荐标题1", "推荐标题2", "推荐标题3"]
}
只输出 JSON，不要加任何解释。
标题：${title || '无'}
字幕：${transcript.substring(0, 3000)}`
    : `You are a video content analyst. Based on the transcript and title below, output a JSON:
{
  "summary": "2-3 sentence core summary",
  "tags": ["tag1", "tag2", "tag3", "tag4", "tag5"],
  "platforms": ["suitable platforms"],
  "titles": ["suggested title 1", "suggested title 2", "suggested title 3"]
}
Output ONLY valid JSON, no explanation.
Title: ${title || 'None'}
Transcript: ${transcript.substring(0, 3000)}`;

  try {
    const axios = require('axios');
    const url = (process.env.AI_API_URL || 'https://api.deepseek.com/v1').replace(/\/+$/, '');
    const res = await axios.post(`${url}/chat/completions`, {
      model: 'deepseek-chat',
      messages: [
        { role: 'system', content: 'You are a video content analyst. Output valid JSON only.' },
        { role: 'user', content: prompt }
      ],
      temperature: 0.3,
      max_tokens: 800,
      response_format: { type: 'json_object' }
    }, {
      headers: { 'Authorization': `Bearer ${deepseekKey}`, 'Content-Type': 'application/json' },
      timeout: 30000
    });
    
    const content = res.data?.choices?.[0]?.message?.content?.trim();
    if (!content) return null;
    
    const parsed = JSON.parse(content);
    logger.info(`[video-summary] Generated summary for "${(title||'').substring(0,30)}"`);
    return parsed;
  } catch (e) {
    logger.warn('[video-summary] Failed:', e.message);
    return null;
  }
}

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

async function translateSubtitleSegments(segments, sourceLang, targetLang, context = '') {
  const deepseekKey = process.env.AI_API_KEY || '';
  const deepseekUrl = (process.env.AI_API_URL || 'https://api.deepseek.com/v1').replace(/\/+$/, '');
  if (!deepseekKey || !Array.isArray(segments) || segments.length === 0) return null;

  const normalized = segments
    .map((segment, index) => ({
      index,
      text: String(segment.text || '').trim()
    }))
    .filter(item => item.text);
  if (normalized.length === 0) return null;

  const results = new Array(segments.length).fill('');
  const batchSize = 20;
  const langNames = { zh: 'Chinese', en: 'English', ja: 'Japanese', ko: 'Korean', auto: 'auto-detected language' };
  const src = langNames[sourceLang] || sourceLang;
  const tgt = langNames[targetLang] || targetLang;

  for (let i = 0; i < normalized.length; i += batchSize) {
    const batch = normalized.slice(i, i + batchSize);
    const prompt = `Translate each subtitle segment from ${src} to ${tgt}.
Keep each output short enough for one subtitle cue.
Preserve the array length and item order.
Return ONLY JSON in this exact format: {"items":["translation 1","translation 2"]}.
${context ? `Context: ${context}\n` : ''}
Segments:
${JSON.stringify(batch.map(item => item.text))}`;

    try {
      const res = await axios.post(`${deepseekUrl}/chat/completions`, {
        model: process.env.AI_MODEL || 'deepseek-chat',
        messages: [
          { role: 'system', content: 'You are a subtitle translator. Return valid JSON only.' },
          { role: 'user', content: prompt }
        ],
        temperature: 0.1,
        max_tokens: Math.min(4096, Math.max(800, batch.reduce((sum, item) => sum + item.text.length, 0) * 3)),
        response_format: { type: 'json_object' }
      }, {
        headers: { 'Authorization': `Bearer ${deepseekKey}`, 'Content-Type': 'application/json' },
        timeout: 60000
      });

      const content = res.data?.choices?.[0]?.message?.content?.trim();
      const parsed = content ? JSON.parse(content) : null;
      const items = Array.isArray(parsed?.items) ? parsed.items : [];
      if (items.length !== batch.length) return null;
      batch.forEach((item, idx) => {
        results[item.index] = String(items[idx] || '').trim();
      });
    } catch (e) {
      logger.warn('[deepseek-subtitle-translate] Failed:', e.message);
      return null;
    }
  }

  return results;
}

/**
 * DeepSeek 中文纠错（比 Llama 3 8B 强得多，几乎免费）
 * 作为 correctAsrText 的前置增强
 */
async function correctWithDeepSeek(text, language = 'zh', context = '') {
  const deepseekKey = process.env.AI_API_KEY || '';
  const deepseekUrl = (process.env.AI_API_URL || 'https://api.deepseek.com/v1').replace(/\/+$/, '');
  const ruleCorrected = applyHomophoneCorrections(text, context);

  if (!deepseekKey || !language.startsWith('zh')) {
    logger.info('[deepseek-correct] skipped: no key or not zh');
    return ruleCorrected;
  }

  try {
    const chunks = splitTextForCorrection(ruleCorrected, 1800);
    const correctedChunks = [];
    logger.info(`[deepseek-correct] correcting ${chunks.length} chunk(s), textLen=${ruleCorrected.length}`);

    for (let i = 0; i < chunks.length; i++) {
      const previous = correctedChunks.length ? correctedChunks[correctedChunks.length - 1].slice(-160) : '';
      const next = chunks[i + 1] ? chunks[i + 1].slice(0, 160) : '';
      const correctedChunk = await correctChunkWithDeepSeek({
        chunk: chunks[i],
        previous,
        next,
        context,
        language,
        deepseekKey,
        deepseekUrl
      });
      correctedChunks.push(correctedChunk);
    }

    const corrected = applyHomophoneCorrections(correctedChunks.join('\n'), context);
    if (corrected !== text) logger.info('[deepseek-correct] Fixed homophone errors');
    return corrected;
  } catch (e) {
    logger.warn('[deepseek-correct] Failed, falling back:', e.message);
    return ruleCorrected;
  }
}

function splitTextForCorrection(text, maxLen = 1800) {
  const normalized = String(text || '').trim();
  if (normalized.length <= maxLen) return [normalized];

  const parts = normalized.split(/(?<=[。！？!?；;\n])/);
  const chunks = [];
  let current = '';
  for (const part of parts) {
    if (!part) continue;
    if ((current + part).length > maxLen && current) {
      chunks.push(current.trim());
      current = part;
    } else {
      current += part;
    }
  }
  if (current.trim()) chunks.push(current.trim());

  const finalChunks = [];
  for (const chunk of chunks) {
    if (chunk.length <= maxLen * 1.2) {
      finalChunks.push(chunk);
      continue;
    }
    for (let i = 0; i < chunk.length; i += maxLen) {
      finalChunks.push(chunk.slice(i, i + maxLen));
    }
  }
  return finalChunks;
}

async function correctChunkWithDeepSeek({ chunk, previous, next, context, language, deepseekKey, deepseekUrl }) {
  const hints = buildCorrectionHints(context, language);
  let prompt = `${hints}

请纠正下面这段 ASR 文本中的同音错别字。要求：
1. 只修正明显错别字，不总结、不改写、不扩写。
2. 保留原句顺序、标点风格和换行。
3. 只返回纠正后的“当前段落”，不要返回前后文。
`;
  if (context) prompt += `\n视频标题/上下文：${context}`;
  if (previous) prompt += `\n前文参考：${previous}`;
  if (next) prompt += `\n后文参考：${next}`;
  prompt += `\n\n当前段落：\n${chunk}`;

  const res = await axios.post(`${deepseekUrl}/chat/completions`, {
    model: process.env.AI_MODEL || 'deepseek-chat',
    messages: [
      { role: 'system', content: '你是中文 ASR 纠错专家。只纠正同音错别字和明显不合理词组，输出纠正后的当前段落。' },
      { role: 'user', content: prompt }
    ],
    temperature: 0,
    max_tokens: Math.min(Math.max(chunk.length * 2, 800), 4096)
  }, {
    headers: { 'Authorization': `Bearer ${deepseekKey}`, 'Content-Type': 'application/json' },
    timeout: 45000
  });

  const corrected = res.data?.choices?.[0]?.message?.content?.trim();
  if (!corrected || corrected.length < chunk.length * 0.45) {
    logger.warn('[deepseek-correct] chunk result invalid, using rule-corrected chunk');
    return chunk;
  }
  return applyHomophoneCorrections(corrected, context);
}

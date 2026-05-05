/**
 * ASR 语音转文字服务
 * 支持多种模式：
 * 1. openai - OpenAI Whisper API (需要 OPENAI_API_KEY)
 * 2. cloudflare - Cloudflare Workers AI (需要 CLOUDFLARE_ACCOUNT_ID + CLOUDFLARE_AI_TOKEN)
 * 3. local - 本地 faster-whisper (需要 Python 环境，默认使用 tiny 模型)
 */

const fs = require('fs');
const path = require('path');
const logger = require('../utils/logger');
const { spawn } = require('child_process');
const FormData = require('form-data');

// 配置
const CONFIG = {
  mode: process.env.ASR_MODE || 'cloudflare', // openai | cloudflare | local
  modelSize: process.env.WHISPER_MODEL || 'tiny',
  language: process.env.ASR_LANGUAGE || 'zh',
  openaiKey: process.env.OPENAI_API_KEY || '',
  cloudflareAccountId: process.env.CLOUDFLARE_ACCOUNT_ID || '',
  cloudflareToken: process.env.CLOUDFLARE_API_KEY || '',
  cloudflareEmail: process.env.CLOUDFLARE_EMAIL || ''
};

/**
 * 使用 OpenAI Whisper API 转文字
 */
async function transcribeOpenAI(audioPath, language = 'zh') {
  const axios = require('axios');
  
  if (!CONFIG.openaiKey) {
    throw new Error('OpenAI API key not configured. Set OPENAI_API_KEY environment variable.');
  }
  
  const form = new FormData();
  form.append('file', fs.createReadStream(audioPath));
  form.append('model', 'whisper-1');
  form.append('language', language === 'auto' ? null : language);
  form.append('response_format', 'text');
  
  logger.info(`[ASR] Using OpenAI Whisper API, language: ${language}`);
  
  const response = await axios.post('https://api.openai.com/v1/audio/transcriptions', form, {
    headers: {
      ...form.getHeaders(),
      'Authorization': `Bearer ${CONFIG.openaiKey}`
    },
    maxBodyLength: Infinity,
    timeout: 60000
  });
  
  return response.data;
}

/**
 * 使用 Cloudflare Workers AI 转文字
 */
async function transcribeCloudflare(audioPath, language = 'zh') {
  const axios = require('axios');
  
  if (!CONFIG.cloudflareAccountId || !CONFIG.cloudflareToken) {
    throw new Error('Cloudflare AI credentials not configured.');
  }
  
  // 读取音频文件并转 base64
  const audioBuffer = fs.readFileSync(audioPath);
  const base64Audio = audioBuffer.toString('base64');
  
  logger.info(`[ASR] Using Cloudflare Workers AI (whisper-large-v3-turbo), language: ${language}`);
  
  const response = await axios.post(
    `https://api.cloudflare.com/client/v4/accounts/${CONFIG.cloudflareAccountId}/ai/run/@cf/openai/whisper-large-v3-turbo`,
    { audio: base64Audio },
    {
      headers: {
        'X-Auth-Email': CONFIG.cloudflareEmail,
        'X-Auth-Key': CONFIG.cloudflareToken,
        'Content-Type': 'application/json'
      },
      timeout: 120000
    }
  );
  
  const text = response.data.result?.text || '';
  
  // 按句号分段落
  if (text) {
    const sentences = text.split(/[。！？.!?]+/).filter(s => s.trim());
    return sentences.map(s => s.trim()).join('\n\n');
  }
  return text;
}

/**
 * Cloudflare M2M-100 翻译
 */
async function translateText(text, sourceLang, targetLang) {
  if (!text || sourceLang === targetLang) return text;
  const axios = require('axios');
  
  try {
    const response = await axios.post(
      `https://api.cloudflare.com/client/v4/accounts/${CONFIG.cloudflareAccountId}/ai/run/@cf/meta/m2m100-1.2b`,
      { text, source_lang: sourceLang, target_lang: targetLang },
      {
        headers: {
          'X-Auth-Email': CONFIG.cloudflareEmail,
          'X-Auth-Key': CONFIG.cloudflareToken,
          'Content-Type': 'application/json'
        },
        timeout: 30000
      }
    );
    return response.data.result?.translated_text || text;
  } catch (e) {
    logger.error('[ASR] Translation failed:', e.message);
    return text;
  }
}

/**
 * 使用本地 faster-whisper 转文字
 */
function transcribeLocal(audioPath, language = 'zh') {
  return new Promise((resolve, reject) => {
    const scriptPath = path.join(__dirname, '../../scripts/asr-transcribe.py');
    
    if (!fs.existsSync(scriptPath)) {
      reject(new Error('ASR script not found. Please ensure scripts/asr-transcribe.py exists.'));
      return;
    }
    
    const args = [
      scriptPath,
      '--model', CONFIG.modelSize,
      '--language', language,
      '--paragraphs',
      '--min-pause', '1.0',
      audioPath
    ];

    logger.info(`[ASR] Using local faster-whisper, model: ${CONFIG.modelSize}, language: ${language}`);

    const proc = spawn('python3', args, {
      stdio: ['ignore', 'pipe', 'pipe']
    });

    let stdout = '';
    let stderr = '';

    proc.stdout.on('data', (data) => { stdout += data.toString(); });
    proc.stderr.on('data', (data) => { stderr += data.toString(); });

    proc.on('close', (code) => {
      if (code !== 0) {
        logger.error(`[ASR] Script error: ${stderr}`);
        reject(new Error(`ASR script failed: ${stderr}`));
        return;
      }

      try {
        const result = JSON.parse(stdout.trim());
        if (result.success) {
          resolve(result.text);
        } else {
          reject(new Error(result.error || 'ASR failed'));
        }
      } catch (e) {
        // 如果不是 JSON，直接返回原始输出
        resolve(stdout.trim());
      }
    });

    proc.on('error', (err) => {
      reject(err);
    });

    // 超时 5 分钟
    setTimeout(() => {
      proc.kill();
      reject(new Error('ASR timeout (5 minutes)'));
    }, 300000);
  });
}

/**
 * 主入口
 */
async function transcribe(audioPath, language = null, targetLang = null) {
  const lang = language || CONFIG.language;
  
  logger.info(`[ASR] Mode: ${CONFIG.mode}, Language: ${lang}, Target: ${targetLang || 'same'}`);
  
  try {
    let text;
    if (CONFIG.mode === 'openai') {
      text = await transcribeOpenAI(audioPath, lang);
    } else if (CONFIG.mode === 'cloudflare') {
      text = await transcribeCloudflare(audioPath, lang);
    } else {
      text = await transcribeLocal(audioPath, lang);
    }
    
    // 翻译（如果指定了目标语言且不同于源语言）
    if (targetLang && targetLang !== lang && CONFIG.mode === 'cloudflare') {
      text = await translateText(text, lang, targetLang);
    }
    
    return text;
  } catch (error) {
    logger.error(`[ASR] Error: ${error.message}`);
    throw error;
  }
}

module.exports = { transcribe, translateText, CONFIG };

/**
 * ASR 语音转文字服务
 * 支持多种模式：
 * 1. openai - OpenAI Whisper API (需要 OPENAI_API_KEY)
 * 2. cloudflare - Cloudflare Workers AI (需要 CLOUDFLARE_ACCOUNT_ID + CLOUDFLARE_AI_TOKEN)
 * 3. local - 本地 faster-whisper (需要 Python 环境，默认使用 tiny 模型)
 */

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const FormData = require('form-data');

// 配置
const CONFIG = {
  mode: process.env.ASR_MODE || 'openai', // openai | cloudflare | local
  modelSize: process.env.WHISPER_MODEL || 'tiny',
  language: process.env.ASR_LANGUAGE || 'zh',
  openaiKey: process.env.OPENAI_API_KEY || '',
  cloudflareAccountId: process.env.CLOUDFLARE_ACCOUNT_ID || '',
  cloudflareToken: process.env.CLOUDFLARE_AI_TOKEN || ''
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
  
  console.log(`[ASR] Using OpenAI Whisper API, language: ${language}`);
  
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
  
  // 读取音频文件
  const audioBuffer = fs.readFileSync(audioPath);
  const base64Audio = audioBuffer.toString('base64');
  
  console.log(`[ASR] Using Cloudflare Workers AI, language: ${language}`);
  
  const response = await axios.post(
    `https://api.cloudflare.com/client/v4/accounts/${CONFIG.cloudflareAccountId}/ai/run/@cf/openai/whisper`,
    {
      audio: base64Audio
    },
    {
      headers: {
        'Authorization': `Bearer ${CONFIG.cloudflareToken}`,
        'Content-Type': 'application/json'
      },
      timeout: 60000
    }
  );
  
  return response.data.result?.text || '';
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

    console.log(`[ASR] Using local faster-whisper, model: ${CONFIG.modelSize}, language: ${language}`);

    const proc = spawn('python3', args, {
      stdio: ['ignore', 'pipe', 'pipe']
    });

    let stdout = '';
    let stderr = '';

    proc.stdout.on('data', (data) => { stdout += data.toString(); });
    proc.stderr.on('data', (data) => { stderr += data.toString(); });

    proc.on('close', (code) => {
      if (code !== 0) {
        console.error(`[ASR] Script error: ${stderr}`);
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
async function transcribe(audioPath, language = null) {
  const lang = language || CONFIG.language;
  
  console.log(`[ASR] Mode: ${CONFIG.mode}, Language: ${lang}`);
  
  try {
    if (CONFIG.mode === 'openai') {
      return await transcribeOpenAI(audioPath, lang);
    } else if (CONFIG.mode === 'cloudflare') {
      return await transcribeCloudflare(audioPath, lang);
    } else {
      return await transcribeLocal(audioPath, lang);
    }
  } catch (error) {
    console.error(`[ASR] Error: ${error.message}`);
    throw error;
  }
}

module.exports = { transcribe, CONFIG };

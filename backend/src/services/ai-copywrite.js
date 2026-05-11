/**
 * AI 文案提取服务
 *
 * 流程：下载视频 → 提取音频 → ASR转文字 → AI分析 → 结构化文案
 */

const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const axios = require('axios');
const logger = require('../utils/logger');

// AI 配置：支持 OpenAI 兼容接口（OpenAI / DeepSeek / 等）
const AI_API_URL = (process.env.AI_API_URL || 'https://api.deepseek.com/v1').replace(/\/+$/, '');
const AI_API_KEY = process.env.AI_API_KEY || '';
const AI_MODEL = process.env.AI_MODEL || 'deepseek-chat';

const DOWNLOAD_DIR = path.join(__dirname, '../../downloads');
const TIMEOUT_FFMPEG = parseInt(process.env.FFMPEG_TIMEOUT_MS || '120000', 10);

/**
 * 提取音频为 mp3
 */
function extractAudio(inputPath, taskId) {
  return new Promise((resolve, reject) => {
    const audioPath = path.join(DOWNLOAD_DIR, `${taskId}_copywrite.mp3`);
    const ff = spawn('ffmpeg', [
      '-i', inputPath,
      '-vn',
      '-acodec', 'libmp3lame',
      '-b:a', '64k',
      '-ar', '16000',
      '-y', audioPath
    ]);
    const timer = setTimeout(() => { ff.kill('SIGKILL'); reject(new Error('ffmpeg timeout')); }, TIMEOUT_FFMPEG);
    ff.on('close', code => { clearTimeout(timer); code === 0 ? resolve(audioPath) : reject(new Error('ffmpeg exit ' + code)); });
    ff.on('error', err => { clearTimeout(timer); reject(err); });
  });
}

/**
 * ASR 转文字（用现有 asr 模块的 transcribe 函数）
 */
async function transcribeAudio(audioPath, language = 'zh') {
  const { transcribe } = require('./asr');
  const text = await transcribe(audioPath, language);
  if (!text) throw new Error('ASR 转录为空');
  return text;
}

/**
 * AI 分析文案
 */
async function analyzeWithAI(transcript) {
  if (!AI_API_KEY) throw new Error('AI_API_KEY 未配置');

  const prompt = `你是一个专业的电商内容分析师。请分析以下视频口播文案，提取结构化信息。

要求：
1. 商品/产品名称（如果有）
2. 核心卖点（3-5 条，每条一句话）
3. 价格信息（如有提及）
4. 目标人群（适合什么用户）
5. 带货口播脚本（整理成可直接使用的带货文案，200字以内）
6. 关键词标签（5-8 个 tag）

请用 JSON 格式返回，不要多余文字：
{
  "productName": "",
  "sellingPoints": ["", ""],
  "priceInfo": "",
  "targetAudience": "",
  "copyScript": "",
  "tags": ["", ""]
}

视频口播文案：
${transcript.substring(0, 4000)}`;

  try {
    const res = await axios.post(`${AI_API_URL}/chat/completions`, {
      model: AI_MODEL,
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.1,
      max_tokens: 2000,
    }, {
      headers: {
        'Authorization': `Bearer ${AI_API_KEY}`,
        'Content-Type': 'application/json',
      },
      timeout: 60000,
    });

    const content = res.data?.choices?.[0]?.message?.content || '';
    // 提取 JSON（AI 有时会在外层包裹 markdown 代码块）
    const jsonMatch = content.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]);
      return {
        productName: parsed.productName || '',
        sellingPoints: parsed.sellingPoints || [],
        priceInfo: parsed.priceInfo || '',
        targetAudience: parsed.targetAudience || '',
        copyScript: parsed.copyScript || '',
        tags: parsed.tags || [],
      };
    }
    throw new Error('AI 返回格式异常');
  } catch (e) {
    if (e.response) {
      logger.error(`[AI] API error: ${e.response.status} ${JSON.stringify(e.response.data).substring(0, 200)}`);
      throw new Error(`AI API error: ${e.response.status}`);
    }
    throw e;
  }
}

/**
 * 主入口：从视频任务提取文案
 * @param {string} taskId
 * @param {string} platform 平台名
 * @returns {Promise<{transcript, analysis}>}
 */
async function extractCopywrite(taskId, platform = '') {
  // 1. 找到视频文件
  const files = fs.readdirSync(DOWNLOAD_DIR).filter(f =>
    f.startsWith(taskId) && (f.endsWith('.mp4') || f.endsWith('.mkv') || f.endsWith('.webm'))
  );
  if (files.length === 0) throw new Error('未找到下载的视频文件');
  const videoPath = path.join(DOWNLOAD_DIR, files[0]);

  // 2. 提取音频
  logger.info(`[AI] Extracting audio from ${files[0]}`);
  const audioPath = await extractAudio(videoPath, taskId);

  // 3. ASR 转文字
  logger.info(`[AI] Transcribing audio...`);
  let transcript = await transcribeAudio(audioPath, 'zh');

  // AI 同音纠错（自动，失败不影响主流程）
  if (transcript && transcript.length >= 10) {
    try {
      const { correctAsrText } = require('./summarize');
      const corrected = await correctAsrText(transcript, 'zh');
      if (corrected && corrected !== transcript) {
        transcript = corrected;
        logger.info('[AI] Transcript corrected (homophone fix)');
      }
    } catch (e) {
      logger.warn('[AI] Transcription correction failed:', e.message);
    }
  }

  // 清理音频文件
  try { fs.unlinkSync(audioPath); } catch {}

  if (transcript.length < 5) throw new Error('转录文字过短，可能没有有效语音内容');

  // 4. AI 分析
  logger.info(`[AI] Analyzing transcript (${transcript.length} chars)...`);
  const analysis = await analyzeWithAI(transcript);

  return { transcript, analysis };
}

module.exports = { extractCopywrite };

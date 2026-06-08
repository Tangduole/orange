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
const isProduction = () => process.env.NODE_ENV === 'production';
const useMockCopywrite = () => process.env.DEV_COPYWRITE_MOCK === '1' && !isProduction();

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
function normalizeOutputLanguage(language = 'zh') {
  const lang = String(language || 'zh').toLowerCase();
  if (lang.startsWith('en')) return 'en';
  if (lang.startsWith('ja')) return 'ja';
  if (lang.startsWith('ko')) return 'ko';
  return 'zh';
}

function buildAnalysisPrompt(transcript, outputLanguage = 'zh') {
  const lang = normalizeOutputLanguage(outputLanguage);
  const languageNames = {
    zh: '简体中文',
    en: 'English',
    ja: '日本語',
    ko: '한국어'
  };
  const localizedInstruction = {
    zh: '请用简体中文输出卖点、目标人群、口播脚本和标签。商品名、品牌名、型号、规格保留原文，不要强行翻译。',
    en: 'Write selling points, target audience, sales script, and tags in English. Preserve product names, brand names, model numbers, and specifications in their original language.',
    ja: 'セールスポイント、ターゲット層、販売スクリプト、タグは日本語で出力してください。商品名、ブランド名、型番、仕様は原文を保持してください。',
    ko: '판매 포인트, 타깃 고객, 판매 스크립트, 태그는 한국어로 작성하세요. 상품명, 브랜드명, 모델명, 사양은 원문을 유지하세요.'
  };

  return `You are a professional e-commerce content analyst. Analyze the following video transcript and extract structured product marketing material.

Output language: ${languageNames[lang]}.
${localizedInstruction[lang]}

Requirements:
1. Product name, if mentioned.
2. Core selling points, 3-5 short items.
3. Price or promotion information, if mentioned.
4. Target audience.
5. A ready-to-use e-commerce sales script, within 200 ${lang === 'en' ? 'words' : 'characters'}.
6. Keyword tags, 5-8 items.

Return JSON only, without markdown or extra text:
{
  "productName": "",
  "sellingPoints": ["", ""],
  "priceInfo": "",
  "targetAudience": "",
  "copyScript": "",
  "tags": ["", ""]
}

Video transcript:
${transcript.substring(0, 4000)}`;
}

async function analyzeWithAI(transcript, outputLanguage = 'zh') {
  if (!AI_API_KEY) {
    if (useMockCopywrite()) return buildMockAnalysis(transcript, outputLanguage);
    throw new Error('AI_API_KEY 未配置');
  }

  const prompt = buildAnalysisPrompt(transcript, outputLanguage);

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

function buildMockAnalysis(transcript, outputLanguage = 'zh') {
  const lang = normalizeOutputLanguage(outputLanguage);
  const sample = transcript.replace(/\s+/g, ' ').trim().slice(0, 120);
  const localized = {
    zh: {
      productName: '本地测试素材',
      points: ['这是开发环境生成的模拟 AI 分析结果', '用于验证前端展示、素材库标签和使用量记录', '生产环境必须配置 AI_API_KEY 才会调用真实模型'],
      audience: '本地测试用户',
      script: sample ? `根据视频内容可提炼为：${sample}` : '这是本地测试生成的口播脚本。',
      tags: ['本地测试', 'AI文案', '素材库', '开发模式']
    },
    en: {
      productName: 'Local Test Material',
      points: ['Mock AI analysis generated in development mode', 'Useful for verifying UI display, material tags, and usage metering', 'Production requires AI_API_KEY to call the real model'],
      audience: 'Local test users',
      script: sample ? `This video can be turned into the following sales angle: ${sample}` : 'This is a locally generated mock sales script.',
      tags: ['local-test', 'ai-copy', 'materials', 'dev-mode']
    },
    ja: {
      productName: 'ローカルテスト素材',
      points: ['開発環境で生成された模擬AI分析結果です', 'UI表示、素材タグ、利用回数の検証に使えます', '本番環境では実モデル呼び出しにAI_API_KEYが必要です'],
      audience: 'ローカルテストユーザー',
      script: sample ? `動画内容から次の販売文を作成できます：${sample}` : 'これはローカルで生成された模擬販売スクリプトです。',
      tags: ['ローカルテスト', 'AI文章', '素材庫', '開発モード']
    },
    ko: {
      productName: '로컬 테스트 소재',
      points: ['개발 환경에서 생성된 mock AI 분석 결과입니다', 'UI 표시, 소재 태그, 사용량 기록을 검증하는 데 사용됩니다', '운영 환경에서는 실제 모델 호출을 위해 AI_API_KEY가 필요합니다'],
      audience: '로컬 테스트 사용자',
      script: sample ? `영상 내용을 바탕으로 다음 판매 문구를 만들 수 있습니다: ${sample}` : '로컬에서 생성된 mock 판매 스크립트입니다.',
      tags: ['로컬테스트', 'AI카피', '소재함', '개발모드']
    }
  }[lang];
  return {
    productName: localized.productName,
    sellingPoints: localized.points,
    priceInfo: '',
    targetAudience: localized.audience,
    copyScript: localized.script,
    tags: localized.tags
  };
}

/**
 * 主入口：从视频任务提取文案
 * @param {string} taskId
 * @param {string} platform 平台名
 * @returns {Promise<{transcript, analysis}>}
 */
async function extractCopywrite(taskId, platform = '', outputLanguage = 'zh') {
  if (useMockCopywrite()) {
    const transcript = `本地 mock 转写文本：task=${taskId}, platform=${platform || 'unknown'}。用于验证 AI 文案提取、素材库标签写入和用量计量。`;
    return { transcript, analysis: buildMockAnalysis(transcript, outputLanguage) };
  }

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
  const analysis = await analyzeWithAI(transcript, outputLanguage);

  return { transcript, analysis };
}

module.exports = { extractCopywrite, analyzeWithAI };

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

function industryInstruction(industry = 'general') {
  const key = String(industry || 'general').toLowerCase();
  const map = {
    drama: 'Industry focus: short-drama promotion. Emphasize episode hook, conflict, cliffhanger, audience retention, and follow-up CTA.',
    ecommerce: 'Industry focus: cross-border or product e-commerce. Emphasize product benefits, objections, proof, offer framing, and conversion CTA.',
    xiaohongshu: 'Industry focus: Xiaohongshu seeding. Emphasize lifestyle scene, authentic experience, searchable keywords, and soft recommendation.',
    local: 'Industry focus: local services. Emphasize location, trust, booking trigger, before/after scene, and immediate action.',
    live: 'Industry focus: live commerce. Emphasize spoken rhythm, urgency, interaction cues, repeated key benefit, and order-now CTA.'
  };
  return map[key] || 'Industry focus: general short-video material analysis.';
}

function buildAnalysisPrompt(transcript, outputLanguage = 'zh', industry = 'general') {
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
7. Viral content breakdown: opening hook, customer pain points, conversion triggers, content structure, reasons it may perform well, platform fit, and rewrite angles.
8. ${industryInstruction(industry)}

Return JSON only, without markdown or extra text:
{
  "productName": "",
  "sellingPoints": ["", ""],
  "priceInfo": "",
  "targetAudience": "",
  "copyScript": "",
  "tags": ["", ""],
  "openingHook": "",
  "painPoints": ["", ""],
  "conversionTriggers": ["", ""],
  "contentStructure": ["", ""],
  "viralReason": ["", ""],
  "platformFit": ["", ""],
  "rewriteAngles": ["", ""]
}

Video transcript:
${transcript.substring(0, 4000)}`;
}

async function analyzeWithAI(transcript, outputLanguage = 'zh', industry = 'general') {
  if (!AI_API_KEY) {
    if (useMockCopywrite()) return buildMockAnalysis(transcript, outputLanguage, industry);
    throw new Error('AI_API_KEY 未配置');
  }

  const prompt = buildAnalysisPrompt(transcript, outputLanguage, industry);

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
        openingHook: parsed.openingHook || '',
        painPoints: parsed.painPoints || [],
        conversionTriggers: parsed.conversionTriggers || [],
        contentStructure: parsed.contentStructure || [],
        viralReason: parsed.viralReason || [],
        platformFit: parsed.platformFit || [],
        rewriteAngles: parsed.rewriteAngles || [],
        industry: industry || 'general',
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

function platformDisplayName(platform = 'tiktok') {
  const key = String(platform || 'tiktok').toLowerCase();
  const names = {
    tiktok: 'TikTok',
    douyin: '抖音',
    xiaohongshu: '小红书',
    youtube_shorts: 'YouTube Shorts'
  };
  return names[key] || platform || 'TikTok';
}

function rewriteStyleInstruction(style = 'seed') {
  const key = String(style || 'seed').toLowerCase();
  const instructions = {
    seed: 'Soft recommendation. Feel authentic, creator-led, useful, and low-pressure.',
    review: 'Review and comparison. Emphasize real experience, pros/cons, details, and credibility.',
    promo: 'Promotion and conversion. Highlight offer, urgency, benefits, and a clear call to action.',
    problem: 'Problem-solution angle. Start with a specific pain point, then present the product as the practical fix.',
    live: 'Live commerce host script. Use energetic spoken rhythm, repeat the key benefit, create interaction cues, and close with a clear order-now CTA.'
  };
  return instructions[key] || instructions.seed;
}

function buildRewritePrompt(analysis, platform = 'tiktok', style = 'seed', outputLanguage = 'zh') {
  const lang = normalizeOutputLanguage(outputLanguage);
  const languageNames = { zh: '简体中文', en: 'English', ja: '日本語', ko: '한국어' };
  return `You are a short-video e-commerce copywriter.

Rewrite the following AI material card into a publish-ready content pack for ${platformDisplayName(platform)}.
Output language: ${languageNames[lang]}.
Preserve product names, brand names, model numbers, prices, and specifications in their original language.

Style: ${style}
Style direction: ${rewriteStyleInstruction(style)}

Platform adaptation:
- TikTok / Shorts: stronger opening hook, fast pacing, concise caption.
- Douyin: direct selling point and conversion-oriented CTA.
- Xiaohongshu: lifestyle tone, experience details, searchable keywords.

Return JSON only:
{
  "platform": "${platform}",
  "style": "${style}",
  "title": "",
  "caption": "",
  "hashtags": ["", ""],
  "hook": "",
  "shortScript": "",
  "cta": ""
}

Material card:
${JSON.stringify(analysis || {}, null, 2).slice(0, 5000)}`;
}

function buildMockRewrite(analysis, platform = 'tiktok', style = 'seed', outputLanguage = 'zh') {
  const lang = normalizeOutputLanguage(outputLanguage);
  const product = analysis?.productName || {
    zh: '这款产品',
    en: 'This product',
    ja: 'この商品',
    ko: '이 제품'
  }[lang];
  const localized = {
    zh: {
      title: `${product}，真实好用的短视频种草点`,
      caption: `把${product}的核心卖点讲清楚：场景明确、痛点直接、适合快速发布测试。`,
      hook: `你是不是也遇到过这个问题？${product}可能就是解决方案。`,
      script: `开头先点出使用场景，再展示核心卖点，最后用一句行动号召引导收藏或下单。`,
      cta: '想要同款可以先收藏，对比后再入手。',
      tags: ['带货素材', '短视频', '好物推荐']
    },
    en: {
      title: `${product}: a ready-to-test short video angle`,
      caption: `Show the core value of ${product} with a clear use case, direct pain point, and publish-ready copy.`,
      hook: `If you deal with this problem too, ${product} may be the simple fix.`,
      script: `Open with the use case, show the key benefit, then close with a save-or-buy call to action.`,
      cta: 'Save this before you compare your options.',
      tags: ['ecommerce', 'shortvideo', 'productfinds']
    },
    ja: {
      title: `${product}のショート動画向け訴求`,
      caption: `${product}の価値を、利用シーン・悩み・すぐ使える販売文で伝えます。`,
      hook: `同じ悩みがあるなら、${product}が解決策になるかもしれません。`,
      script: `冒頭で利用シーンを見せ、主なメリットを伝え、保存や購入につながる一言で締めます。`,
      cta: '比較する前に、まず保存しておきましょう。',
      tags: ['販売素材', 'ショート動画', 'おすすめ商品']
    },
    ko: {
      title: `${product} 숏폼 판매 포인트`,
      caption: `${product}의 핵심 가치를 사용 장면, pain point, 바로 쓸 수 있는 문구로 전달합니다.`,
      hook: `이런 고민이 있다면 ${product}가 간단한 해결책이 될 수 있습니다.`,
      script: `사용 장면으로 시작하고 핵심 장점을 보여준 뒤 저장 또는 구매 CTA로 마무리합니다.`,
      cta: '비교하기 전에 먼저 저장해두세요.',
      tags: ['커머스소재', '숏폼', '제품추천']
    }
  }[lang];
  const styleLabel = {
    seed: { zh: '种草', en: 'recommendation', ja: 'おすすめ', ko: '추천' },
    review: { zh: '测评', en: 'review', ja: 'レビュー', ko: '리뷰' },
    promo: { zh: '促销', en: 'promotion', ja: '販促', ko: '프로모션' },
    problem: { zh: '痛点解决', en: 'problem-solution', ja: '悩み解決', ko: '문제 해결' },
    live: { zh: '直播口播', en: 'live pitch', ja: 'ライブ口上', ko: '라이브 멘트' }
  }[String(style || 'seed').toLowerCase()]?.[lang] || style;
  return {
    platform,
    style,
    title: `${localized.title} · ${styleLabel}`,
    caption: `${localized.caption} (${styleLabel})`,
    hashtags: localized.tags,
    hook: localized.hook,
    shortScript: localized.script,
    cta: localized.cta
  };
}

async function rewriteCommerceCard(analysis, platform = 'tiktok', style = 'seed', outputLanguage = 'zh') {
  if (!analysis || typeof analysis !== 'object') throw new Error('缺少 AI 素材卡');
  if (!AI_API_KEY) {
    if (useMockCopywrite()) return buildMockRewrite(analysis, platform, style, outputLanguage);
    throw new Error('AI_API_KEY 未配置');
  }

  const prompt = buildRewritePrompt(analysis, platform, style, outputLanguage);
  try {
    const res = await axios.post(`${AI_API_URL}/chat/completions`, {
      model: AI_MODEL,
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.35,
      max_tokens: 1400,
    }, {
      headers: {
        'Authorization': `Bearer ${AI_API_KEY}`,
        'Content-Type': 'application/json',
      },
      timeout: 60000,
    });

    const content = res.data?.choices?.[0]?.message?.content || '';
    const jsonMatch = content.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error('AI 返回格式异常');
    const parsed = JSON.parse(jsonMatch[0]);
    return {
      platform,
      style,
      title: parsed.title || '',
      caption: parsed.caption || '',
      hashtags: Array.isArray(parsed.hashtags) ? parsed.hashtags : [],
      hook: parsed.hook || '',
      shortScript: parsed.shortScript || '',
      cta: parsed.cta || ''
    };
  } catch (e) {
    if (e.response) {
      logger.error(`[AI rewrite] API error: ${e.response.status} ${JSON.stringify(e.response.data).substring(0, 200)}`);
      throw new Error(`AI API error: ${e.response.status}`);
    }
    throw e;
  }
}

function buildMockAnalysis(transcript, outputLanguage = 'zh', industry = 'general') {
  const lang = normalizeOutputLanguage(outputLanguage);
  const sample = transcript.replace(/\s+/g, ' ').trim().slice(0, 120);
  const localized = {
    zh: {
      productName: '本地测试素材',
      points: ['这是开发环境生成的模拟 AI 分析结果', '用于验证前端展示、素材库标签和使用量记录', '生产环境必须配置 AI_API_KEY 才会调用真实模型'],
      audience: '本地测试用户',
      script: sample ? `根据视频内容可提炼为：${sample}` : '这是本地测试生成的口播脚本。',
      tags: ['本地测试', 'AI文案', '素材库', '开发模式'],
      hook: '3秒内点出商品核心场景，快速建立观看理由。',
      pain: ['用户不知道素材价值点', '缺少可复用的带货脚本'],
      triggers: ['强调省时', '突出可直接复用'],
      structure: ['场景引入', '卖点说明', '行动号召'],
      viral: ['信息密度高', '适合做短视频二创'],
      platform: ['TikTok短视频', '抖音带货'],
      angles: ['痛点开场版', '测评种草版', '限时优惠版']
    },
    en: {
      productName: 'Local Test Material',
      points: ['Mock AI analysis generated in development mode', 'Useful for verifying UI display, material tags, and usage metering', 'Production requires AI_API_KEY to call the real model'],
      audience: 'Local test users',
      script: sample ? `This video can be turned into the following sales angle: ${sample}` : 'This is a locally generated mock sales script.',
      tags: ['local-test', 'ai-copy', 'materials', 'dev-mode'],
      hook: 'Lead with the core use case in the first 3 seconds.',
      pain: ['Users need faster material analysis', 'Creators need reusable sales scripts'],
      triggers: ['Save time', 'Ready-to-use copy'],
      structure: ['Scene setup', 'Selling points', 'Call to action'],
      viral: ['High information density', 'Easy to repurpose for short videos'],
      platform: ['TikTok short videos', 'Product demo ads'],
      angles: ['Pain-point opener', 'Review-style pitch', 'Limited-time offer']
    },
    ja: {
      productName: 'ローカルテスト素材',
      points: ['開発環境で生成された模擬AI分析結果です', 'UI表示、素材タグ、利用回数の検証に使えます', '本番環境では実モデル呼び出しにAI_API_KEYが必要です'],
      audience: 'ローカルテストユーザー',
      script: sample ? `動画内容から次の販売文を作成できます：${sample}` : 'これはローカルで生成された模擬販売スクリプトです。',
      tags: ['ローカルテスト', 'AI文章', '素材庫', '開発モード'],
      hook: '最初の3秒で商品の利用シーンを提示します。',
      pain: ['素材の価値を素早く把握したい', '再利用できる販売文が必要'],
      triggers: ['時短を訴求', 'すぐ使える文案を提示'],
      structure: ['シーン提示', 'セールスポイント', '行動喚起'],
      viral: ['情報密度が高い', 'ショート動画に再編集しやすい'],
      platform: ['TikTok短尺動画', '商品デモ広告'],
      angles: ['悩み訴求型', 'レビュー型', '限定オファー型']
    },
    ko: {
      productName: '로컬 테스트 소재',
      points: ['개발 환경에서 생성된 mock AI 분석 결과입니다', 'UI 표시, 소재 태그, 사용량 기록을 검증하는 데 사용됩니다', '운영 환경에서는 실제 모델 호출을 위해 AI_API_KEY가 필요합니다'],
      audience: '로컬 테스트 사용자',
      script: sample ? `영상 내용을 바탕으로 다음 판매 문구를 만들 수 있습니다: ${sample}` : '로컬에서 생성된 mock 판매 스크립트입니다.',
      tags: ['로컬테스트', 'AI카피', '소재함', '개발모드'],
      hook: '첫 3초 안에 핵심 사용 장면을 보여줍니다.',
      pain: ['소재의 가치를 빠르게 파악해야 함', '재사용 가능한 판매 스크립트가 필요함'],
      triggers: ['시간 절약 강조', '바로 쓸 수 있는 문구 제공'],
      structure: ['상황 제시', '판매 포인트', '행동 유도'],
      viral: ['정보 밀도가 높음', '숏폼 영상으로 재가공하기 쉬움'],
      platform: ['TikTok 숏폼', '상품 데모 광고'],
      angles: ['문제 제기형', '리뷰형', '한정 혜택형']
    }
  }[lang];
  return {
    productName: localized.productName,
    sellingPoints: localized.points,
    priceInfo: '',
    targetAudience: localized.audience,
    copyScript: localized.script,
    tags: localized.tags,
    openingHook: localized.hook,
    painPoints: localized.pain,
    conversionTriggers: localized.triggers,
    contentStructure: localized.structure,
    viralReason: localized.viral,
    platformFit: localized.platform,
    rewriteAngles: localized.angles,
    industry: industry || 'general'
  };
}

/**
 * 主入口：从视频任务提取文案
 * @param {string} taskId
 * @param {string} platform 平台名
 * @returns {Promise<{transcript, analysis}>}
 */
async function extractCopywrite(taskId, platform = '', outputLanguage = 'zh', industry = 'general') {
  if (useMockCopywrite()) {
    const transcript = `本地 mock 转写文本：task=${taskId}, platform=${platform || 'unknown'}。用于验证 AI 文案提取、素材库标签写入和用量计量。`;
    return { transcript, analysis: buildMockAnalysis(transcript, outputLanguage, industry) };
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
  const analysis = await analyzeWithAI(transcript, outputLanguage, industry);

  return { transcript, analysis };
}

module.exports = { extractCopywrite, analyzeWithAI, rewriteCommerceCard };

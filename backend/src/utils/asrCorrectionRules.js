const DEFAULT_DOMAIN_TERMS = [
  '仿真', '磁吸', '磁吸充电', '磁吸支架', '磁吸手机壳',
  '材质', '工艺', '电商', '带货', '口播', '卖点',
  '数字人', '机器人', '模型', '样品', '配件'
];

function normalizeText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function getDomainTerms(context = '') {
  const extra = String(process.env.ASR_CORRECTION_TERMS || '')
    .split(/[,，\n]/)
    .map(item => item.trim())
    .filter(Boolean);
  const contextTerms = normalizeText(context)
    .split(/[，,。！？!?、\s:：|/\\-]+/)
    .map(item => item.trim())
    .filter(item => item.length >= 2 && item.length <= 12);
  return Array.from(new Set([...DEFAULT_DOMAIN_TERMS, ...extra, ...contextTerms])).slice(0, 80);
}

function hasAny(value, patterns) {
  return patterns.some(pattern => pattern.test(value));
}

function applyHomophoneCorrections(text, context = '') {
  if (!text || typeof text !== 'string') return text;
  let corrected = text;
  const haystack = `${context}\n${text}`;

  const simulationContext = [
    /仿真|模拟|模型|样品|产品|材料|材质|机器人|数字人|道具|工艺|测试|训练|复刻|还原/,
    /电商|带货|口播|卖点|商品|配件|玩具|摆件|绿植|植物|草坪|花束/
  ];
  const roomContext = [/卧室|客厅|厨房|卫生间|房屋|租房|装修|户型|空间|家里|室内/];
  if (hasAny(haystack, simulationContext) && !hasAny(haystack, roomContext)) {
    corrected = corrected
      .replace(/房间(?=花|草|草坪|植物|绿植|模型|材料|材质|样品|产品|机器人|数字人|测试|训练|皮肤|工艺|摆件|道具)/g, '仿真')
      .replace(/(?<=这[个款种]|做|高度|超高|高度还原|逼真|模拟)房间/g, '仿真');
  }
  if (/仿真|模型|样品|产品|材料|材质|机器人|数字人|道具|工艺/.test(haystack)) {
    corrected = corrected.replace(/房间(?=模型|样品|产品|材料|材质|机器人|数字人|摆件|道具)/g, '仿真');
  }

  const magneticContext = [
    /磁吸|磁力|吸附|吸住|充电|无线充|手机壳|手机支架|车载|支架|配件|卡包|背夹|充电宝|Magsafe|MagSafe/i
  ];
  const historicalContext = [/慈禧|太后|清朝|晚清|历史|宫廷|故宫|人物|传记/];
  const likelyMagneticPhrase = /(?:慈禧|慈溪)(?=支架|充电|手机壳|配件|卡包|车载|背夹|充电宝)|(?<=手机壳|支架|配件|车载|无线充|充电宝)(?:慈禧|慈溪)/.test(corrected);
  if ((hasAny(haystack, magneticContext) || likelyMagneticPhrase) && (!hasAny(haystack, historicalContext) || likelyMagneticPhrase)) {
    corrected = corrected.replace(/慈禧|慈溪/g, '磁吸');
  }

  const ecommerceContext = /电商|带货|商品|产品|下单|直播|口播|卖点|购买|链接|橱窗|店铺/.test(haystack);
  if (ecommerceContext) {
    corrected = corrected
      .replace(/才智(?=很好|不错|高级|柔软|耐用|亲肤|舒服|轻薄|透气|防水)/g, '材质')
      .replace(/才质(?=很好|不错|高级|柔软|耐用|亲肤|舒服|轻薄|透气|防水)/g, '材质')
      .replace(/卖点(?=链接|下单|购买|拍下)/g, '买点');
  }

  return corrected;
}

function buildCorrectionHints(context = '', language = 'zh') {
  const terms = getDomainTerms(context);
  const lang = String(language || 'auto').toLowerCase();
  if (lang.startsWith('en')) {
    return [
      `Preferred brand/product/domain terms: ${terms.join(', ')}`,
      'Fix ASR mistakes caused by similar sounds, restore brand capitalization, product names, model names, numbers, units, and acronyms.',
      'Do not rewrite style or summarize. Prefer product/ecommerce/technical terms over unrelated common words when context indicates a product demo.'
    ].join('\n');
  }
  if (lang.startsWith('ja')) {
    return [
      `優先して保持する専門用語・ブランド名：${terms.join('、')}`,
      '音声認識の誤り、かな/漢字変換ミス、カタカナのブランド名、商品名、型番、数字、単位を修正してください。',
      '要約や言い換えはせず、明らかな誤認識だけを直してください。'
    ].join('\n');
  }
  if (lang.startsWith('ko')) {
    return [
      `우선 보존할 브랜드/상품/전문 용어: ${terms.join(', ')}`,
      '음성 인식의 동음이의어 오류, 외래어 상품명, 브랜드명, 모델명, 숫자, 단위를 바로잡으세요.',
      '요약하거나 문체를 바꾸지 말고 명백한 인식 오류만 수정하세요.'
    ].join('\n');
  }
  return [
    `优先保留/使用这些业务词：${terms.join('、')}`,
    '常见同音混淆：仿真/房间、磁吸/慈禧/慈溪、材质/才智/才质、卖点/买点、使用/试用、型号/形好、定制/订制、式/氏。',
    '如果上下文是商品、电商、配件、材料、工艺、模型、机器人、数字人，优先选择商品和技术词，不要误改成人名、地名或房屋空间词。'
  ].join('\n');
}

module.exports = {
  applyHomophoneCorrections,
  buildCorrectionHints,
  getDomainTerms
};

/**
 * 抖音专用下载器（不依赖 yt-dlp）
 *
 * 通过 iesdouyin.com 移动端页面解析视频/图文/封面
 * 不需要登录 cookies
 *
 * 关键逻辑:
 *   1. 去水印: 抖音 bit_rate[].play_addr.url_list 数组里第 0 个常常是 playwm（带水印），
 *              要主动挑无水印（含 /play/ 不含 /playwm/）；只有 playwm 时把 playwm 改写为 play。
 *   2. 高画质: iesdouyin 默认对游客返回最高 720p，但 aweme/v1/play/ 接口加 ratio=1080p
 *              通常能拿到原画 1080p。ratio 参数只支持 540p/720p/1080p，2K/4K 需走 TikHub 付费 API。
 *   3. 多候选 URL 兜底: 抖音 CDN 域名经常切换（aweme.snssdk.com / api.amemv.com /
 *              aweme.amemv.com 等），按优先级一个个试，任一成功即返回。
 */

const { URL } = require('url');
const fs = require('fs');
const path = require('path');
const { httpGet: sharedHttpGet } = require('../utils/httpGet');
const { heightToLabel } = require('../utils/media');
const logger = require('../utils/logger');

// 视频下载最大 500MB
const MAX_SIZE = 500 * 1024 * 1024;

// 抖音请求默认头
const DOUYIN_HEADERS = { 'Referer': 'https://www.douyin.com/' };

/**
 * 抖音专用 httpGet（自动附加 Douyin Referer）
 */
function httpGet(url, options = {}) {
  const mergedHeaders = { ...DOUYIN_HEADERS, ...(options.headers || {}) };
  return sharedHttpGet(url, { ...options, headers: mergedHeaders, maxSize: options.maxSize || MAX_SIZE });
}

// ============ 候选 URL 构造工具 ============

/**
 * 把 ratio=720p 这种参数改写为目标 target；
 * 如果原 URL 没有 ratio 参数，append 一个。
 * 仅对 aweme/v1/play(wm)? 形式的 URL 有效，其它 URL 原样返回。
 */
function bumpRatio(rawUrl, target) {
  if (!rawUrl || !target) return rawUrl;
  if (!/aweme\/v1\/play(wm)?\//.test(rawUrl)) return rawUrl;
  if (/[?&]ratio=/.test(rawUrl)) {
    return rawUrl.replace(/([?&]ratio=)[^&]*/, `$1${target}`);
  }
  return rawUrl + (rawUrl.includes('?') ? '&' : '?') + 'ratio=' + target;
}

/** playwm → play（去水印改写） */
function stripWatermark(rawUrl) {
  if (!rawUrl) return rawUrl;
  return rawUrl.replace('/aweme/v1/playwm/', '/aweme/v1/play/');
}

/** URL 是否带水印 */
function isWatermarked(rawUrl) {
  return !!rawUrl && /\/aweme\/v1\/playwm\//.test(rawUrl);
}

/**
 * 抖音 CDN 多 host 备份。给 aweme/v1/play/ URL 替换 host 拿到一个备用直链。
 */
const ALT_HOSTS = ['aweme.snssdk.com', 'api.amemv.com', 'aweme.amemv.com'];
function withAltHost(rawUrl, host) {
  try {
    const u = new URL(rawUrl);
    u.host = host;
    u.protocol = 'https:';
    return u.toString();
  } catch { return rawUrl; }
}

/**
 * 把一个 url_list（来自 bit_rate[].play_addr.url_list 或 play_addr.url_list）
 * 展开成「最佳 → 兜底」的候选列表（已去重）。
 *
 * @param {string[]} rawUrls 抖音返回的原始 url 数组
 * @param {string|null} targetRatio  '1080p' | '720p' | '540p' | null
 * @returns {string[]} 去重后的候选 URL 列表
 */
function buildCandidates(rawUrls, targetRatio) {
  if (!Array.isArray(rawUrls)) return [];
  const out = [];
  const seen = new Set();
  const push = (u) => {
    if (!u || typeof u !== 'string') return;
    // 抖音 URL 偶发以 // 开头
    if (u.startsWith('//')) u = 'https:' + u;
    if (u.startsWith('http://')) u = 'https://' + u.substring(7);
    if (seen.has(u)) return;
    seen.add(u); out.push(u);
  };

  // —— 第 1 优先级：原本无水印的原始 URL（不 bump，防止 ratio 导致低码率重编码） —— //
  for (const raw of rawUrls) {
    if (!isWatermarked(raw)) push(raw);
  }

  // —— 第 2 优先级：原本无水印 + bumped 到 targetRatio —— //
  for (const raw of rawUrls) {
    if (!isWatermarked(raw)) {
      const bumped = targetRatio ? bumpRatio(raw, targetRatio) : raw;
      push(bumped);
      // 同时给该 URL 的所有 alt host 也加入
      for (const h of ALT_HOSTS) push(withAltHost(bumped, h));
    }
  }

  // —— 第 3 优先级：playwm → play 改写 + bumped —— //
  for (const raw of rawUrls) {
    if (isWatermarked(raw)) {
      const stripped = stripWatermark(raw);
      const bumped = targetRatio ? bumpRatio(stripped, targetRatio) : stripped;
      push(bumped);
      for (const h of ALT_HOSTS) push(withAltHost(bumped, h));
      push(stripped); // 不 bump 的版本
    }
  }

  // —— 最后兜底：原始 playwm（有水印，但能下） —— //
  for (const raw of rawUrls) {
    if (isWatermarked(raw)) push(raw);
  }

  return out;
}

/**
 * 从 iesdouyin.com 页面解析作品数据
 *
 * @param {string} url 抖音作品 URL
 * @param {object} [opts]
 * @param {string|null} [opts.targetRatio] '1080p' / '720p' / '540p'，影响候选 URL 的 ratio 改写
 */
async function parseDouyinPage(url, opts = {}) {
  const targetRatio = opts.targetRatio || null;
  // 先解析短链接
  let resolvedUrl;
  try {
    const res = await httpGet(url);
    resolvedUrl = res.finalUrl || url;
  } catch { resolvedUrl = url; }

  // 提取 aweme_id
  let awemeId;
  const noteMatch = resolvedUrl.match(/\/note\/(\d+)/);
  const videoMatch = resolvedUrl.match(/\/video\/(\d+)/);
  if (noteMatch) awemeId = noteMatch[1];
  else if (videoMatch) awemeId = videoMatch[1];
  else {
    // 从短链接路径提取
    const pathMatch = resolvedUrl.match(/\/([a-zA-Z0-9]{8,})\/?$/);
    if (!pathMatch) throw new Error('无法解析作品 ID');
    // 跳转到 PC 获取 ID
    try {
      const pcRes = await httpGet(resolvedUrl, {
        headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120.0.0.0' }
      });
      const pcUrl = pcRes.finalUrl || resolvedUrl;
      const pcNote = pcUrl.match(/\/note\/(\d+)/);
      const pcVideo = pcUrl.match(/\/video\/(\d+)/);
      awemeId = pcNote?.[1] || pcVideo?.[1];
    } catch {}
    if (!awemeId) throw new Error('无法解析作品 ID');
  }

  // 通过 iesdouyin.com 获取数据
  const shareUrl = `https://www.iesdouyin.com/share/video/${awemeId}`;
  const res = await httpGet(shareUrl);
  const html = res.body;

  // 提取 _ROUTER_DATA
  const routerIdx = html.indexOf('_ROUTER_DATA');
  if (routerIdx === -1) throw new Error('页面解析失败');

  const jsonStart = html.indexOf('{', routerIdx);
  let depth = 0, jsonEnd = jsonStart;
  for (let i = jsonStart; i < html.length; i++) {
    if (html[i] === '{') depth++;
    else if (html[i] === '}') { depth--; if (depth === 0) { jsonEnd = i + 1; break; } }
  }

  const raw = html.substring(jsonStart, jsonEnd);
  const data = JSON.parse(raw);

  // 提取作品信息
  const result = {
    awemeId,
    title: '',
    type: 'unknown', // video, note, image
    videoUrl: '',           // 兼容旧字段：== videoCandidates[0]
    videoCandidates: [],    // 按优先级排序的候选 URL（无水印 + 高画质优先）
    videoId: '',            // play_addr.uri，用于必要时重构 URL
    width: 0,
    height: 0,
    quality: '',
    audioUrl: '',
    coverUrl: '',
    images: [],
    duration: 0,
  };

  // 收集所有 bit_rate 项 + 默认 play_addr，最后统一排序
  const videoChoices = [];
  // { width, height, urlList, watermarked, vid }

  // 递归搜索
  function search(obj) {
    if (!obj || typeof obj !== 'object') return;
    if (Array.isArray(obj)) { obj.forEach(search); return; }

    if (obj.desc && typeof obj.desc === 'string' && obj.desc.length > result.title.length) {
      result.title = obj.desc;
    }

    // 图片列表
    if (obj.images && Array.isArray(obj.images) && obj.images.length > 0) {
      result.type = 'note';
      for (const img of obj.images) {
        const urls = img?.url_list || [];
        if (urls.length > 0) result.images.push(urls[urls.length - 1]);
      }
    }

    // play_addr (无 bit_rate 时的兜底)
    if (obj.play_addr && Array.isArray(obj.play_addr.url_list) && obj.play_addr.url_list.length > 0) {
      const pa = obj.play_addr;
      const sample = pa.url_list[0] || '';
      if (sample && (sample.includes('.mp4') || sample.includes('video_id') || sample.includes('aweme'))) {
        videoChoices.push({
          width: pa.width || obj.width || 0,
          height: pa.height || obj.height || 0,
          urlList: pa.url_list.filter(Boolean),
          vid: pa.uri || obj.uri || '',
        });
        result.type = 'video';
        if (obj.duration) result.duration = obj.duration;
      }
      if (pa.uri && /\.mp3$/i.test(pa.uri)) {
        result.audioUrl = pa.uri;
      }
    }

    // bit_rate 数组（最常见的高画质入口）
    if (Array.isArray(obj.bit_rate)) {
      for (const br of obj.bit_rate) {
        const pa = br.play_addr;
        if (!pa || !Array.isArray(pa.url_list) || pa.url_list.length === 0) continue;
        videoChoices.push({
          width: pa.width || br.width || 0,
          height: pa.height || br.height || 0,
          urlList: pa.url_list.filter(Boolean),
          vid: pa.uri || br.uri || '',
        });
        result.type = 'video';
      }
    }

    // 封面
    if (obj.cover?.url_list?.[0] && !result.coverUrl) {
      result.coverUrl = obj.cover.url_list[0];
    }
    if (obj.origin_cover?.url_list?.[0] && !result.coverUrl) {
      result.coverUrl = obj.origin_cover.url_list[0];
    }
    if (obj.dynamic_cover?.url_list?.[0] && !result.coverUrl) {
      result.coverUrl = obj.dynamic_cover.url_list[0];
    }

    // 时长
    if (obj.duration && obj.duration > result.duration) {
      result.duration = obj.duration;
    }

    for (const v of Object.values(obj)) {
      if (v && typeof v === 'object') search(v);
    }
  }

  search(data);

  // 把所有 video choices 按高度降序排序，组装出最终 candidates
  if (videoChoices.length > 0) {
    videoChoices.sort((a, b) => (b.height || 0) - (a.height || 0));
    const best = videoChoices[0];
    result.width = best.width;
    result.height = best.height;
    result.quality = `${best.width || 0}x${best.height || 0}`;
    result.videoId = best.vid || '';

    // 把所有 choice 的 url_list 合并成一个超大候选池（buildCandidates 会做去重 + 优先级排序）
    const aggregated = [];
    for (const c of videoChoices) {
      for (const u of c.urlList) aggregated.push(u);
    }
    result.videoCandidates = buildCandidates(aggregated, targetRatio);

    // 保留每级画质的原始URL(不经过bumpRatio), 用于精确下载
    result.videoUrlsByHeight = {};
    for (const c of videoChoices) {
      if (c.urlList.length > 0) {
        const h = c.height || 0;
        if (h > 0) result.videoUrlsByHeight[h] = c.urlList[0];
      }
    }

    // 如果有 video_id 且最高画质 < 1080p 但用户要 1080p，构造一条直链作为兜底
    // 注意：ratio=1080p 参数会导致服务端低码率重编码，所以放在候选列表末尾作为最后备选
    if (result.videoId && targetRatio && /1080p|2k|4k/i.test(targetRatio) && (best.height || 0) < 1080) {
      const synth = `https://aweme.snssdk.com/aweme/v1/play/?video_id=${encodeURIComponent(result.videoId)}&ratio=${targetRatio}&line=0`;
      // 放在候选列表末尾（低优先级，原始 URL 优先）
      if (!result.videoCandidates.includes(synth)) {
        result.videoCandidates.push(synth);
        for (const h of ALT_HOSTS) {
          const alt = withAltHost(synth, h);
          if (!result.videoCandidates.includes(alt)) result.videoCandidates.push(alt);
        }
      }
    }

    // 兼容旧字段
    result.videoUrl = result.videoCandidates[0] || '';
  }

  if (!result.title) result.title = '抖音作品';
  if (result.images.length === 0 && result.videoCandidates.length === 0 && !result.audioUrl) {
    throw new Error('无法提取媒体文件，可能需要登录查看');
  }

  result.allQualities = videoChoices.map(c => ({ width: c.width, height: c.height }));

  return result;
}

/**
 * 把上层传下来的 quality 字符串（如 'bestvideo[height<=1080]+...'）转换为目标 ratio
 *
 * 注意: iesdouyin aweme/v1/play/ 接口只认 540p/720p/1080p 这三个 ratio 值。
 * 传入 2k/4k 等无效值会被服务端忽略并回退到默认低画质，所以统一封顶 1080p。
 * VIP 真 4K 需求走 TikHub fetch_video_high_quality_play_url 付费 API。
 */
function deriveTargetRatio(quality, isVip) {
  // iesdouyin 最大支持 1080p，ratio 参数不支持 2k/4k
  const IESDOUYIN_MAX = '1080p';
  if (quality && typeof quality === 'string') {
    const m = quality.match(/height\s*<=\s*(\d+)/i);
    if (m) {
      const h = parseInt(m[1], 10);
      // >=1080 统一返回 1080p（4k/2k 对 iesdouyin 无效）
      if (h >= 1080) return IESDOUYIN_MAX;
      if (h >= 720) return '720p';
      return '540p';
    }
    // 模糊匹配也一样封顶
    if (/4k|2160|2k|1440|1080/i.test(quality)) return IESDOUYIN_MAX;
    if (/720/i.test(quality)) return '720p';
  }
  return isVip ? IESDOUYIN_MAX : '720p';
}

/**
 * 下载抖音作品（统一入口）
 *
 * @param {string} url
 * @param {string} taskId
 * @param {function} onProgress
 * @param {object} [opts]
 * @param {string|null} [opts.quality]  上层传下来的 yt-dlp 风格 quality 串
 * @param {boolean}     [opts.isVip]
 */
async function downloadDouyin(url, taskId, onProgress, opts = {}) {
  const downloadDir = path.join(__dirname, '../../downloads');
  if (!fs.existsSync(downloadDir)) fs.mkdirSync(downloadDir, { recursive: true });

  if (onProgress) onProgress(5, '解析链接');

  const targetRatio = deriveTargetRatio(opts.quality, opts.isVip);
  logger.info("[douyin] targetRatio=" + targetRatio + " firstUrl=" + (info.videoCandidates[0]||"").substring(0,120));
  const info = await parseDouyinPage(url, { targetRatio });
  if (onProgress) onProgress(30, '获取作品信息');

  logger.info(`[douyin] Parsed: type=${info.type}, title="${(info.title||'').substring(0, 50)}", images=${info.images.length}, candidates=${info.videoCandidates.length}, target=${targetRatio}, parsedHeight=${info.height}`);

  const result = {
    title: info.title,
    duration: info.duration,
    thumbnailUrl: '',
    subtitleFiles: [],
    images: [],
    isNote: false,
    width: info.width,
    height: info.height,
    quality: info.quality,
  };

  // 1. 下载封面
  if (info.coverUrl) {
    try {
      const coverBuf = await httpGet(info.coverUrl, { responseType: 'arraybuffer', timeout: 15000 });
      const coverPath = path.join(downloadDir, `${taskId}_thumb.jpg`);
      fs.writeFileSync(coverPath, coverBuf);
      result.thumbnailUrl = `/download/${taskId}_thumb.jpg`;
    } catch (e) {
      logger.info('[douyin] cover download failed:', e.message);
    }
  }

  // 2. 图文作品 → 下载图片
  if (info.images.length > 0) {
    result.isNote = true;
    for (let i = 0; i < info.images.length; i++) {
      try {
        const buf = await httpGet(info.images[i], { responseType: 'arraybuffer', timeout: 30000 });
        const filename = `${taskId}_${i + 1}.jpg`;
        const filepath = path.join(downloadDir, filename);
        fs.writeFileSync(filepath, buf);
        result.images.push({ filename, path: filepath, url: `/download/${filename}` });
      } catch (e) {
        logger.error(`[douyin] image ${i + 1} failed:`, e.message);
      }
      if (onProgress) onProgress(30 + Math.round((i + 1) / info.images.length * 60), `下载图片 ${i + 1}/${info.images.length}`);
    }
    if (onProgress) onProgress(100, '完成');
    result.ext = 'note';
    return result;
  }

  // 3. 视频作品 → 优先用原始分辨率URL，兜底用候选列表
  if (info.videoCandidates.length > 0) {
    if (onProgress) onProgress(35, '下载视频');

    // 精确画质匹配: 用parse阶段保存的原始URL(不经bumpRatio)
    let candidates = [...info.videoCandidates];
    if (targetRatio && info.videoUrlsByHeight) {
      const targetHeight = parseInt(targetRatio) || 0;
      // 找最接近的画质(向下匹配)
      const heights = Object.keys(info.videoUrlsByHeight).map(Number).sort((a,b) => b-a);
      for (const h of heights) {
        if (h <= targetHeight) {
          const exactUrl = info.videoUrlsByHeight[h];
          if (exactUrl && !candidates.includes(exactUrl)) {
            candidates.unshift(exactUrl);
          }
          break;
        }
      }
    }

    let videoBuf;
    let pickedUrl = '';
    let lastErr;
    let attempt = 0;
    const totalCandidates = candidates.length;

    for (const candidate of candidates) {
      attempt++;
      try {
        const buf = await httpGet(candidate, { responseType: 'arraybuffer', timeout: 120000 });
        // sanity 检查：视频应该 > 50KB 且不是 HTML 错误页
        if (!buf || buf.length < 50 * 1024) {
          throw new Error(`response too small: ${buf ? buf.length : 0} bytes`);
        }
        const head = buf.slice(0, 32).toString('utf8').trim().toLowerCase();
        if (head.startsWith('<!doctype') || head.startsWith('<html') || head.startsWith('{')) {
          throw new Error('response looks like HTML/JSON error page');
        }
        videoBuf = buf;
        pickedUrl = candidate;
        const wm = isWatermarked(candidate) ? ' [WATERMARKED!]' : '';
        logger.info(`[douyin] video downloaded via candidate ${attempt}/${totalCandidates}${wm}: ${candidate.substring(0, 120)}`);
        break;
      } catch (e) {
        lastErr = e;
        logger.info(`[douyin] candidate ${attempt}/${totalCandidates} failed: ${e.message} (${candidate.substring(0, 80)}...)`);
      }
      if (onProgress) {
        const pct = 35 + Math.round((attempt / totalCandidates) * 50);
        onProgress(Math.min(85, pct), `尝试候选源 ${attempt}/${totalCandidates}`);
      }
    }

    if (!videoBuf) {
      throw new Error(`视频下载失败（${totalCandidates} 个候选源全部失败）: ${lastErr?.message || 'unknown'}`);
    }

    if (isWatermarked(pickedUrl)) {
      logger.warn(`[douyin] WARN: only watermarked source available for taskId=${taskId}; user may see watermark`);
    }

    const filename = `${taskId}.mp4`;
    const filepath = path.join(downloadDir, filename);
    fs.writeFileSync(filepath, videoBuf);

    result.filePath = filepath;
    result.ext = 'mp4';
    result.downloadUrl = `/download/${filename}`;
    result.watermarked = isWatermarked(pickedUrl);

    if (onProgress) onProgress(100, '完成');
    return result;
  }

  // 4. 纯音频（图文配乐）
  if (info.audioUrl) {
    if (onProgress) onProgress(35, '下载音频');
    const audioBuf = await httpGet(info.audioUrl, { responseType: 'arraybuffer', timeout: 60000 });
    const filename = `${taskId}.mp3`;
    const filepath = path.join(downloadDir, filename);
    fs.writeFileSync(filepath, audioBuf);
    result.filePath = filepath;
    result.ext = 'mp3';
    result.downloadUrl = `/download/${filename}`;
    result.audioUrl = result.downloadUrl;
    if (onProgress) onProgress(100, '完成');
    return result;
  }

  throw new Error('没有可下载的媒体文件');
}

function isDouyinUrl(url) {
  return /douyin\.com|iesdouyin\.com/.test(url);
}

/**
 * 获取抖音视频画质信息（不下载，只返回画质列表）
 * 复用 parseDouyinPage 的解析逻辑，提取 bit_rate 数组
 */
async function getDouyinVideoInfo(url) {
  const info = await parseDouyinPage(url, { targetRatio: '1080p' });
  const allQualities = info.allQualities || [];
  
  // iesdouyin aweme/v1/play/ ratio 参数只认 540p/720p/1080p
  // 元数据可能显示 2K/4K 但实际拉不到，统一封顶 1080p 避免 UI 虚报
  const IESDOUYIN_REAL_MAX = 1080;
  const metaMaxHeight = allQualities.length > 0 ? allQualities[0].height : IESDOUYIN_REAL_MAX;
  const trustedMaxHeight = Math.min(metaMaxHeight, IESDOUYIN_REAL_MAX);
  
  // 根据分辨率估算码率(保守值),用于估算文件大小
  // iesdouyin 返回的 duration 可能是毫秒，归一化为秒
  let duration = info.duration || 0;
  if (duration > 1000) duration = Math.round(duration / 1000);
  
  const estimateSize = (height) => {
    if (!duration || !height) return 0;
    let bitrate;
    if (height >= 2160) bitrate = 20000000;
    else if (height >= 1440) bitrate = 10000000;
    else if (height >= 1080) bitrate = 5000000;
    else if (height >= 720) bitrate = 2500000;
    else bitrate = 1500000;
    return Math.round(duration * bitrate / 8);
  };

  // 画质标签映射
  const labelMap = { 540: '540p', 720: '720p', 1080: '1080p' };

  // Build preset options up to trusted max
  const presets = [540, 720, 1080].filter(h => h <= trustedMaxHeight);
  const qualities = presets
    .map(h => ({
      quality: labelMap[h] || `${h}p`,
      format: 'mp4',
      width: h, height: h,  // 宽高都用分辨率，避免前端误判竖屏为2K
      hasVideo: true,
      hasAudio: true,
      size: estimateSize(h)
    }))
    .sort((a, b) => b.height - a.height);
  
  return {
    title: info.title || '抖音作品',
    thumbnail: info.coverUrl || '',
    duration: info.duration || 0,
    qualities: qualities.length > 0 ? qualities : [{ quality: '720p', format: 'mp4', width: 1280, height: 720, hasVideo: true, hasAudio: true }]
  };
}

module.exports = {
  downloadDouyin,
  parseDouyinPage,
  isDouyinUrl,
  getDouyinVideoInfo,
  // exposed for tests / advanced callers
  buildCandidates,
  bumpRatio,
  stripWatermark,
  isWatermarked,
  deriveTargetRatio,
};

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
 *              通常能拿到原画 1080p（甚至 4K）。VIP 主动注入 ratio=1080p。
 *   3. 多候选 URL 兜底: 抖音 CDN 域名经常切换（aweme.snssdk.com / api.amemv.com /
 *              aweme.amemv.com 等），按优先级一个个试，任一成功即返回。
 */

function heightToLabel(h) {
  if (h >= 4320) return '8K';
  if (h >= 2160) return '4K';
  if (h >= 1440) return '2K';
  if (h >= 1080) return '1080p';
  if (h >= 720) return '720p';
  if (h >= 480) return '480p';
  if (h >= 360) return '360p';
  return "%sp".replace("%s", String(h));
}
const https = require('https');
const http = require('http');
const { URL } = require('url');
const fs = require('fs');
const path = require('path');

// 视频下载最大 500MB
const MAX_SIZE = 500 * 1024 * 1024;

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

  // —— 第 1 优先级：原本就无水印 + bumped 到 targetRatio —— //
  for (const raw of rawUrls) {
    if (!isWatermarked(raw)) {
      const bumped = targetRatio ? bumpRatio(raw, targetRatio) : raw;
      push(bumped);
      // 同时给该 URL 的所有 alt host 也加入
      for (const h of ALT_HOSTS) push(withAltHost(bumped, h));
    }
  }

  // —— 第 2 优先级：原本无水印的原始 URL（不 bump，防止 ratio 被服务端不认） —— //
  for (const raw of rawUrls) {
    if (!isWatermarked(raw)) push(raw);
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

function httpGet(rawUrl, options = {}) {
  return new Promise((resolve, reject) => {
    const timeout = options.timeout || 15000;
    const maxSize = options.maxSize || MAX_SIZE;
    let url;
    try { url = new URL(rawUrl); } catch { return reject(new Error('Invalid URL')); }
    const client = url.protocol === 'https:' ? https : http;
    const req = client.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15',
        'Referer': 'https://www.douyin.com/',
        ...(options.headers || {})
      }
    }, (res) => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
        return httpGet(res.headers.location, options).then(resolve).catch(reject);
      }
      if (res.statusCode !== 200) { res.resume(); return reject(new Error(`HTTP ${res.statusCode}`)); }
      if (options.responseType === 'arraybuffer') {
        let downloaded = 0;
        const chunks = [];
        res.on('data', c => {
          downloaded += c.length;
          if (downloaded > maxSize) {
            req.destroy();
            return reject(new Error(`文件过大 (${Math.round(downloaded/1024/1024)}MB)，超过 ${Math.round(maxSize/1024/1024)}MB 限制`));
          }
          chunks.push(c);
        });
        res.on('end', () => resolve(Buffer.concat(chunks)));
      } else {
        let downloaded = 0;
        const chunks = [];
        res.on('data', c => {
          downloaded += c.length;
          if (downloaded > maxSize) {
            req.destroy();
            return reject(new Error(`响应过大，超过 ${Math.round(maxSize/1024/1024)}MB 限制`));
          }
          chunks.push(c);
        });
        res.on('end', () => resolve({ body: Buffer.concat(chunks).toString('utf-8'), finalUrl: url.href }));
      }
    });
    req.on('error', reject);
    req.setTimeout(timeout, () => { req.destroy(); reject(new Error('timeout')); });
  });
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

    // 如果有 video_id 且最高画质 < 1080p 但用户要 1080p，主动构造一条直链试试
    if (result.videoId && targetRatio && /1080p|2k|4k/i.test(targetRatio) && (best.height || 0) < 1080) {
      const synth = `https://aweme.snssdk.com/aweme/v1/play/?video_id=${encodeURIComponent(result.videoId)}&ratio=${targetRatio}&line=0`;
      // 放在候选列表最前
      if (!result.videoCandidates.includes(synth)) {
        result.videoCandidates.unshift(synth);
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
 */
function deriveTargetRatio(quality, isVip) {
  // VIP 默认拉满（除非用户明确指定低画质）
  if (quality && typeof quality === 'string') {
    const m = quality.match(/height\s*<=\s*(\d+)/i);
    if (m) {
      const h = parseInt(m[1], 10);
      if (h >= 2160) return '4k';
      if (h >= 1440) return '2k';
      if (h >= 1080) return '1080p';
      if (h >= 720) return '720p';
      return '540p';
    }
    if (/4k|2160/i.test(quality)) return '4k';
    if (/2k|1440/i.test(quality)) return '2k';
    if (/1080/i.test(quality)) return '1080p';
    if (/720/i.test(quality)) return '720p';
  }
  return isVip ? '1080p' : '720p';
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
  const info = await parseDouyinPage(url, { targetRatio });
  if (onProgress) onProgress(30, '获取作品信息');

  console.log(`[douyin] Parsed: type=${info.type}, title="${(info.title||'').substring(0, 50)}", images=${info.images.length}, candidates=${info.videoCandidates.length}, target=${targetRatio}, parsedHeight=${info.height}`);

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
      console.log('[douyin] cover download failed:', e.message);
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
        console.error(`[douyin] image ${i + 1} failed:`, e.message);
      }
      if (onProgress) onProgress(30 + Math.round((i + 1) / info.images.length * 60), `下载图片 ${i + 1}/${info.images.length}`);
    }
    if (onProgress) onProgress(100, '完成');
    result.ext = 'note';
    return result;
  }

  // 3. 视频作品 → 按候选 URL 顺序尝试，第一个成功 + 通过 sanity 检查的就用
  if (info.videoCandidates.length > 0) {
    if (onProgress) onProgress(35, '下载视频');

    let videoBuf;
    let pickedUrl = '';
    let lastErr;
    let attempt = 0;
    const totalCandidates = info.videoCandidates.length;

    for (const candidate of info.videoCandidates) {
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
        console.log(`[douyin] video downloaded via candidate ${attempt}/${totalCandidates}${wm}: ${candidate.substring(0, 120)}`);
        break;
      } catch (e) {
        lastErr = e;
        console.log(`[douyin] candidate ${attempt}/${totalCandidates} failed: ${e.message} (${candidate.substring(0, 80)}...)`);
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
      console.warn(`[douyin] WARN: only watermarked source available for taskId=${taskId}; user may see watermark`);
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
  
  // Check if we have valid downloadable candidates
  const hasValidCandidates = info.videoCandidates && info.videoCandidates.length > 0;
  
  // Max showable quality: only trust metadata if we have valid download URLs
  const metaMaxHeight = allQualities.length > 0 ? allQualities[0].height : 1080;
  // Conservative: if no valid candidates, cap at 1080p (iesdouyin often shows fake 4K)
  const trustedMaxHeight = hasValidCandidates ? metaMaxHeight : Math.min(metaMaxHeight, 1080);
  
  // Build preset options from 540p up to trusted max
  const presets = [540, 720, 1080, 1920, 1440, 2160, 4320].filter(h => h <= trustedMaxHeight);
  const qualities = presets
    .map(h => ({
      quality: heightToLabel(h),
      format: 'mp4',
      width: Math.round(h * 9 / 16),
      height: h,
      hasVideo: true,
      hasAudio: true,
      size: 0
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

/**
 * X/Twitter 视频下载器
 *
 * 下载策略（按优先级）:
 *   1. cobalt（自托管实例，画质 = 推文原画，最高 1080p+）—— 当 COBALT_API_URL 已配置
 *   2. fxtwitter / vxtwitter 免费 API —— 兜底，画质受限（通常 540p–720p）
 *
 * cobalt 部署: 见 docs/COBALT_SETUP.md
 */

const https = require('https');
const http = require('http');
const { URL } = require('url');
const fs = require('fs');
const path = require('path');
const logger = require('../utils/logger');
const { isCobaltConfigured, downloadViaCobalt } = require('./cobalt');

function httpGet(rawUrl, options = {}) {
  return new Promise((resolve, reject) => {
    const timeout = options.timeout || 15000;
    let url;
    try { url = new URL(rawUrl); } catch { return reject(new Error('Invalid URL')); }
    const client = url.protocol === 'https:' ? https : http;
    const req = client.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15',
        ...(options.headers || {})
      }
    }, (res) => {
      const contentType = res.headers['content-type'] || '';
      // HTML or JSON typically means link expired/blocked
      if (contentType.includes('text/html') || contentType.includes('application/json')) {
        if (options.responseType === 'arraybuffer') {
          const chunks = [];
          res.on('data', c => chunks.push(c));
          res.on('end', () => {
            const buf = Buffer.concat(chunks);
            // Check if content is actually HTML
            const text = buf.slice(0, 1024).toString('utf8').trim();
            if (text.startsWith('<!DOCTYPE') || text.startsWith('<html')) {
              reject(new Error('Video link expired or blocked'));
            } else {
              resolve(buf);
            }
          });
        } else {
          const chunks = [];
          res.on('data', c => chunks.push(c));
          res.on('end', () => {
            const body = Buffer.concat(chunks).toString('utf-8');
            const text = body.slice(0, 1024).trim();
            if (text.startsWith('<!DOCTYPE') || text.startsWith('<html')) {
              reject(new Error('Video link expired or blocked'));
            } else {
              resolve({ body, finalUrl: url.href });
            }
          });
        }
        return;
      }

      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
        return httpGet(res.headers.location, options).then(resolve).catch(reject);
      }
      if (res.statusCode !== 200) { res.resume(); return reject(new Error(`HTTP ${res.statusCode}`)); }
      if (options.responseType === 'arraybuffer') {
        const chunks = [];
        res.on('data', c => chunks.push(c));
        res.on('end', () => resolve(Buffer.concat(chunks)));
      } else {
        const chunks = [];
        res.on('data', c => chunks.push(c));
        res.on('end', () => resolve({ body: Buffer.concat(chunks).toString('utf-8'), finalUrl: url.href }));
      }
    });
    req.on('error', reject);
    req.setTimeout(timeout, () => { req.destroy(); reject(new Error('timeout')); });
  });
}

/**
 * 从 X/Twitter URL 提取 tweet ID
 */
function extractTweetId(url) {
  // x.com/user/status/123 or twitter.com/user/status/123 or x.com/i/status/123
  const m = url.match(/(?:twitter\.com|x\.com)\/(?:i\/)?(?:\w+\/)?status\/(\d+)/);
  return m ? m[1] : null;
}

/**
 * 通过 vxtwitter API 解析推文
 */
async function parseTweet(url) {
  const tweetId = extractTweetId(url);
  if (!tweetId) throw new Error('无法解析推文链接');

  // 先解析重定向拿到完整 URL（包含用户名）
  let fullUrl;
  try {
    const res = await httpGet(url);
    fullUrl = res.finalUrl || url;
  } catch { fullUrl = url; }

  // 提取用户名和 ID
  const match = fullUrl.match(/(?:twitter\.com|x\.com)\/(\w+)\/status\/(\d+)/);
  const username = match ? match[1] : 'i';
  const id = match ? match[2] : tweetId;

  // fxtwitter API（优先使用，更稳定）
  // 注意：fxtwitter 和 vxtwitter 都是免费 API，画质都是中等（540p-720p）
  // 不再 fallback 到 vxtwitter，因为两者画质相同
  const apiUrl = `https://api.fxtwitter.com/${username}/status/${id}`;

  try {
    const res = await httpGet(apiUrl, { timeout: 10000 });
    const data = JSON.parse(res.body);

    // fxtwitter 格式：data.tweet.media.all[]
    const tweetMedia = data.tweet?.media?.all || [];
    const legacyMedia = data.media_extended || data.media || [];
    const legacyVideos = data.videos || [];

    const result = {
      tweetId: id,
      author: username,
      title: data.text || data.tweet?.text || data.tweet?.raw_text?.text || '',
      tweetUrl: data.tweetURL || fullUrl,
      videoUrl: '',
      videoUrls: [],
      coverUrl: '',
      images: [],
      videoQuality: 'medium',  // 标注画质级别：免费 API 只能获取中等画质
    };

      // 提取视频 - fxtwitter 格式（优先）
      for (const m of tweetMedia) {
        if (m.type === 'video' || m.type === 'video/mp4') {
          // fxtwitter 直接在 media 对象提供 url（通常是最高画质）
          // 同时检查 formats 中的 mp4 变体
          const formats = m.formats || [];
          const mp4Variants = formats.filter(f => f.container === 'mp4' || f.type === 'video/mp4');
          
          // 优先使用 direct url（最高画质），其次从 formats 选最高码率
          if (m.url && m.url.includes('.mp4')) {
            result.videoUrls.push({
              url: m.url,
              type: 'video',
              width: m.width || 1920,
              height: m.height || 1080,
              thumbnail_url: m.thumbnail_url || '',
              bitrate: m.bitrate || 0,
            });
          }
          
          // 从 formats 中提取 mp4 视频
          for (const f of mp4Variants) {
            if (f.url) {
              result.videoUrls.push({
                url: f.url,
                type: 'video',
                width: f.width || m.width || 0,
                height: f.height || m.height || 0,
                thumbnail_url: m.thumbnail_url || '',
                bitrate: f.bitrate || f.quality || 0,
              });
            }
          }
        }
        if (m.type === 'photo' || m.type === 'image') {
          result.images.push(m.url || m.media_url || '');
        }
      }

      // 提取视频 - legacy media_extended 格式
      for (const m of legacyMedia) {
        if (m.type === 'video') {
          result.videoUrls.push({
            url: m.url,
            type: m.type,
            width: m.width || 0,
            height: m.height || 0,
            thumbnail_url: m.thumbnail_url || m.thumbnailUrl || '',
          });
        }
        if (m.type === 'image') {
          result.images.push(m.url);
        }
      }

      // 提取视频 - legacy videos 格式（vxtwitter）
      for (const v of legacyVideos) {
        result.videoUrls.push({
          url: v.url,
          type: v.type || 'video',
          bitrate: v.bitrate || 0,
        });
      }

      // 选择最高清视频
      if (result.videoUrls.length > 0) {
        // 按分辨率*码率排序，取最高
        result.videoUrls.sort((a, b) => {
          const scoreA = (a.width || 0) * (a.height || 0) * (a.bitrate || 0);
          const scoreB = (b.width || 0) * (b.height || 0) * (b.bitrate || 0);
          return scoreB - scoreA;
        });
        result.videoUrl = result.videoUrls[0].url;
      
      // 提取 m3u8 URL（HLS 流，可能有更高画质）
      for (const f of (tweetMedia[0]?.formats || [])) {
        if (f.container === 'm3u8' && f.url) {
          result.m3u8Url = f.url.startsWith('http') ? f.url : 'https://video.twimg.com' + f.url;
        }
      }
      }

      // 封面
      if (!result.coverUrl) {
        const mediaItem = tweetMedia[0] || {};
        result.coverUrl = mediaItem.thumbnail_url || mediaItem.thumbnailUrl || '';
      }
      if (!result.coverUrl && data.tweet?.card) {
        result.coverUrl = data.tweet.card.binding_values?.thumbnail_image_original?.url || '';
      }

      if (result.videoUrls.length === 0 && result.images.length === 0) {
        throw new Error('该推文没有视频或图片');
      }

      return result;
    } catch (e) {
      console.error(`[x-download] fxtwitter API failed:`, e.message);
      throw new Error(`推文解析失败（免费 API 画质受限）: ${e.message}`);
    }
}

/**
 * 通过 cobalt 下载（高清优先路径）
 * 失败时返回 null，由调用方 fallback 到 fxtwitter
 */
async function tryDownloadViaCobalt(url, taskId, onProgress) {
  if (!isCobaltConfigured()) return null;
  try {
    const cobaltResult = await downloadViaCobalt(url, taskId, {
      onProgress,
      options: { videoQuality: 'max', filenameStyle: 'basic', downloadMode: 'auto' },
    });

    // 仍尝试解析 fxtwitter 拿元数据（标题、作者、封面），但不阻塞主流程
    let meta = {};
    try {
      const info = await Promise.race([
        parseTweet(url),
        new Promise((resolve) => setTimeout(() => resolve(null), 5000)),
      ]);
      if (info) {
        meta = {
          title: info.author ? `${info.author}: ${(info.title || '').substring(0, 80)}` : '',
          width: info.videoUrls && info.videoUrls[0] ? info.videoUrls[0].width : 0,
          height: info.videoUrls && info.videoUrls[0] ? info.videoUrls[0].height : 0,
        };
        // 同步下载封面
        if (info.coverUrl) {
          try {
            const buf = await httpGet(info.coverUrl, { responseType: 'arraybuffer', timeout: 15000 });
            const downloadDir = path.dirname(cobaltResult.filePath || path.join(__dirname, '../../downloads'));
            const coverPath = path.join(downloadDir, `${taskId}_thumb.jpg`);
            fs.writeFileSync(coverPath, buf);
            meta.thumbnailUrl = `/download/${taskId}_thumb.jpg`;
          } catch (_) { /* cover optional */ }
        }
      }
    } catch (_) { /* meta optional */ }

    if (cobaltResult.isPicker) {
      // 图集
      return {
        title: meta.title || `X Post ${taskId}`,
        duration: 0,
        thumbnailUrl: meta.thumbnailUrl || '',
        subtitleFiles: [],
        isNote: true,
        images: cobaltResult.images,
        ext: 'images',
        videoQuality: 'cobalt',
      };
    }

    return {
      title: meta.title || `X Video ${taskId}`,
      duration: 0,
      thumbnailUrl: meta.thumbnailUrl || '',
      subtitleFiles: [],
      filePath: cobaltResult.filePath,
      ext: cobaltResult.ext,
      downloadUrl: cobaltResult.downloadUrl,
      width: meta.width || 0,
      height: meta.height || 0,
      quality: meta.height ? `${meta.height}p` : 'hd',
      videoQuality: 'cobalt',
    };
  } catch (e) {
    logger.warn(`[x-download] cobalt path failed, will fallback to fxtwitter: ${e.message}`);
    return null;
  }
}

/**
 * 下载 X/Twitter 视频
 *   优先 cobalt（自托管，高画质），失败回落到 fxtwitter
 */
async function downloadX(url, taskId, onProgress) {
  const downloadDir = path.join(__dirname, '../../downloads');
  if (!fs.existsSync(downloadDir)) fs.mkdirSync(downloadDir, { recursive: true });

  if (onProgress) onProgress(2);

  // 路径 1: cobalt（高清）
  const cobaltResult = await tryDownloadViaCobalt(url, taskId, onProgress);
  if (cobaltResult) {
    if (onProgress) onProgress(100);
    return cobaltResult;
  }

  // 路径 2: fxtwitter 兜底（画质受限）
  if (onProgress) onProgress(5);
  const info = await parseTweet(url);
  if (onProgress) onProgress(25);

  const result = {
    title: `${info.author}: ${info.title.substring(0, 80)}`,
    duration: 0,
    thumbnailUrl: '',
    subtitleFiles: [],
  };

  // 下载封面
  if (info.coverUrl) {
    try {
      console.log(`[X] Downloading thumbnail: ${info.coverUrl.substring(0, 80)}...`);
      const buf = await httpGet(info.coverUrl, { responseType: 'arraybuffer', timeout: 15000 });
      const coverPath = path.join(downloadDir, `${taskId}_thumb.jpg`);
      fs.writeFileSync(coverPath, buf);
      result.thumbnailUrl = `/download/${taskId}_thumb.jpg`;
      console.log(`[X] Thumbnail saved: ${result.thumbnailUrl}`);
    } catch (e) {
      console.error(`[X] Thumbnail download failed: ${e.message}`);
    }
  } else {
    console.log(`[X] No cover URL found for tweet`);
  }

  // 下载视频（优先 mp4 直接下载，速度快）
  const videoUrl = info.videoUrl || (info.videoUrls && info.videoUrls[0]?.url) || '';
  const m3u8Url = info.m3u8Url || '';
  
  if (videoUrl && videoUrl.startsWith('http')) {
    if (onProgress) onProgress(30, '下载视频');
    try {
      const buf = await httpGet(videoUrl, { responseType: 'arraybuffer', timeout: 120000 });
      if (!buf || buf.length === 0) {
        throw new Error('视频内容为空');
      }
      const filename = `${taskId}.mp4`;
      const filepath = path.join(downloadDir, filename);
      fs.writeFileSync(filepath, buf);
      result.filePath = filepath;
      result.ext = 'mp4';
      result.downloadUrl = `/download/${filename}`;
      result.width = info.width || 0;
      result.height = info.height || 0;
      result.quality = `${result.height || 0}p`;
      if (onProgress) onProgress(100);
      return result;
    } catch (downloadErr) {
      console.error('[X] mp4 download failed, trying m3u8:', downloadErr.message);
      // Fallback: m3u8 HLS 下载
      if (m3u8Url && m3u8Url.startsWith('http')) {
        try {
          const filename = taskId + '.mp4';
          const filepath = path.join(downloadDir, filename);
          const { spawn } = require('child_process');
          await new Promise((resolve, reject) => {
            const ff = spawn('ffmpeg', ['-i', m3u8Url, '-c', 'copy', '-bsf:a', 'aac_adtstoasc', '-y', filepath]);
            const timer = setTimeout(() => { ff.kill('SIGKILL'); reject(new Error('timeout')); }, 45000);
            ff.on('close', code => { clearTimeout(timer); code === 0 ? resolve() : reject(new Error('ffmpeg exit ' + code)); });
            ff.on('error', err => { clearTimeout(timer); reject(err); });
          });
          const stat = fs.statSync(filepath);
          if (stat.size > 0) {
            result.filePath = filepath; result.ext = 'mp4';
            result.downloadUrl = '/download/' + filename;
            if (onProgress) onProgress(100);
            return result;
          }
        } catch (e) {
          console.error('[X] m3u8 fallback also failed:', e.message);
        }
      }
      // 继续尝试图片下载
    }
  } else {
    console.log(`[X] No valid video URL found`);
  }

  // 下载图片
  if (info.images.length > 0) {
    result.isNote = true;
    result.images = [];
    for (let i = 0; i < info.images.length; i++) {
      try {
        const buf = await httpGet(info.images[i], { responseType: 'arraybuffer', timeout: 30000 });
        const filename = `${taskId}_${i + 1}.jpg`;
        const filepath = path.join(downloadDir, filename);
        fs.writeFileSync(filepath, buf);
        result.images.push({ filename, path: filepath, url: `/download/${filename}` });
      } catch (e) {
        console.error(`[x-download] image ${i + 1} failed:`, e.message);
      }
      if (onProgress) onProgress(25 + Math.round((i + 1) / info.images.length * 70));
    }
    result.ext = 'images';
    if (onProgress) onProgress(100);
    return result;
  }

  throw new Error('没有可下载的媒体');
}

function isXUrl(url) {
  return /twitter\.com|x\.com/.test(url);
}

module.exports = { downloadX, parseTweet, isXUrl };

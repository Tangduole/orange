/**
 * yt-dlp 下载服务封装 v2
 * 
 * 修复项：
 * 1. 用 spawn 替代 execFile，支持实时进度推送
 * 2. 修复 filePath const 赋值 bug
 * 3. 支持封面提取
 * 4. 支持字幕提取
 */

const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const EventEmitter = require('events');

// 下载目录
const DOWNLOAD_DIR = path.join(__dirname, '../../downloads');

// 确保下载目录存在
if (!fs.existsSync(DOWNLOAD_DIR)) {
  fs.mkdirSync(DOWNLOAD_DIR, { recursive: true });
}

/**
 * 使用 yt-dlp 下载视频（支持实时进度）
 * @param {string} url 视频链接
 * @param {string} taskId 任务 ID
 * @param {function} onProgress 进度回调 (percent: number, speed: string, eta: string, downloaded: number, total: number) => void
 * @returns {Promise<{title: string, filePath: string, ext: string, thumbnailUrl: string, duration: number}>}
 */
function download(url, taskId, onProgress, quality = null) {
  return new Promise((resolve, reject) => {
    const outputTemplate = path.join(DOWNLOAD_DIR, `${taskId}.%(ext)s`);
    const thumbnailPath = path.join(DOWNLOAD_DIR, `${taskId}_thumb.jpg`);

    // 判断是否为 Bilibili
    const isBilibili = /bilibili\.com|b23\.tv/i.test(url);
    
    const args = [
      '--no-warnings',
      '--newline',              // 每行输出用于解析进度
      '--progress',             // 启用进度输出
      '--ignore-errors',
      '--retries', '5',
      '--fragment-retries', '5',
      '--socket-timeout', '60',
      '--no-check-certificates',
    ];
    
    // YouTube 专用参数
    if (/youtube\.com|youtu\.be/i.test(url)) {
      args.push('--extractor-args', 'youtube:player_client=android');
    }
    
    // Bilibili 专用参数
    if (isBilibili) {
      args.push('--referer', 'https://www.bilibili.com');
      args.push('--extractor-args', 'bilibili:prefer_multi_flv=true');
    }
    
    args.push(
      '--user-agent', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      '--format', quality || 'bestvideo[ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4]/best',
      '--write-thumbnail',      // 下载封面
      '--write-auto-subs',      // 下载自动字幕
      '--sub-langs', 'zh-Hans,zh-Hant,en',
      '--sub-format', 'srt',
      '--output', outputTemplate,
      '--merge-output-format', 'mp4',
      url
    );

    console.log(`[yt-dlp] Starting download: ${url} (taskId: ${taskId})`);

    let title = '';
    let duration = 0;
    let ext = 'mp4';
    let thumbnailUrl = '';
    let stderr = '';

    const proc = spawn('yt-dlp', args, { stdio: ['pipe', 'pipe', 'pipe'] });

    proc.stdout.on('data', (data) => {
      const lines = data.toString().split('\n');
      for (const line of lines) {
        // 解析标题
        const titleMatch = line.match(/^\[info\] Title: (.+)$/);
        if (titleMatch) title = titleMatch[1];

        // 解析时长
        const durationMatch = line.match(/^\[info\] Duration: (\d+):(\d+):(\d+)/);
        if (durationMatch) {
          duration = parseInt(durationMatch[1]) * 3600 + parseInt(durationMatch[2]) * 60 + parseInt(durationMatch[3]);
        }
      }
    });

    proc.stderr.on('data', (data) => {
      stderr += data.toString();
      const lines = data.toString().split('\n');
      for (const line of lines) {
        // 解析下载进度行（yt-dlp --progress 格式）
        // 格式: [download]  45.2% of ~123.45MiB at 5.67MiB/s ETA 00:15
        const progressMatch = line.match(/\[download\]\s+([\d.]+)%\s+of\s+~?([\d.]+)(\w+)\s+at\s+([\d.]+\w+\/s).*?ETA\s+(\S+)/);
        if (progressMatch && onProgress) {
          const percent = parseFloat(progressMatch[1]);
          const size = parseFloat(progressMatch[2]);
          const unit = progressMatch[3].toUpperCase();
          const speed = progressMatch[4];
          const eta = progressMatch[5];
          
          // 转换为字节
          let totalBytes = size;
          if (unit === 'KIB' || unit === 'KB') totalBytes *= 1024;
          else if (unit === 'MIB' || unit === 'MB') totalBytes *= 1024 * 1024;
          else if (unit === 'GIB' || unit === 'GB') totalBytes *= 1024 * 1024 * 1024;
          
          const downloadedBytes = Math.round(totalBytes * percent / 100);
          
          // 映射到 0-90 的范围（留 10 给后续处理）
          onProgress(Math.round(percent * 0.9), speed, eta, downloadedBytes, totalBytes);
        }

        // 解析合并进度
        const mergeMatch = line.match(/\[Merger\]\s+Merging formats/i);
        if (mergeMatch && onProgress) {
          onProgress(92, '', '');
        }

        const subtitleMatch = line.match(/\[info\] Writing video subtitles/i);
        if (subtitleMatch && onProgress) {
          onProgress(95, '', '');
        }
      }
    });

    proc.on('close', (code) => {
      if (code !== 0 && !fs.existsSync(path.join(DOWNLOAD_DIR, `${taskId}.mp4`))) {
        // 尝试查找任何生成的文件
        const files = fs.readdirSync(DOWNLOAD_DIR).filter(f => f.startsWith(taskId) && !f.includes('_thumb'));
        if (files.length === 0) {
          console.error(`[yt-dlp] Error (code ${code}): ${stderr}`);
          reject(new Error(`yt-dlp download failed: ${stderr.substring(0, 500)}`));
          return;
        }
      }

      // 查找实际下载的视频文件
      let filePath;
      const videoFiles = fs.readdirSync(DOWNLOAD_DIR).filter(
        f => f.startsWith(taskId) && !f.includes('_thumb') && !f.endsWith('.srt') && !f.endsWith('.vtt')
      );

      if (videoFiles.length > 0) {
        const actualFile = videoFiles[0];
        ext = path.extname(actualFile).slice(1);
        filePath = path.join(DOWNLOAD_DIR, actualFile);
      } else {
        reject(new Error('Downloaded file not found'));
        return;
      }

      // 查找封面（yt-dlp 可能保存为不同格式）
      const thumbnailFiles = fs.readdirSync(DOWNLOAD_DIR).filter(
        f => f.startsWith(taskId) && (f.endsWith('.jpg') || f.endsWith('.webp') || f.endsWith('.png'))
      );
      if (thumbnailFiles.length > 0) {
        const thumbFile = thumbnailFiles[0];
        thumbnailUrl = `/download/${thumbFile}`;
      }

      // 查找字幕
      const subtitleFiles = fs.readdirSync(DOWNLOAD_DIR).filter(
        f => f.startsWith(taskId) && (f.endsWith('.srt') || f.endsWith('.vtt'))
      );

      console.log(`[yt-dlp] Download complete: ${filePath}`);

      if (onProgress) onProgress(100, '', '');

      resolve({
        title: title || 'unknown',
        filePath,
        ext,
        thumbnailUrl,
        subtitleFiles: subtitleFiles.map(f => ({
          filename: f,
          path: path.join(DOWNLOAD_DIR, f),
          url: `/download/${f}`
        })),
        duration
      });
    });

    proc.on('error', (err) => {
      console.error(`[yt-dlp] Spawn error: ${err.message}`);
      reject(new Error(`yt-dlp not found or failed to start: ${err.message}`));
    });
  });
}

/**
 * 仅获取视频信息（不下载）
 * @param {string} url
 * @returns {Promise<{title: string, duration: number, thumbnail: string, formats: Array}>}
 */
function getInfo(url) {
  return new Promise((resolve, reject) => {
    const args = [
      '--dump-json',
      '--no-warnings',
      url
    ];

    let stdout = '';
    let stderr = '';

    const proc = spawn('yt-dlp', args);
    proc.stdout.on('data', (data) => { stdout += data.toString(); });
    proc.stderr.on('data', (data) => { stderr += data.toString(); });

    proc.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(`yt-dlp info failed: ${stderr.substring(0, 500)}`));
        return;
      }
      try {
        const info = JSON.parse(stdout);
        resolve({
          title: info.title || 'unknown',
          description: info.description || '',
          duration: info.duration || 0,
          thumbnail: info.thumbnail || '',
          uploader: info.uploader || '',
          uploadDate: info.upload_date || '',
          viewCount: info.view_count || 0,
          formats: (info.formats || []).map(f => ({
            formatId: f.format_id,
            ext: f.ext,
            resolution: f.resolution || `${f.width}x${f.height}`,
            filesize: f.filesize || f.filesize_approx || 0,
            format: f.format || ''
          }))
        });
      } catch (e) {
        reject(new Error(`Failed to parse yt-dlp output: ${e.message}`));
      }
    });

    proc.on('error', reject);
  });
}

/**
 * 提取音频为 MP3（使用 fluent-ffmpeg，更可靠）
 */
function extractAudio(inputPath, outputPath) {
  return new Promise((resolve, reject) => {
    const ffmpeg = require('fluent-ffmpeg');
    ffmpeg(inputPath)
      .noVideo()
      .audioCodec('libmp3lame')
      .audioBitrate('128k')
      .output(outputPath)
      .on('end', () => resolve(outputPath))
      .on('error', (err) => reject(new Error(`FFmpeg audio extraction failed: ${err.message}`)))
      .run();
  });
}

function getDownloadPath(taskId, ext = 'mp4') {
  return path.join(DOWNLOAD_DIR, `${taskId}.${ext}`);
}

/**
 * Invidious YouTube 备用下载方案
 */
async function downloadViaInvidious(url, taskId, onProgress) {
  const https = require('https');
  const http = require('http');

  const instances = [
    'https://invidious.fdn.fr',
    'https://inv.nadeko.net',
    'https://invidious.nerdvpn.de',
    'https://inv.tux.pizza',
  ];

  const videoIdMatch = url.match(/(?:v=|youtu\.be\/|shorts\/)([a-zA-Z0-9_-]{11})/);
  if (!videoIdMatch) throw new Error('Invalid YouTube URL');
  const videoId = videoIdMatch[1];

  console.log(`[Invidious] Downloading YouTube video: ${videoId}`);

  for (const instance of instances) {
    try {
      console.log(`[Invidious] Trying: ${instance}`);
      const apiUrl = `${instance}/api/v1/videos/${videoId}`;

      const info = await new Promise((resolve, reject) => {
        const proto = apiUrl.startsWith('https') ? https : http;
        proto.get(apiUrl, { timeout: 15000 }, (res) => {
          let data = '';
          res.on('data', chunk => data += chunk);
          res.on('end', () => {
            try { resolve(JSON.parse(data)); }
            catch (e) { reject(new Error('Parse failed')); }
          });
        }).on('error', reject);
      });

      const formats = (info.formatStreams || [])
        .filter(f => f.container === 'mp4' && f.url)
        .sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0));

      if (formats.length === 0) continue;

      const downloadUrl = formats[0].url;
      console.log(`[Invidious] Downloading: ${info.title}`);

      const outputPath = path.join(DOWNLOAD_DIR, `${taskId}.mp4`);
      await new Promise((resolve, reject) => {
        const file = fs.createWriteStream(outputPath);
        const proto = downloadUrl.startsWith('https') ? https : http;
        proto.get(downloadUrl, { timeout: 120000 }, (res) => {
          const total = parseInt(res.headers['content-length'] || '0', 10);
          let downloaded = 0;
          res.on('data', (chunk) => {
            downloaded += chunk.length;
            if (total > 0 && onProgress) {
              onProgress(Math.round((downloaded / total) * 90), '', '');
            }
          });
          res.pipe(file);
          file.on('finish', () => {
            file.close();
            if (onProgress) onProgress(100, '', '');
            resolve();
          });
        }).on('error', (err) => {
          fs.unlink(outputPath, () => {});
          reject(err);
        });
      });

      // Download thumbnail
      let thumbnailUrl = '';
      if (info.videoThumbnails?.length > 0) {
        const thumb = info.videoThumbnails.find(t => t.quality === 'medium') || info.videoThumbnails[0];
        if (thumb?.url) {
          const thumbPath = path.join(DOWNLOAD_DIR, `${taskId}_thumb.jpg`);
          try {
            await new Promise((resolve, reject) => {
              const proto2 = thumb.url.startsWith('https') ? https : http;
              proto2.get(thumb.url, { timeout: 10000 }, (res) => {
                const f = fs.createWriteStream(thumbPath);
                res.pipe(f);
                f.on('finish', () => { f.close(); resolve(); });
              }).on('error', reject);
            });
            thumbnailUrl = `/download/${taskId}_thumb.jpg`;
          } catch {}
        }
      }

      console.log(`[Invidious] Complete: ${taskId}.mp4`);
      return {
        title: info.title || 'unknown',
        filePath: outputPath,
        ext: 'mp4',
        thumbnailUrl,
        subtitleFiles: [],
        duration: info.lengthSeconds ? parseInt(info.lengthSeconds) : 0
      };

    } catch (err) {
      console.error(`[Invidious] Failed: ${err.message}`);
      continue;
    }
  }
  throw new Error('All Invidious instances failed');
}

module.exports = { download, getInfo, extractAudio, getDownloadPath, downloadViaInvidious, DOWNLOAD_DIR };

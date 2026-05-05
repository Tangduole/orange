/**
 * 视频信息控制器 - 画质解析 & 元数据
 *
 * 提取自 download.js，降低单体文件复杂度。
 * 负责 /api/video-info 端点的画质查询逻辑。
 */

const { heightToLabel, formatSize, detectPlatform } = require('../utils/media');
const logger = require('../utils/logger');
const cacheManager = require('../utils/cacheManager');
const {
  RESPONSE_CODE,
  HTTP_STATUS,
} = require('../config/constants');

const API_KEY_DOUYIN = process.env.TIKHUB_API_KEY_DOUYIN;

// 使用 LRU 缓存管理器
function getCachedInfo(key, fetcher) {
  return cacheManager.getOrSet(key, fetcher, 'info');
}

/**
 * 获取视频信息和可用画质
 */
async function getVideoInfo(req, res) {
  try {
    const { url } = req.body;
    if (!url) return res.status(400).json({ code: -1, message: 'URL required' });

    const platform = detectPlatform(url);

    if (platform === 'youtube') {
      const videoIdMatch = url.match(/(?:v=|youtu\.be\/|shorts\/)([a-zA-Z0-9_-]{11})/);
      if (!videoIdMatch) return res.status(400).json({ code: -1, message: 'Invalid YouTube URL' });

      const videoId = videoIdMatch[1];

      let qualities = [];
      let title = 'YouTube Video';
      let thumbnail = '';
      let duration = 0;

      // 1. Try TikHub API first (1080p/2K/4K)
      try {
        const { tikhubRequest } = require('../services/tikhub');
        const YT_KEY = process.env.TIKHUB_API_KEY_YT;
        const cacheKeyTik = `yt-tikhub:${videoId}`;
        const data = await getCachedInfo(cacheKeyTik, async () => {
          return await tikhubRequest(
            `/api/v1/youtube/web/get_video_info?video_id=${videoId}&need_format=true`,
            YT_KEY
          );
        }, 'info');

        title = data.title || title;
        duration = data.lengthSeconds ? parseInt(data.lengthSeconds) : 0;
        const thumbs = data.thumbnails || [];
        thumbnail = thumbs.length > 0 ? thumbs[0].url : '';

        const videos = data.videos?.items || [];
        if (videos.length > 0) {
          const seen = new Set();
          qualities = videos
            .filter(v => v.url && v.height)
            .map(v => {
              const h = v.height || 0;
              return {
                quality: heightToLabel(h),
                format: v.extension || 'mp4',
                width: v.width || 0,
                height: h,
                hasVideo: true,
                hasAudio: v.hasAudio === undefined ? true : v.hasAudio,
                size: v.size || 0
              };
            })
            .filter(q => q.height > 0 && !seen.has(q.height) && seen.add(q.height))
            .sort((a, b) => b.height - a.height);
        }
      } catch (e) {
        logger.warn(`[video-info] YouTube TikHub failed for ${url}: ${e.message}`);
      }

      // 2. Fallback: yt-dlp if TikHub failed
      if (qualities.length === 0) {
        try {
          const ytdlp = require('../services/yt-dlp');
          const cacheKeyYt = `yt-dlp:${videoId}`;
          const ytInfo = await getCachedInfo(cacheKeyYt, async () => {
            return await ytdlp.getInfo(url);
          }, 'info');

          title = ytInfo.title || title;
          thumbnail = ytInfo.thumbnail || thumbnail;
          duration = ytInfo.duration || duration;

          if (ytInfo.formats && Array.isArray(ytInfo.formats)) {
            const seen = new Set();
            qualities = ytInfo.formats
              .filter(f => f.vcodec !== 'none' && f.height)
              .map(f => ({
                quality: heightToLabel(f.height),
                format: f.ext || 'mp4',
                width: f.width || 0,
                height: f.height,
                hasVideo: true,
                hasAudio: f.acodec !== 'none',
                size: f.filesize || f.filesize_approx || 0,
                formatId: f.format_id
              }))
              .filter(q => !seen.has(q.height) && seen.add(q.height))
              .sort((a, b) => (b.height || 0) - (a.height || 0));
          }
        } catch (e) {
          logger.warn(`[video-info] yt-dlp failed for ${url}: ${e.message}`);
        }
      }

      if (qualities.length === 0) {
        qualities = [{ quality: 'Best Available', format: 'mp4', width: 0, height: 720, hasVideo: true, hasAudio: true }];
      }

      return res.json({
        code: 0,
        data: { title, thumbnail, duration, platform: 'youtube', qualities }
      });
    }

    // For Douyin: TikHub for 1080p+, iesdouyin fallback
    if (platform === 'douyin') {
      try {
        let qualities = [];
        let title = 'Video';
        let thumbnail = '';
        let duration = 0;

        // 1. Try TikHub API first
        try {
          const { getDouyinQualities } = require('../services/tikhub');
          const tikhubInfo = await getCachedInfo('douyin-tikhub:' + url, async () => {
            return await getDouyinQualities(url);
          }, 'info');
          if (tikhubInfo.qualities?.length > 0) {
            qualities = tikhubInfo.qualities;
            title = tikhubInfo.title || title;
            thumbnail = tikhubInfo.thumbnail || thumbnail;
            duration = tikhubInfo.duration || duration;
          }
        } catch (e) {
          logger.warn('[video-info] Douyin TikHub error:', e.message);
        }

        // 2. Fallback: iesdouyin
        if (qualities.length === 0) {
          const { getDouyinVideoInfo } = require('../services/douyin');
          const douyinInfo = await getCachedInfo('douyin:' + url, async () => {
            return await getDouyinVideoInfo(url);
          }, 'info');
          qualities = douyinInfo.qualities || [];
          title = douyinInfo.title || title;
          thumbnail = douyinInfo.thumbnail || thumbnail;
          duration = douyinInfo.duration || duration;
        }

        if (qualities.length === 0) {
          qualities = [{ quality: 'Best Available', format: 'mp4', width: 1280, height: 720, hasVideo: true, hasAudio: true }];
        }

        return res.json({
          code: 0,
          data: { title, thumbnail, duration, platform: 'douyin', qualities }
        });
      } catch (e) {
        logger.warn('[video-info] Douyin error:', e.message);
      }
    }

    // For TikTok
    if (platform === 'tiktok') {
      try {
        const awemeIdMatch = url.match(/\/video\/(\d+)|\/note\/(\d+)/);
        if (awemeIdMatch) {
          const awemeId = awemeIdMatch[1] || awemeIdMatch[2];
          const { tikhubRequest } = require('../services/tikhub');
          const data = await getCachedInfo('tk:' + awemeId, async () => {
            return await tikhubRequest('/api/v1/tiktok/app/v3/fetch_one_video?aweme_id=' + awemeId, API_KEY_DOUYIN);
          }, 'info');
          const detail = data?.aweme_detail || {};
          const video = detail.video || {};
          const bitrates = video.bit_rate || [];
          const tkDuration = video.duration ? Math.floor(video.duration / 1000) : 0;
          const qualities = bitrates
            .filter(br => br.play_addr?.url_list?.[0])
            .map(br => {
              const bitrate = br.bit_rate || 0;
              const estSize = tkDuration && bitrate ? Math.round(tkDuration * bitrate / 8) : 0;
              return {
                quality: heightToLabel(br.play_addr?.height || 0),
                format: 'video/mp4',
                width: br.play_addr?.width || 0,
                height: br.play_addr?.height || 0,
                hasVideo: true,
                hasAudio: true,
                size: estSize
              };
            })
            .sort((a, b) => (b.height || 0) - (a.height || 0));
          const unique = [];
          const seen = new Set();
          for (const q of qualities) {
            if (!seen.has(q.height)) { seen.add(q.height); unique.push(q); }
          }
          return res.json({
            code: 0,
            data: {
              title: detail.desc || 'TikTok Video',
              thumbnail: video.cover?.url_list?.[0] || '',
              duration: video.duration ? Math.floor(video.duration / 1000) : 0,
              platform: 'tiktok',
              qualities: unique.length > 0 ? unique : [{ quality: '720p', format: 'mp4', width: 1280, height: 720, hasVideo: true, hasAudio: true }]
            }
          });
        }
      } catch (e) {
        logger.warn('[video-info] TikTok error:', e.message);
      }
    }

    // For Xiaohongshu
    if (platform === 'xiaohongshu' || /xiaohongshu\.com|xhslink\.com/i.test(url)) {
      try {
        const { tikhubRequest: xhsReq } = require('../services/tikhub');
        const xhsData = await getCachedInfo('xhs:' + url, async () => {
          return await xhsReq('/api/v1/xiaohongshu/web_v2/fetch_feed_notes_v3?short_url=' + encodeURIComponent(url));
        }, 'info');
        const note = xhsData.note || xhsData.data?.note || {};
        const xhsVideo = note.video || {};
        const media = xhsVideo.media || {};
        const stream = media.stream || {};
        const h264 = stream.h264 || [];

        if (h264.length > 0) {
          const validStreams = h264.filter(s => s.masterUrl).sort((a, b) => (b.avgBitrate || 0) - (a.avgBitrate || 0));
          const qualityMap = new Map();
          const qualities = [];

          for (const s of validStreams) {
            let h = s.height || 0;
            if (!h && s.definition) {
              const defMatch = String(s.definition).match(/(\d+)p?/i);
              if (defMatch) h = parseInt(defMatch[1]);
            }
            if (!h && s.avgBitrate) {
              const br = s.avgBitrate;
              if (br > 8000000) h = 2160;
              else if (br > 4000000) h = 1440;
              else if (br > 2000000) h = 1080;
              else if (br > 800000) h = 720;
              else h = 480;
            }
            if (h > 0 && !qualityMap.has(h)) {
              qualityMap.set(h, {
                quality: heightToLabel(h),
                format: 'mp4',
                width: s.width || Math.round(h * 9 / 16),
                height: h,
                hasVideo: true,
                hasAudio: true,
                size: (s.avgBitrate || 0) * (xhsVideo.capa?.duration || 10) / 8
              });
            }
          }

          const sorted = [...qualityMap.values()].sort((a, b) => b.height - a.height);
          for (const q of sorted) qualities.push(q);

          if (qualities.length <= 1) {
            const maxHeight = qualities.length > 0 ? qualities[0].height : 1080;
            const presets = [540, 720, 1080, 1440, 2160].filter(h => h <= maxHeight);
            for (const h of presets) {
              if (!qualityMap.has(h)) {
                qualities.push({
                  quality: heightToLabel(h),
                  format: 'mp4',
                  width: Math.round(h * 9 / 16),
                  height: h,
                  hasVideo: true,
                  hasAudio: true,
                  size: 0
                });
              }
            }
            qualities.sort((a, b) => b.height - a.height);
          }

          return res.json({
            code: 0,
            data: {
              title: note.title || 'Xiaohongshu Note',
              thumbnail: xhsVideo.image?.thumbnailFileid ? 'https://ci.xiaohongshu.com/' + xhsVideo.image.thumbnailFileid : '',
              duration: xhsVideo.capa?.duration || 0,
              platform: 'xiaohongshu',
              qualities: qualities.length > 0 ? qualities : [{ quality: 'Best', format: 'mp4', width: 0, height: 0, hasVideo: true, hasAudio: true }]
            }
          });
        }
      } catch (e) {
        logger.warn('[video-info] Xiaohongshu error:', e.message);
      }
    }

    // X/Twitter: single quality
    if (platform === 'x') {
      return res.json({
        code: 0,
        data: {
          title: 'X/Twitter Video',
          thumbnail: '',
          duration: 0,
          platform: 'x',
          qualities: [
            { quality: 'Best Available', format: 'mp4', width: 1280, height: 720, hasVideo: true, hasAudio: true }
          ]
        }
      });
    }

    const defaultQualities = [
      { quality: 'Best Available', format: 'mp4', width: 1280, height: 720, hasVideo: true, hasAudio: true }
    ];

    return res.json({
      code: 0,
      data: {
        title: 'Video',
        thumbnail: '',
        duration: 0,
        platform: platform || 'auto',
        qualities: defaultQualities
      }
    });
  } catch (e) {
    logger.error('[video-info] Error:', e.message);
    return res.status(HTTP_STATUS.INTERNAL_ERROR).json({ code: RESPONSE_CODE.ERROR, message: e.message });
  }
}

module.exports = { getVideoInfo };

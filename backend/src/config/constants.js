/**
 * 应用常量配置 - 消除魔法数字
 */

module.exports = {
  // 时间常量（毫秒）
  TIME: {
    ONE_SECOND: 1000,
    ONE_MINUTE: 60 * 1000,
    ONE_HOUR: 60 * 60 * 1000,
    ONE_DAY: 24 * 60 * 60 * 1000,
    ONE_WEEK: 7 * 24 * 60 * 60 * 1000
  },

  // 超时配置
  TIMEOUT: {
    FFMPEG: 30 * 1000,           // FFmpeg 处理超时：30秒
    DOWNLOAD: 120 * 1000,         // 下载超时：2分钟
    API_REQUEST: 30 * 1000,       // API 请求超时：30秒
    TASK_LOCK: 10 * 60 * 1000    // 任务锁超时：10分钟
  },

  // 文件大小限制
  FILE_SIZE: {
    MAX_VIDEO: 500 * 1024 * 1024,      // 最大视频：500MB
    MAX_RESPONSE: 50 * 1024 * 1024,    // 最大响应：50MB
    DISK_WARNING: 1024 * 1024 * 1024   // 磁盘警告：1GB
  },

  // 画质配置
  QUALITY: {
    HD_THRESHOLD: 720,           // 高清阈值：720p
    FULL_HD: 1080,               // 全高清：1080p
    UHD_2K: 1440,                // 2K：1440p
    UHD_4K: 2160                 // 4K：2160p
  },

  // 用户限额
  LIMITS: {
    FREE_DAILY: 3,               // 免费用户每日下载次数
    GUEST_DAILY: 3,              // 游客每日下载次数
    HD_TRIAL: 1,                 // 高清试用次数
    MAX_QUEUE: 10                // 最大队列长度
  },

  // 缓存配置
  CACHE: {
    INFO_TTL: 5 * 60 * 1000,     // 信息缓存：5分钟
    API_TTL: 10 * 60 * 1000,     // API缓存：10分钟
    MAX_INFO_ITEMS: 500,         // 最大信息缓存条目
    MAX_API_ITEMS: 200           // 最大API缓存条目
  },

  // 清理配置
  CLEANUP: {
    FILE_RETENTION: 24 * 60 * 60 * 1000,  // 文件保留：24小时
    TASK_RETENTION: 24 * 60 * 60 * 1000,  // 任务保留：24小时
    CLEANUP_INTERVAL: 60 * 60 * 1000,     // 清理间隔：1小时
    STALE_REF_AGE: 24 * 60 * 60 * 1000    // 过期引用：24小时
  },

  // 日志配置
  LOG: {
    MAX_FILE_SIZE: 5 * 1024 * 1024,  // 最大日志文件：5MB
    MAX_FILES: 5,                     // 最大日志文件数
    LEVEL: process.env.LOG_LEVEL || 'info'
  },

  // JWT配置
  JWT: {
    EXPIRES_IN: '30d',           // Token有效期：30天
    ALGORITHM: 'HS256'           // 加密算法
  },

  // 速率限制
  RATE_LIMIT: {
    WINDOW_MS: 15 * 60 * 1000,   // 时间窗口：15分钟
    MAX_REQUESTS: 100,            // 最大请求数
    DOWNLOAD_WINDOW: 60 * 1000,   // 下载窗口：1分钟
    DOWNLOAD_MAX: 10,             // 下载最大次数
    AUTH_WINDOW: 15 * 60 * 1000,  // 认证窗口：15分钟
    AUTH_MAX: 5,                  // 认证最大次数
    STRICT_WINDOW: 60 * 60 * 1000, // 严格限制窗口：1小时
    STRICT_MAX: 3                 // 严格限制次数
  },

  // 平台标识
  PLATFORM: {
    DOUYIN: 'douyin',
    TIKTOK: 'tiktok',
    YOUTUBE: 'youtube',
    X: 'x',
    INSTAGRAM: 'instagram',
    XIAOHONGSHU: 'xiaohongshu',
    BILIBILI: 'bilibili',
    KUAISHOU: 'kuaishou',
    AUTO: 'auto'
  },

  // 任务状态
  TASK_STATUS: {
    PENDING: 'pending',
    PARSING: 'parsing',
    DOWNLOADING: 'downloading',
    PROCESSING: 'processing', // 后处理（合并视频/音频、转码等）
    ASR: 'asr',
    COMPLETED: 'completed',
    ERROR: 'error',
    CANCELLED: 'cancelled'
  },

  // 用户等级
  USER_TIER: {
    FREE: 'free',
    PRO: 'pro'
  },

  // 订阅状态
  SUBSCRIPTION_STATUS: {
    ACTIVE: 'active',
    CANCELLED: 'cancelled',
    PAST_DUE: 'past_due',
    NONE: 'none'
  },

  // HTTP状态码
  HTTP_STATUS: {
    OK: 200,
    BAD_REQUEST: 400,
    UNAUTHORIZED: 401,
    FORBIDDEN: 403,
    NOT_FOUND: 404,
    TOO_MANY_REQUESTS: 429,
    INTERNAL_ERROR: 500,
    SERVICE_UNAVAILABLE: 503
  },

  // 响应代码
  RESPONSE_CODE: {
    SUCCESS: 0,
    ERROR: -1,
    INVALID_PARAM: 400,
    UNAUTHORIZED: 401,
    FORBIDDEN: 403,
    NOT_FOUND: 404,
    RATE_LIMIT: 429,
    SERVER_ERROR: 500
  }
};

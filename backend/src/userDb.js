/**
 * 用户数据库 v2 - Turso Cloud SQLite
 * 
 * 表结构：
 * - id: 用户ID
 * - email: 邮箱（唯一）
 * - password_hash: 加密密码
 * - tier: 'free' | 'pro'
 * - subscription_status: 'active' | 'cancelled' | 'past_due' | 'none'
 * - subscription_ends_at: 订阅到期时间
 * - lemon_customer_id: Lemon Squeezy 客户ID
 * - lemon_subscription_id: Lemon Squeezy 订阅ID
 * - daily_downloads: 今日下载次数
 * - last_download_reset: 上次重置日期
 * - created_at: 注册时间
 */

const { createClient } = require('@libsql/client');
const bcrypt = require('bcryptjs');

// 加载 .env 文件（必须在 createClient 之前）
(function loadEnv() {
  const fs = require('fs');
  const path = require('path');
  // 优先 backend/.env，其次项目根 .env
  const envPaths = [
    path.join(__dirname, '../.env'),
    path.join(__dirname, '../../.env'),
  ];
  for (const p of envPaths) {
    if (fs.existsSync(p)) {
      try { require('dotenv').config({ path: p }); break; } catch {}
    }
  }
})();

// 数据库连接 URL 解析
// 优先 TURSO_DATABASE_URL（云端），否则用本地 SQLite
// 本地路径可通过 LOCAL_DB_PATH 覆盖（建议指向代码目录之外，避免数据被打包/泄露）
function buildDbUrl() {
  if (process.env.TURSO_DATABASE_URL) return process.env.TURSO_DATABASE_URL;
  const local = process.env.LOCAL_DB_PATH || './data/users.db';
  const dbUrl = /^(file|libsql|wss?):/i.test(local) ? local : 'file:' + local;
  ensureLocalDbDir(dbUrl);
  return dbUrl;
}

function ensureLocalDbDir(dbUrl) {
  if (!dbUrl.startsWith('file:')) return;
  const fs = require('fs');
  const path = require('path');
  const dbPath = dbUrl.slice('file:'.length);
  if (!dbPath || dbPath === ':memory:') return;
  const dir = path.dirname(dbPath);
  if (dir && dir !== '.' && !fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

const db = createClient({
  url: buildDbUrl(),
  authToken: process.env.TURSO_AUTH_TOKEN,
});

function parseAiAnalysis(value) {
  if (!value) return null;
  try {
    const parsed = typeof value === 'string' ? JSON.parse(value) : value;
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

function getRewritePackCount(value) {
  const analysis = parseAiAnalysis(value);
  const packs = analysis?.rewritePacks;
  return packs && typeof packs === 'object' ? Object.keys(packs).length : 0;
}

// 免费用户每日下载次数限制
const FREE_DAILY_LIMIT = 3;
let asrLexiconReady = false;

async function ensureAsrLexiconTable() {
  if (asrLexiconReady) return;
  await db.execute({
    sql: `CREATE TABLE IF NOT EXISTS asr_lexicon (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id TEXT NOT NULL,
      term TEXT NOT NULL,
      language TEXT DEFAULT 'auto',
      category TEXT DEFAULT 'custom',
      created_at INTEGER DEFAULT (unixepoch()),
      UNIQUE(user_id, term, language)
    )`
  });
  await db.execute(`CREATE INDEX IF NOT EXISTS idx_asr_lexicon_user ON asr_lexicon(user_id, language, created_at DESC)`);
  asrLexiconReady = true;
}

/**
 * 统一判定一个 user 是否为 VIP（pro 权益生效中）
 * 规则：tier === 'pro' 且 status ∈ {active, past_due}
 *       且 subscription_ends_at 未过期（若设置了）
 */
function isVip(user) {
  if (!user) return false;
  if (user.tier !== 'pro') return false;
  if (user.subscription_status !== 'active' && user.subscription_status !== 'past_due' && user.subscription_status !== 'lifetime') {
    return false;
  }
  // 必须有有效的到期时间，否则认为是过期/测试账号
  if (!user.subscription_ends_at || Number(user.subscription_ends_at) <= 0) {
    return false;
  }
  // subscription_ends_at 是秒级时间戳，检查是否过期
  if (Number(user.subscription_ends_at) * 1000 < Date.now()) {
    return false;
  }
  return true;
}

function isBasic(user) {
  if (!user) return false;
  if (user.tier !== 'basic') return false;
  if (user.subscription_status !== 'active' && user.subscription_status !== 'past_due') return false;
  if (!user.subscription_ends_at || Number(user.subscription_ends_at) <= 0) return false;
  return Number(user.subscription_ends_at) * 1000 >= Date.now();
}

// 初始化表
async function initDb() {
  try {
    await db.execute(`
      CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY,
        email TEXT UNIQUE NOT NULL,
        password_hash TEXT NOT NULL,
        tier TEXT DEFAULT 'free',
        subscription_status TEXT DEFAULT 'none',
        subscription_ends_at INTEGER,
        lemon_customer_id TEXT,
        lemon_subscription_id TEXT,
        daily_downloads INTEGER DEFAULT 0,
        last_download_reset TEXT DEFAULT CURRENT_DATE,
        email_verified INTEGER DEFAULT 0,
        verification_token TEXT,
        verification_expires_at INTEGER,
        created_at INTEGER NOT NULL
      )
    `);
    await db.execute(`
      CREATE TABLE IF NOT EXISTS guest_downloads (
        ip TEXT PRIMARY KEY,
        download_date TEXT DEFAULT CURRENT_DATE,
        download_count INTEGER DEFAULT 0
      )
    `);
    
    // 密码重置令牌表
    await db.execute({
      sql: `CREATE TABLE IF NOT EXISTS password_resets (
        token TEXT PRIMARY KEY,
        email TEXT NOT NULL,
        expires_at INTEGER NOT NULL,
        created_at INTEGER DEFAULT (unixepoch())
      )`
    });

    // 下载历史表
    await db.execute(`
      CREATE TABLE IF NOT EXISTS download_history (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id TEXT,
        guest_ip TEXT,
        task_id TEXT NOT NULL,
        url TEXT NOT NULL,
        platform TEXT,
        title TEXT,
        thumbnail_url TEXT,
        duration INTEGER,
        is_favorite INTEGER DEFAULT 0,
        tags TEXT,
        notes TEXT,
        group_name TEXT,
        ai_analysis TEXT,
        created_at INTEGER NOT NULL
      )
    `);
    await db.execute(`CREATE INDEX IF NOT EXISTS idx_history_user ON download_history(user_id, created_at DESC)`);
    for (const statement of [
      `ALTER TABLE download_history ADD COLUMN is_favorite INTEGER DEFAULT 0`,
      `ALTER TABLE download_history ADD COLUMN tags TEXT`,
      `ALTER TABLE download_history ADD COLUMN notes TEXT`,
      `ALTER TABLE download_history ADD COLUMN group_name TEXT`,
      `ALTER TABLE download_history ADD COLUMN ai_analysis TEXT`,
    ]) {
      try { await db.execute({ sql: statement }); } catch (e) {}
    }
    
    // 迁移：添加邮箱验证相关列（如果不存在）
    try {
      await db.execute({
        sql: `ALTER TABLE users ADD COLUMN email_verified INTEGER DEFAULT 0`
      });
    } catch (e) {
      // 列可能已存在，忽略错误
    }
    try {
      await db.execute({
        sql: `ALTER TABLE users ADD COLUMN verification_token TEXT`
      });
    } catch (e) {}
    try {
      await db.execute({
        sql: `ALTER TABLE users ADD COLUMN verification_expires_at INTEGER`
      });
    } catch (e) {}
    
    // 迁移：添加推荐相关列
    try {
      await db.execute({
        sql: `ALTER TABLE users ADD COLUMN referrer_id TEXT`
      });
    } catch (e) {}
    try {
      await db.execute({
        sql: `ALTER TABLE users ADD COLUMN referral_bonus_expires INTEGER DEFAULT 0`
      });
    } catch (e) {}
    try {
      await db.execute({
        sql: `ALTER TABLE users ADD COLUMN referral_code TEXT`
      });
    } catch (e) {}
    // 高清试用次数
    try {
      await db.execute({
        sql: `ALTER TABLE users ADD COLUMN hd_trials_used INTEGER DEFAULT 0`
      });
    } catch (e) {}
    // JWT token 版本（密码重置后递增，使旧 token 失效）
    try {
      await db.execute({
        sql: `ALTER TABLE users ADD COLUMN token_version INTEGER DEFAULT 0`
      });
    } catch (e) {}
    
    // 推荐记录表
    await db.execute({
      sql: `CREATE TABLE IF NOT EXISTS referrals (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        referrer_id TEXT NOT NULL,
        referee_id TEXT NOT NULL,
        created_at INTEGER DEFAULT (unixepoch())
      )`
    });

    await db.execute({
      sql: `CREATE TABLE IF NOT EXISTS ai_usage (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id TEXT NOT NULL,
        task_id TEXT,
        feature TEXT NOT NULL,
        input_chars INTEGER DEFAULT 0,
        output_items INTEGER DEFAULT 0,
        created_at INTEGER DEFAULT (unixepoch())
      )`
    });
    await db.execute(`CREATE INDEX IF NOT EXISTS idx_ai_usage_user ON ai_usage(user_id, created_at DESC)`);

    await db.execute({
      sql: `CREATE TABLE IF NOT EXISTS ai_cache (
        cache_key TEXT PRIMARY KEY,
        feature TEXT NOT NULL,
        result TEXT NOT NULL,
        created_at INTEGER DEFAULT (unixepoch())
      )`
    });
    await db.execute(`CREATE INDEX IF NOT EXISTS idx_ai_cache_feature ON ai_cache(feature, created_at DESC)`);

    await db.execute({
      sql: `CREATE TABLE IF NOT EXISTS asr_lexicon (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id TEXT NOT NULL,
        term TEXT NOT NULL,
        language TEXT DEFAULT 'auto',
        category TEXT DEFAULT 'custom',
        created_at INTEGER DEFAULT (unixepoch()),
        UNIQUE(user_id, term, language)
      )`
    });
    await db.execute(`CREATE INDEX IF NOT EXISTS idx_asr_lexicon_user ON asr_lexicon(user_id, language, created_at DESC)`);

    await db.execute({
      sql: `CREATE TABLE IF NOT EXISTS batch_jobs (
        id TEXT PRIMARY KEY,
        user_id TEXT,
        type TEXT NOT NULL,
        status TEXT DEFAULT 'queued',
        total INTEGER DEFAULT 0,
        done INTEGER DEFAULT 0,
        success INTEGER DEFAULT 0,
        failed INTEGER DEFAULT 0,
        options TEXT,
        error TEXT,
        created_at INTEGER DEFAULT (unixepoch()),
        updated_at INTEGER DEFAULT (unixepoch())
      )`
    });
    await db.execute(`CREATE INDEX IF NOT EXISTS idx_batch_jobs_user ON batch_jobs(user_id, created_at DESC)`);
    await db.execute({
      sql: `CREATE TABLE IF NOT EXISTS batch_job_items (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        job_id TEXT NOT NULL,
        task_id TEXT,
        status TEXT DEFAULT 'queued',
        step TEXT,
        error TEXT,
        result TEXT,
        created_at INTEGER DEFAULT (unixepoch()),
        updated_at INTEGER DEFAULT (unixepoch())
      )`
    });
    await db.execute(`CREATE INDEX IF NOT EXISTS idx_batch_job_items_job ON batch_job_items(job_id, id)`);
    
    console.log('[userDb] Turso 数据库初始化完成');
  } catch (err) {
    console.error('[userDb] 初始化表失败:', err);
  }
}
initDb();

const userDb = {
  db,
  isVip,
  isBasic,

  /**
   * 创建用户
   */
  async create(email, password) {
    const id = require('uuid').v4();
    const passwordHash = bcrypt.hashSync(password, 10);
    const now = Date.now();
    
    try {
      await db.execute({
        sql: `INSERT INTO users (id, email, password_hash, created_at) VALUES (?, ?, ?, ?)`,
        args: [id, email.toLowerCase(), passwordHash, now]
      });
      return { id, email: email.toLowerCase(), tier: 'free', subscription_status: 'none' };
    } catch (e) {
      if (e.message.includes('UNIQUE')) {
        throw new Error('邮箱已被注册');
      }
      throw e;
    }
  },

  /**
   * 验证密码
   */
  async verifyPassword(email, password) {
    const result = await db.execute({
      sql: 'SELECT * FROM users WHERE email = ?',
      args: [email.toLowerCase()]
    });
    const user = result.rows[0];
    
    if (!user) return null;
    if (!bcrypt.compareSync(password, user.password_hash)) return null;
    
    return user;
  },

  /**
   * 根据ID获取用户
   */
  async getById(id) {
    const result = await db.execute({
      sql: 'SELECT * FROM users WHERE id = ?',
      args: [id]
    });
    return result.rows[0];
  },

  /**
   * 根据邮箱获取用户
   */
  async getByEmail(email) {
    const result = await db.execute({
      sql: 'SELECT * FROM users WHERE email = ?',
      args: [email.toLowerCase()]
    });
    return result.rows[0];
  },

  /**
   * 检查并重置每日下载次数（原子化：TOCTOU 防护）
   * 用一条 UPDATE 同时判断 last_download_reset 是否落后于今天，
   * 避免并发场景下 daily_downloads 被错误重置或漏重置。
   */
  async checkAndResetDaily(id) {
    const today = new Date().toISOString().split('T')[0];

    // 一次性原子重置：仅当 last_download_reset != today 时把次数清零
    await db.execute({
      sql: `UPDATE users
              SET daily_downloads = 0, last_download_reset = ?
            WHERE id = ?
              AND (last_download_reset IS NULL OR last_download_reset != ?)`,
      args: [today, id, today]
    });

    return this.getById(id);
  },

  /**
   * 增加下载次数（在下载流程"成功完成"后调用）
   * 同样使用一条 UPDATE 完成"重置 + 自增"，避免 race。
   */
  async incrementDownloads(id) {
    const today = new Date().toISOString().split('T')[0];

    // 同 SQL 内完成"如有必要先重置今日，再 +1"
    await db.execute({
      sql: `UPDATE users
              SET
                daily_downloads = CASE
                  WHEN last_download_reset IS NULL OR last_download_reset != ?
                    THEN 1
                  ELSE daily_downloads + 1
                END,
                last_download_reset = ?
            WHERE id = ?`,
      args: [today, today, id]
    });

    return this.getById(id);
  },

  /**
   * 获取用户使用量
   */
  async getUsage(id) {
    const user = await this.checkAndResetDaily(id);
    if (!user) return null;

    const vip = isVip(user);
    const basic = isBasic(user);
    let limit = vip ? -1 : (basic ? 30 : FREE_DAILY_LIMIT);

    // 推荐奖励：+5次/天（有效期内）
    const hasReferralBonus =
      !!user.referral_bonus_expires &&
      Number(user.referral_bonus_expires) > Date.now();
    if (!vip && hasReferralBonus) {
      limit += 5;
    }

    return {
      tier: user.tier,
      isPro: vip,
      isBasic: basic,
      dailyDownloads: user.daily_downloads || 0,
      dailyLimit: limit,
      remaining: limit === -1 ? -1 : Math.max(0, limit - (user.daily_downloads || 0)),
      hasReferralBonus,
      subscriptionStatus: user.subscription_status,
      subscriptionEndsAt: user.subscription_ends_at
    };
  },

  /**
   * 更新订阅状态
   */
  async updateSubscription(email, status, endsAt, lemonCustomerId, lemonSubscriptionId) {
    // 取消或过期时显式降级
    const newTier = (status === 'active' || status === 'past_due') ? 'pro' : 'free';
    await db.execute({
      sql: `UPDATE users SET 
        subscription_status = ?,
        subscription_ends_at = ?,
        lemon_customer_id = ?,
        lemon_subscription_id = ?,
        tier = ?
      WHERE email = ?`,
      args: [status, endsAt, lemonCustomerId, lemonSubscriptionId, newTier, email.toLowerCase()]
    });
  },

  /**
   * 升级为Pro
   */
  async upgradeToPro(email, endsAt) {
    await db.execute({
      sql: `UPDATE users SET tier = 'pro', subscription_status = 'active', subscription_ends_at = ? WHERE email = ?`,
      args: [endsAt, email.toLowerCase()]
    });
  },

  async upgradeToTier(email, tier, endsAt, status = 'active') {
    const safeTier = tier === 'basic' ? 'basic' : 'pro';
    await db.execute({
      sql: `UPDATE users SET tier = ?, subscription_status = ?, subscription_ends_at = ? WHERE email = ?`,
      args: [safeTier, status, endsAt, email.toLowerCase()]
    });
  },

  /**
   * 降级为Free
   */
  async downgradeToFree(email) {
    await db.execute({
      sql: `UPDATE users SET tier = 'free', subscription_status = 'cancelled' WHERE email = ?`,
      args: [email.toLowerCase()]
    });
  },

  /**
   * 更新密码
   */
  async updatePassword(email, passwordHash) {
    await db.execute({
      sql: 'UPDATE users SET password_hash = ? WHERE email = ?',
      args: [passwordHash, email.toLowerCase()]
    });
  },

  /**
   * 递增 token_version（密码重置后调用，使所有旧 JWT 失效）
   */
  async incrementTokenVersion(userId) {
    await db.execute({
      sql: 'UPDATE users SET token_version = token_version + 1 WHERE id = ?',
      args: [userId]
    });
  },

  /**
   * 存储密码重置令牌
   */
  async storeResetToken(token, email, expiresAt) {
    await db.execute({
      sql: 'INSERT OR REPLACE INTO password_resets (token, email, expires_at) VALUES (?, ?, ?)',
      args: [token, email.toLowerCase(), expiresAt]
    });
  },

  /**
   * 获取密码重置令牌
   */
  async getResetToken(token) {
    const result = await db.execute({
      sql: 'SELECT * FROM password_resets WHERE token = ?',
      args: [token]
    });
    const row = result.rows?.[0];
    if (!row) return null;
    // 检查是否过期
    if (Date.now() > row.expires_at) {
      await this.deleteResetToken(token);
      return null;
    }
    return row;
  },

  /**
   * 删除密码重置令牌
   */
  async deleteResetToken(token) {
    await db.execute({
      sql: 'DELETE FROM password_resets WHERE token = ?',
      args: [token]
    });
  },

  /**
   * 删除用户
   */
  async deleteUser(email) {
    await db.execute({
      sql: 'DELETE FROM users WHERE email = ?',
      args: [email.toLowerCase()]
    });
  },

  /**
   * 检查游客下载次数
   */
  async checkGuestDownload(ip) {
    if (!ip) return { allowed: true, remaining: -1 };
    
    try {
      const today = new Date().toISOString().split('T')[0];
      const result = await db.execute({
        sql: `SELECT download_count FROM guest_downloads WHERE ip = ? AND download_date = ?`,
        args: [ip, today]
      });
      
      const count = result.rows?.[0]?.download_count || 0;
      const limit = FREE_DAILY_LIMIT;
      const remaining = Math.max(0, limit - count);
      
      return {
        allowed: count < limit,
        remaining,
        limit
      };
    } catch (e) {
      console.error('[userDb] checkGuestDownload error:', e.message);
      // 数据库异常时拒绝访问，等恢复后再放行
      return { allowed: false, remaining: 0 };
    }
  },

  /**
   * 增加游客下载次数
   */
  async incrementGuestDownload(ip) {
    if (!ip) return;
    
    try {
      const today = new Date().toISOString().split('T')[0];
      await db.execute({
        sql: `INSERT INTO guest_downloads (ip, download_date, download_count) 
              VALUES (?, ?, 1) 
              ON CONFLICT(ip) DO UPDATE SET 
                download_count = CASE WHEN download_date = ? THEN download_count + 1 ELSE 1 END,
                download_date = ?`,
        args: [ip, today, today, today]
      });
    } catch (e) {
      console.error('[userDb] incrementGuestDownload error:', e);
    }
  },

  /**
   * 存储邮箱验证令牌
   */
  async storeVerificationToken(userId, token, expiresAt) {
    await db.execute({
      sql: `UPDATE users SET verification_token = ?, verification_expires_at = ? WHERE id = ?`,
      args: [token, expiresAt, userId]
    });
  },

  /**
   * 验证邮箱令牌
   */
  async verifyEmail(token) {
    const result = await db.execute({
      sql: 'SELECT * FROM users WHERE verification_token = ?',
      args: [token]
    });
    const user = result.rows?.[0];
    if (!user) {
      return { success: false, error: 'Invalid token' };
    }
    if (user.verification_expires_at < Date.now()) {
      return { success: false, error: 'Token expired' };
    }
    await db.execute({
      sql: `UPDATE users SET email_verified = 1, verification_token = NULL, verification_expires_at = NULL WHERE id = ?`,
      args: [user.id]
    });
    return { success: true, userId: user.id, email: user.email };
  },

  /**
   * 直接验证邮箱（不检查token，用于邮件发送失败时绕过验证）
   */
  async verifyEmailDirectly(userId) {
    await db.execute({
      sql: `UPDATE users SET email_verified = 1, verification_token = NULL, verification_expires_at = NULL WHERE id = ?`,
      args: [userId]
    });
    return { success: true };
  },

  /**
   * 检查邮箱是否已验证
   */
  async isEmailVerified(userId) {
    const user = await this.getById(userId);
    return user ? user.email_verified === 1 : false;
  },

  // ========== 推荐系统 ==========

  /**
   * 获取或生成推荐码
   * 规则：6 位大写字母+数字，从用户 UUID 中剥离掉非 [A-Z0-9] 字符后取前 6 位
   */
  async getReferralCode(userId) {
    const user = await this.getById(userId);
    if (!user) return null;
    if (user.referral_code) return user.referral_code;

    let raw = String(userId || '').replace(/[^a-zA-Z0-9]/g, '').toUpperCase();
    if (raw.length < 6) {
      // 极少数 UUID 格式异常时，用 crypto 兜底凑齐 6 位
      const crypto = require('crypto');
      raw += crypto.randomBytes(4).toString('hex').toUpperCase();
    }
    const code = raw.substring(0, 6);

    await db.execute({
      sql: 'UPDATE users SET referral_code = ? WHERE id = ?',
      args: [code, userId]
    });
    return code;
  },

  /**
   * 应用推荐码
   */
  async applyReferralCode(userId, code) {
    if (!code) return { success: false, error: '请输入推荐码' };
    
    const upperCode = code.toUpperCase().trim();
    
    // 查找推荐人
    const result = await db.execute({
      sql: 'SELECT id FROM users WHERE referral_code = ?',
      args: [upperCode]
    });
    const referrer = result.rows?.[0];
    if (!referrer) {
      return { success: false, error: '推荐码无效' };
    }
    if (referrer.id === userId) {
      return { success: false, error: '不能使用自己的推荐码' };
    }
    
    // 检查用户是否已有推荐人
    const user = await this.getById(userId);
    if (user.referrer_id) {
      return { success: false, error: '您已使用过推荐码' };
    }
    
    // 给双方加奖励：+5次/天，有效期30天
    const bonusExpires = Date.now() + 30 * 24 * 60 * 60 * 1000;
    await db.execute({
      sql: 'UPDATE users SET referrer_id = ?, referral_bonus_expires = ? WHERE id = ?',
      args: [referrer.id, bonusExpires, userId]
    });
    await db.execute({
      sql: 'UPDATE users SET referral_bonus_expires = ? WHERE id = ? AND (referral_bonus_expires IS NULL OR referral_bonus_expires < ?)',
      args: [bonusExpires, referrer.id, bonusExpires]
    });
    
    // 记录推荐
    await db.execute({
      sql: 'INSERT INTO referrals (referrer_id, referee_id) VALUES (?, ?)',
      args: [referrer.id, userId]
    });
    
    return { success: true };
  },

  /**
   * 获取推荐统计
   */
  async getReferralStats(userId) {
    const referralCode = await this.getReferralCode(userId);
    
    const result = await db.execute({
      sql: 'SELECT COUNT(*) as count FROM referrals WHERE referrer_id = ?',
      args: [userId]
    });
    const referredCount = result.rows?.[0]?.count || 0;
    
    // 检查当前奖励状态
    const user = await this.getById(userId);
    const hasBonus = user.referral_bonus_expires && user.referral_bonus_expires > Date.now();
    
    return {
      referralCode,
      referredCount,
      hasBonus,
      bonusExpiresAt: hasBonus ? user.referral_bonus_expires : null,
      bonusDownloads: 5 // +5次/天
    };
  },

  /**
   * 检查高清画质试用是否可用（只检查不扣除）
   * @returns true=试用可用, false=已用完或无需试用
   */
  async checkHdTrial(userId) {
    if (!userId) return false; // 游客不能试用
    
    const user = await this.getById(userId);
    if (!user) return false;
    if (isVip(user)) return true; // VIP 用户不需要试用
    
    const MAX_TRIALS = 1;
    return user.hd_trials_used < MAX_TRIALS;
  },

  /**
   * 使用高清画质试用（免费用户限1次）
   * @returns true=试用成功, false=试用已用完或无需试用
   */
  async useHdTrial(userId) {
    if (!userId) return false; // 游客不能试用
    
    const user = await this.getById(userId);
    if (!user) return false;
    if (isVip(user)) return true; // VIP 用户不需要试用
    
    const MAX_TRIALS = 1;
    if (user.hd_trials_used >= MAX_TRIALS) return false;
    
    await db.execute({
      sql: 'UPDATE users SET hd_trials_used = hd_trials_used + 1 WHERE id = ?',
      args: [userId]
    });
    return true;
  },

  // 下载历史
  async addHistory({ userId, guestIp, taskId, url, platform, title, thumbnailUrl, duration }) {
    await db.execute({
      sql: `INSERT INTO download_history (user_id, guest_ip, task_id, url, platform, title, thumbnail_url, duration, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, unixepoch())`,
      args: [userId || null, guestIp || null, taskId, url, platform || null, title || null, thumbnailUrl || null, duration || null]
    });
  },

  async getHistory(userId, guestIp, limit = 50, offset = 0) {
    const conditions = [];
    const args = [];
    if (userId) {
      conditions.push('user_id = ?');
      args.push(userId);
    } else if (guestIp) {
      conditions.push('guest_ip = ?');
      args.push(guestIp);
    } else {
      return [];
    }
    const where = conditions.join(' AND ');
    args.push(limit, offset);
    const result = await db.execute({
      sql: `SELECT * FROM download_history WHERE ${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`,
      args
    });
    return result.rows;
  },

  /**
   * 素材工作台服务端聚合统计
   */
  async getHistoryMeta(userId, guestIp) {
    if (!userId && !guestIp) return { tags: [], groups: [], platforms: [], favoritesCount: 0, aiCardsCount: 0, publishPacksCount: 0, publishPackItemsCount: 0, needsPublishPackCount: 0, total: 0 };
    const ownerCol = userId ? 'user_id' : 'guest_ip';
    const ownerVal = userId || guestIp;

    const [tagRows, groupRows, platformRows, countRow, favCount, aiRows] = await Promise.all([
      db.execute({ sql: `SELECT tags FROM download_history WHERE ${ownerCol} = ? AND tags IS NOT NULL AND tags != ''`, args: [ownerVal] }),
      db.execute({ sql: `SELECT group_name, COUNT(*) as cnt FROM download_history WHERE ${ownerCol} = ? AND group_name IS NOT NULL AND group_name != '' GROUP BY group_name ORDER BY cnt DESC`, args: [ownerVal] }),
      db.execute({ sql: `SELECT platform, COUNT(*) as cnt FROM download_history WHERE ${ownerCol} = ? AND platform IS NOT NULL GROUP BY platform ORDER BY cnt DESC`, args: [ownerVal] }),
      db.execute({ sql: `SELECT COUNT(*) as cnt FROM download_history WHERE ${ownerCol} = ?`, args: [ownerVal] }),
      db.execute({ sql: `SELECT COUNT(*) as cnt FROM download_history WHERE ${ownerCol} = ? AND is_favorite = 1`, args: [ownerVal] }),
      db.execute({ sql: `SELECT ai_analysis FROM download_history WHERE ${ownerCol} = ? AND ai_analysis IS NOT NULL AND ai_analysis != ''`, args: [ownerVal] }),
    ]);

    // 聚合标签（tags 可能是 JSON string）
    const tagMap = new Map();
    for (const row of tagRows.rows) {
      try {
        let parsed = row.tags;
        if (typeof parsed === 'string') parsed = JSON.parse(parsed);
        if (Array.isArray(parsed)) {
          for (const t of parsed) {
            const k = String(t).trim();
            if (k) tagMap.set(k, (tagMap.get(k) || 0) + 1);
          }
        }
      } catch { /* skip invalid tag row */ }
    }
    const tags = [...tagMap.entries()].map(([tag, count]) => ({ tag, count })).sort((a, b) => b.count - a.count);

    const groups = groupRows.rows.map(r => ({ group: r.group_name, count: r.cnt }));
    const groupedCount = groups.reduce((sum, item) => sum + (Number(item.count) || 0), 0);
    const ungroupedCount = Math.max(0, (countRow.rows[0]?.cnt || 0) - groupedCount);
    const platforms = platformRows.rows.map(r => ({ platform: r.platform, count: r.cnt }));
    const aiCardsCount = aiRows.rows.length;
    const publishPackItemsCount = aiRows.rows.filter(row => getRewritePackCount(row.ai_analysis) > 0).length;
    const publishPacksCount = aiRows.rows.reduce((sum, row) => sum + getRewritePackCount(row.ai_analysis), 0);
    const needsPublishPackCount = aiRows.rows.filter(row => getRewritePackCount(row.ai_analysis) === 0).length;

    return {
      tags,
      groups,
      ungroupedCount,
      platforms,
      favoritesCount: favCount.rows[0]?.cnt || 0,
      aiCardsCount,
      publishPacksCount,
      publishPackItemsCount,
      needsPublishPackCount,
      total: countRow.rows[0]?.cnt || 0,
    };
  },

  /**
   * 分页历史查询（支持搜索、筛选）
   */
  async getHistoryPage(userId, guestIp, filters = {}) {
    if (!userId && !guestIp) return { items: [], total: 0, page: 1, pageSize: 50, hasMore: false };
    const ownerCol = userId ? 'user_id' : 'guest_ip';
    const ownerVal = userId || guestIp;

    const { page = 1, pageSize = 50, search, status, platform, group, tag, favorite, aiOnly, publishPackOnly, needsPublishPack } = filters;
    const conditions = [`${ownerCol} = ?`];
    const args = [ownerVal];

    if (search) { conditions.push('(title LIKE ? OR url LIKE ? OR platform LIKE ? OR group_name LIKE ? OR notes LIKE ? OR tags LIKE ?)'); const s = `%${search}%`; args.push(s, s, s, s, s, s); }
    if (platform) { conditions.push('platform = ?'); args.push(platform); }
    if (group === '__ungrouped') {
      conditions.push("(group_name IS NULL OR group_name = '')");
    } else if (group) {
      conditions.push('group_name = ?');
      args.push(group);
    }
    if (tag) { conditions.push('tags LIKE ?'); args.push(`%${tag}%`); }
    if (favorite) { conditions.push('is_favorite = 1'); }
    if (aiOnly || publishPackOnly || needsPublishPack) { conditions.push("ai_analysis IS NOT NULL AND ai_analysis != ''"); }

    const where = conditions.join(' AND ');
    const safePage = Math.max(1, Number(page) || 1);
    const safePageSize = Math.min(100, Math.max(1, Number(pageSize) || 50));
    const offset = (safePage - 1) * safePageSize;

    if (publishPackOnly || needsPublishPack) {
      const rowsRes = await db.execute({
        sql: `SELECT * FROM download_history WHERE ${where} ORDER BY created_at DESC`,
        args
      });
      const filtered = rowsRes.rows.filter(row => {
        const packCount = getRewritePackCount(row.ai_analysis);
        if (publishPackOnly && packCount === 0) return false;
        if (needsPublishPack && packCount > 0) return false;
        return true;
      });
      return {
        items: filtered.slice(offset, offset + safePageSize),
        total: filtered.length,
        page: safePage,
        pageSize: safePageSize,
        hasMore: offset + safePageSize < filtered.length,
      };
    }

    const [itemsRes, countRes] = await Promise.all([
      db.execute({ sql: `SELECT * FROM download_history WHERE ${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`, args: [...args, safePageSize, offset] }),
      db.execute({ sql: `SELECT COUNT(*) as cnt FROM download_history WHERE ${where}`, args }),
    ]);

    const total = countRes.rows[0]?.cnt || 0;
    return {
      items: itemsRes.rows,
      total,
      page: safePage,
      pageSize: safePageSize,
      hasMore: offset + safePageSize < total,
    };
  },

  async getHistoryItem(userId, guestIp, taskId) {
    if (!taskId) return null;
    const ownerWhere = userId ? 'user_id = ?' : 'user_id IS NULL AND guest_ip = ?';
    const result = await db.execute({
      sql: `SELECT * FROM download_history WHERE task_id = ? AND ${ownerWhere} LIMIT 1`,
      args: [taskId, userId || guestIp]
    });
    return result.rows[0] || null;
  },

  async clearAllHistory() {
    await db.execute("DELETE FROM download_history");
  },

  async clearHistory(userId, guestIp) {
    if (userId) {
      await db.execute({ sql: 'DELETE FROM download_history WHERE user_id = ?', args: [userId] });
    } else if (guestIp) {
      await db.execute({ sql: 'DELETE FROM download_history WHERE user_id IS NULL AND guest_ip = ?', args: [guestIp] });
    }
  },

  async updateHistoryMeta({ userId, guestIp, taskId, isFavorite, tags, notes, groupName, aiAnalysis }) {
    const sets = [];
    const args = [];
    if (typeof isFavorite === 'boolean') {
      sets.push('is_favorite = ?');
      args.push(isFavorite ? 1 : 0);
    }
    if (Array.isArray(tags)) {
      sets.push('tags = ?');
      args.push(JSON.stringify(tags.slice(0, 20)));
    }
    if (typeof notes === 'string') {
      sets.push('notes = ?');
      args.push(notes.slice(0, 2000));
    }
    if (typeof groupName === 'string') {
      sets.push('group_name = ?');
      args.push(groupName.trim().slice(0, 80));
    }
    if (aiAnalysis !== undefined) {
      sets.push('ai_analysis = ?');
      args.push(JSON.stringify(aiAnalysis));
    }
    if (sets.length === 0) return;

    const ownerWhere = userId ? 'user_id = ?' : 'user_id IS NULL AND guest_ip = ?';
    args.push(taskId, userId || guestIp);
    await db.execute({
      sql: `UPDATE download_history SET ${sets.join(', ')} WHERE task_id = ? AND ${ownerWhere}`,
      args
    });
  },

  async recordAiUsage({ userId, taskId, feature, inputChars = 0, outputItems = 0 }) {
    if (!userId) return;
    await db.execute({
      sql: `INSERT INTO ai_usage (user_id, task_id, feature, input_chars, output_items)
            VALUES (?, ?, ?, ?, ?)`,
      args: [userId, taskId || null, feature, Number(inputChars) || 0, Number(outputItems) || 0]
    });
  },

  /**
   * 获取用户今日原画下载次数
   */
  async getTodayOriginalDownloads(userId) {
    if (!userId) return 0;
    const today = new Date().toISOString().split('T')[0];
    const startOfDay = Math.floor(new Date(today).getTime() / 1000);
    const r = await db.execute({
      sql: `SELECT COUNT(*) as cnt FROM download_history WHERE user_id = ? AND created_at >= ?`,
      args: [userId, startOfDay]
    });
    return r.rows[0]?.cnt || 0;
  },

  async getAiUsage(userId, sinceUnix = 0) {
    const result = await db.execute({
      sql: `SELECT feature, COUNT(*) as requests, SUM(input_chars) as input_chars, SUM(output_items) as output_items
            FROM ai_usage
            WHERE user_id = ? AND created_at >= ?
            GROUP BY feature`,
      args: [userId, sinceUnix]
    });
    return result.rows || [];
  },

  async getAiCache(cacheKey) {
    if (!cacheKey) return null;
    const result = await db.execute({
      sql: 'SELECT result FROM ai_cache WHERE cache_key = ? LIMIT 1',
      args: [cacheKey]
    });
    const raw = result.rows?.[0]?.result;
    if (!raw) return null;
    try { return JSON.parse(raw); } catch { return raw; }
  },

  async setAiCache(cacheKey, feature, result) {
    if (!cacheKey || result === undefined || result === null) return;
    await db.execute({
      sql: `INSERT INTO ai_cache (cache_key, feature, result, created_at)
            VALUES (?, ?, ?, unixepoch())
            ON CONFLICT(cache_key) DO UPDATE SET result = excluded.result, created_at = unixepoch()`,
      args: [cacheKey, feature || 'unknown', JSON.stringify(result)]
    });
  },

  async createBatchJob({ id, userId, type, total = 0, options = {} }) {
    await db.execute({
      sql: `INSERT INTO batch_jobs (id, user_id, type, status, total, options, created_at, updated_at)
            VALUES (?, ?, ?, 'queued', ?, ?, unixepoch(), unixepoch())`,
      args: [id, userId || null, type, Number(total) || 0, JSON.stringify(options || {})]
    });
    return this.getBatchJob(id, userId);
  },

  async addBatchJobItems(jobId, taskIds = []) {
    for (const taskId of taskIds) {
      await db.execute({
        sql: `INSERT INTO batch_job_items (job_id, task_id, status, created_at, updated_at)
              VALUES (?, ?, 'queued', unixepoch(), unixepoch())`,
        args: [jobId, taskId]
      });
    }
  },

  async updateBatchJob(jobId, updates = {}) {
    const sets = ['updated_at = unixepoch()'];
    const args = [];
    for (const key of ['status', 'total', 'done', 'success', 'failed', 'error']) {
      if (updates[key] !== undefined) {
        sets.push(`${key} = ?`);
        args.push(updates[key]);
      }
    }
    if (updates.options !== undefined) {
      sets.push('options = ?');
      args.push(JSON.stringify(updates.options || {}));
    }
    args.push(jobId);
    await db.execute({ sql: `UPDATE batch_jobs SET ${sets.join(', ')} WHERE id = ?`, args });
  },

  async updateBatchJobItem(jobId, taskId, updates = {}) {
    const sets = ['updated_at = unixepoch()'];
    const args = [];
    for (const key of ['status', 'step', 'error']) {
      if (updates[key] !== undefined) {
        sets.push(`${key} = ?`);
        args.push(updates[key]);
      }
    }
    if (updates.result !== undefined) {
      sets.push('result = ?');
      args.push(JSON.stringify(updates.result || null));
    }
    args.push(jobId, taskId);
    await db.execute({
      sql: `UPDATE batch_job_items SET ${sets.join(', ')} WHERE job_id = ? AND task_id = ?`,
      args
    });
  },

  async getBatchJob(jobId, userId = null) {
    const jobRes = await db.execute({
      sql: `SELECT * FROM batch_jobs WHERE id = ? ${userId ? 'AND user_id = ?' : ''} LIMIT 1`,
      args: userId ? [jobId, userId] : [jobId]
    });
    const job = jobRes.rows?.[0];
    if (!job) return null;
    const itemsRes = await db.execute({
      sql: `SELECT * FROM batch_job_items WHERE job_id = ? ORDER BY id ASC`,
      args: [jobId]
    });
    return {
      ...job,
      options: parseAiAnalysis(job.options) || {},
      items: (itemsRes.rows || []).map(item => ({
        ...item,
        result: parseAiAnalysis(item.result)
      }))
    };
  },

  async listBatchJobs(userId, type = null, limit = 20) {
    if (!userId) return [];
    const args = [userId];
    let where = 'user_id = ?';
    if (type) {
      where += ' AND type = ?';
      args.push(type);
    }
    args.push(Math.min(100, Math.max(1, Number(limit) || 20)));
    const result = await db.execute({
      sql: `SELECT * FROM batch_jobs WHERE ${where} ORDER BY created_at DESC LIMIT ?`,
      args
    });
    return (result.rows || []).map(job => ({
      ...job,
      options: parseAiAnalysis(job.options) || {}
    }));
  },

  async getAdminMetrics() {
    const nowUnix = Math.floor(Date.now() / 1000);
    const dayStart = new Date();
    dayStart.setHours(0, 0, 0, 0);
    const todayUnix = Math.floor(dayStart.getTime() / 1000);
    const sevenDaysAgoUnix = nowUnix - 7 * 24 * 60 * 60;
    const sevenDaysAgoMs = Date.now() - 7 * 24 * 60 * 60 * 1000;
    const thirtyDaysAgoUnix = nowUnix - 30 * 24 * 60 * 60;
    const thirtyDaysAgoMs = Date.now() - 30 * 24 * 60 * 60 * 1000;

    const firstNumber = async (sql, args = []) => {
      const result = await db.execute({ sql, args });
      const row = result.rows?.[0] || {};
      const value = Object.values(row)[0] || 0;
      return Number(value) || 0;
    };

    const makeDaySeries = (days) => {
      const start = new Date();
      start.setHours(0, 0, 0, 0);
      start.setDate(start.getDate() - days + 1);
      return Array.from({ length: days }, (_, index) => {
        const date = new Date(start);
        date.setDate(start.getDate() + index);
        return {
          date: date.toISOString().slice(0, 10),
          count: 0
        };
      });
    };

    const mergeDayRows = (days, rows = []) => {
      const series = makeDaySeries(days);
      const index = new Map(series.map((item, position) => [item.date, position]));
      rows.forEach(row => {
        const date = String(row.date || '');
        const position = index.get(date);
        if (position !== undefined) {
          series[position].count = Number(row.count) || 0;
        }
      });
      return series;
    };

    const [
      totalUsers,
      proUsers,
      verifiedUsers,
      newUsers7d,
      totalDownloads,
      downloadsToday,
      downloads7d,
      aiRequestsTotal,
      aiRequests7d,
      aiOutputItemsTotal,
      aiCards,
      materialGroups,
      favorites
    ] = await Promise.all([
      firstNumber('SELECT COUNT(*) as value FROM users'),
      firstNumber(`SELECT COUNT(*) as value FROM users WHERE tier = 'pro' AND subscription_status IN ('active', 'past_due', 'lifetime')`),
      firstNumber('SELECT COUNT(*) as value FROM users WHERE email_verified = 1'),
      firstNumber('SELECT COUNT(*) as value FROM users WHERE created_at >= ?', [sevenDaysAgoMs]),
      firstNumber('SELECT COUNT(*) as value FROM download_history'),
      firstNumber('SELECT COUNT(*) as value FROM download_history WHERE created_at >= ?', [todayUnix]),
      firstNumber('SELECT COUNT(*) as value FROM download_history WHERE created_at >= ?', [sevenDaysAgoUnix]),
      firstNumber('SELECT COUNT(*) as value FROM ai_usage'),
      firstNumber('SELECT COUNT(*) as value FROM ai_usage WHERE created_at >= ?', [sevenDaysAgoUnix]),
      firstNumber('SELECT COALESCE(SUM(output_items), 0) as value FROM ai_usage'),
      firstNumber(`SELECT COUNT(*) as value FROM download_history WHERE ai_analysis IS NOT NULL AND ai_analysis != ''`),
      firstNumber(`SELECT COUNT(DISTINCT group_name) as value FROM download_history WHERE group_name IS NOT NULL AND group_name != ''`),
      firstNumber('SELECT COUNT(*) as value FROM download_history WHERE is_favorite = 1')
    ]);

    const [
      topPlatformsResult,
      downloadTrendResult,
      userTrendResult,
      aiFeatureResult,
      platform7dResult
    ] = await Promise.all([
      db.execute({
        sql: `SELECT platform, COUNT(*) as count
              FROM download_history
              WHERE platform IS NOT NULL AND platform != ''
              GROUP BY platform
              ORDER BY count DESC
              LIMIT 6`
      }),
      db.execute({
        sql: `SELECT date(created_at, 'unixepoch') as date, COUNT(*) as count
              FROM download_history
              WHERE created_at >= ?
              GROUP BY date
              ORDER BY date ASC`,
        args: [thirtyDaysAgoUnix]
      }),
      db.execute({
        sql: `SELECT date(created_at / 1000, 'unixepoch') as date, COUNT(*) as count
              FROM users
              WHERE created_at >= ?
              GROUP BY date
              ORDER BY date ASC`,
        args: [thirtyDaysAgoMs]
      }),
      db.execute({
        sql: `SELECT feature, COUNT(*) as requests, COALESCE(SUM(input_chars), 0) as input_chars, COALESCE(SUM(output_items), 0) as output_items
              FROM ai_usage
              WHERE created_at >= ?
              GROUP BY feature
              ORDER BY requests DESC
              LIMIT 12`,
        args: [sevenDaysAgoUnix]
      }),
      db.execute({
        sql: `SELECT platform, COUNT(*) as count
              FROM download_history
              WHERE created_at >= ? AND platform IS NOT NULL AND platform != ''
              GROUP BY platform
              ORDER BY count DESC
              LIMIT 8`,
        args: [sevenDaysAgoUnix]
      })
    ]);

    return {
      users: {
        total: totalUsers,
        pro: proUsers,
        free: Math.max(totalUsers - proUsers, 0),
        verified: verifiedUsers,
        new7d: newUsers7d
      },
      downloads: {
        total: totalDownloads,
        today: downloadsToday,
        last7d: downloads7d
      },
      ai: {
        requests: aiRequestsTotal,
        requests7d: aiRequests7d,
        outputItems: aiOutputItemsTotal
      },
      materials: {
        aiCards,
        groups: materialGroups,
        favorites
      },
      topPlatforms: (topPlatformsResult.rows || []).map(row => ({
        platform: row.platform,
        count: Number(row.count) || 0
      })),
      trends: {
        downloads30d: mergeDayRows(30, downloadTrendResult.rows),
        newUsers30d: mergeDayRows(30, userTrendResult.rows)
      },
      aiBreakdown: (aiFeatureResult.rows || []).map(row => ({
        feature: row.feature || 'unknown',
        requests: Number(row.requests) || 0,
        inputChars: Number(row.input_chars) || 0,
        outputItems: Number(row.output_items) || 0
      })),
      platform7d: (platform7dResult.rows || []).map(row => ({
        platform: row.platform,
        count: Number(row.count) || 0
      })),
      generatedAt: Date.now()
    };
  },

  async getAsrLexicon(userId, language = 'auto') {
    if (!userId) return [];
    await ensureAsrLexiconTable();
    const result = await db.execute({
      sql: `SELECT id, term, language, category, created_at
            FROM asr_lexicon
            WHERE user_id = ? AND (language = ? OR language = 'auto')
            ORDER BY created_at DESC
            LIMIT 200`,
      args: [userId, language || 'auto']
    });
    return result.rows || [];
  },

  async replaceAsrLexicon(userId, terms = [], language = 'auto') {
    if (!userId) return [];
    await ensureAsrLexiconTable();
    const safeLanguage = String(language || 'auto').slice(0, 16);
    const normalized = Array.from(new Set(
      terms
        .map(item => String(item || '').trim())
        .filter(item => item.length >= 2 && item.length <= 40)
    )).slice(0, 200);

    await db.execute({
      sql: `DELETE FROM asr_lexicon WHERE user_id = ? AND language = ?`,
      args: [userId, safeLanguage]
    });

    for (const term of normalized) {
      await db.execute({
        sql: `INSERT OR IGNORE INTO asr_lexicon (user_id, term, language, category)
              VALUES (?, ?, ?, 'custom')`,
        args: [userId, term, safeLanguage]
      });
    }
    return this.getAsrLexicon(userId, safeLanguage);
  }
};

module.exports = userDb;

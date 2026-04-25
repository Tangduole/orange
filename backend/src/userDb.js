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

// 数据库连接 URL 解析
// 优先 TURSO_DATABASE_URL（云端），否则用本地 SQLite
// 本地路径可通过 LOCAL_DB_PATH 覆盖（建议指向代码目录之外，避免数据被打包/泄露）
function buildDbUrl() {
  if (process.env.TURSO_DATABASE_URL) return process.env.TURSO_DATABASE_URL;
  const local = process.env.LOCAL_DB_PATH || './data/users.db';
  return /^(file|libsql|wss?):/i.test(local) ? local : 'file:' + local;
}

const db = createClient({
  url: buildDbUrl(),
  authToken: process.env.TURSO_AUTH_TOKEN,
});

// 免费用户每日下载次数限制
const FREE_DAILY_LIMIT = 3;

/**
 * 统一判定一个 user 是否为 VIP（pro 权益生效中）
 * 规则：tier === 'pro' 且 status ∈ {active, past_due}
 *       且 subscription_ends_at 未过期（若设置了）
 */
function isVip(user) {
  if (!user) return false;
  if (user.tier !== 'pro') return false;
  if (user.subscription_status !== 'active' && user.subscription_status !== 'past_due') {
    return false;
  }
  if (user.subscription_ends_at && Number(user.subscription_ends_at) > 0) {
    // subscription_ends_at 是秒级时间戳
    if (Number(user.subscription_ends_at) * 1000 < Date.now()) {
      return false;
    }
  }
  return true;
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
        created_at INTEGER NOT NULL
      )
    `);
    await db.execute(`CREATE INDEX IF NOT EXISTS idx_history_user ON download_history(user_id, created_at DESC)`);
    
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
    
    // 推荐记录表
    await db.execute({
      sql: `CREATE TABLE IF NOT EXISTS referrals (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        referrer_id TEXT NOT NULL,
        referee_id TEXT NOT NULL,
        created_at INTEGER DEFAULT (unixepoch())
      )`
    });
    
    console.log('[userDb] Turso 数据库初始化完成');
  } catch (err) {
    console.error('[userDb] 初始化表失败:', err);
  }
}
initDb();

const userDb = {
  db,
  isVip,

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
    let limit = vip ? -1 : FREE_DAILY_LIMIT;

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

  async clearAllHistory() {
    await db.execute("DELETE FROM download_history");
  },

  async clearHistory(userId, guestIp) {
    if (userId) {
      await db.execute({ sql: 'DELETE FROM download_history WHERE user_id = ?', args: [userId] });
    } else if (guestIp) {
      await db.execute({ sql: 'DELETE FROM download_history WHERE user_id IS NULL AND guest_ip = ?', args: [guestIp] });
    }
  }
};

module.exports = userDb;

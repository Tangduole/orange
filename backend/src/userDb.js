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

// Turso 数据库连接
// 环境变量：TURSO_DATABASE_URL = libsql://xxx.turso.io
// 环境变量：TURSO_AUTH_TOKEN = xxx (如果需要)
const db = createClient({
  url: process.env.TURSO_DATABASE_URL || 'file:data/users.db',
  authToken: process.env.TURSO_AUTH_TOKEN,
});

// 免费用户每日下载次数限制
const FREE_DAILY_LIMIT = 3;

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
   * 检查并重置每日下载次数
   */
  async checkAndResetDaily(id) {
    const user = await this.getById(id);
    if (!user) return null;
    
    const today = new Date().toISOString().split('T')[0];
    const lastReset = user.last_download_reset;
    
    if (lastReset !== today) {
      await db.execute({
        sql: `UPDATE users SET daily_downloads = 0, last_download_reset = ? WHERE id = ?`,
        args: [today, id]
      });
      user.daily_downloads = 0;
      user.last_download_reset = today;
    }
    
    return user;
  },

  /**
   * 增加下载次数
   */
  async incrementDownloads(id) {
    const user = await this.checkAndResetDaily(id);
    if (!user) return null;
    
    await db.execute({
      sql: `UPDATE users SET daily_downloads = daily_downloads + 1 WHERE id = ?`,
      args: [id]
    });
    
    return { ...user, daily_downloads: user.daily_downloads + 1 };
  },

  /**
   * 获取用户使用量
   */
  async getUsage(id) {
    const user = await this.checkAndResetDaily(id);
    if (!user) return null;
    
    const isPro = user.tier === 'pro' && user.subscription_status === 'active';
    let limit = isPro ? -1 : FREE_DAILY_LIMIT;
    
    // 推荐奖励：+5次/天（有效期内）
    const hasReferralBonus = user.referral_bonus_expires && user.referral_bonus_expires > Date.now();
    if (!isPro && hasReferralBonus) {
      limit += 5;
    }
    
    return {
      tier: user.tier,
      isPro,
      dailyDownloads: user.daily_downloads,
      dailyLimit: limit,
      remaining: limit === -1 ? -1 : Math.max(0, limit - user.daily_downloads),
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
   */
  async getReferralCode(userId) {
    const user = await this.getById(userId);
    if (!user) return null;
    if (user.referral_code) return user.referral_code;
    
    // 生成6位推荐码（用户ID前6位大写）
    const code = userId.substring(0, 8).toUpperCase();
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
  }
};

module.exports = userDb;

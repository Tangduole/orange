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
const FREE_DAILY_LIMIT = 5;

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
        created_at INTEGER NOT NULL
      )
    `);
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
    const limit = isPro ? -1 : FREE_DAILY_LIMIT;
    
    return {
      tier: user.tier,
      isPro,
      dailyDownloads: user.daily_downloads,
      dailyLimit: limit,
      remaining: limit === -1 ? -1 : Math.max(0, limit - user.daily_downloads),
      subscriptionStatus: user.subscription_status,
      subscriptionEndsAt: user.subscription_ends_at
    };
  },

  /**
   * 更新订阅状态
   */
  async updateSubscription(email, status, endsAt, lemonCustomerId, lemonSubscriptionId) {
    await db.execute({
      sql: `UPDATE users SET 
        subscription_status = ?,
        subscription_ends_at = ?,
        lemon_customer_id = ?,
        lemon_subscription_id = ?,
        tier = CASE WHEN ? = 'active' THEN 'pro' ELSE tier END
      WHERE email = ?`,
      args: [status, endsAt, lemonCustomerId, lemonSubscriptionId, status, email.toLowerCase()]
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
   * 删除用户
   */
  async deleteUser(email) {
    await db.execute({
      sql: 'DELETE FROM users WHERE email = ?',
      args: [email.toLowerCase()]
    });
  }
};

module.exports = userDb;

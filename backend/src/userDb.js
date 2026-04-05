/**
 * 用户数据库 v1 - SQLite
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

const Database = require('better-sqlite3');
const path = require('path');
const bcrypt = require('bcryptjs');

const DATA_DIR = path.join(__dirname, '../../data');
const DB_PATH = path.join(DATA_DIR, 'users.db');

// 确保目录存在
const fs = require('fs');
if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

// 创建数据库连接
const db = new Database(DB_PATH);

// 初始化表
db.exec(`
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

// 免费用户每日下载次数限制
const FREE_DAILY_LIMIT = 5;

const userDb = {
  /**
   * 创建用户
   */
  create(email, password) {
    const id = require('uuid').v4();
    const passwordHash = bcrypt.hashSync(password, 10);
    const now = Date.now();
    
    try {
      const stmt = db.prepare(`
        INSERT INTO users (id, email, password_hash, created_at)
        VALUES (?, ?, ?, ?)
      `);
      stmt.run(id, email.toLowerCase(), passwordHash, now);
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
  verifyPassword(email, password) {
    const stmt = db.prepare('SELECT * FROM users WHERE email = ?');
    const user = stmt.get(email.toLowerCase());
    
    if (!user) return null;
    if (!bcrypt.compareSync(password, user.password_hash)) return null;
    
    return user;
  },

  /**
   * 根据ID获取用户
   */
  getById(id) {
    const stmt = db.prepare('SELECT * FROM users WHERE id = ?');
    return stmt.get(id);
  },

  /**
   * 根据邮箱获取用户
   */
  getByEmail(email) {
    const stmt = db.prepare('SELECT * FROM users WHERE email = ?');
    return stmt.get(email.toLowerCase());
  },

  /**
   * 检查并重置每日下载次数
   */
  checkAndResetDaily(id) {
    const user = this.getById(id);
    if (!user) return null;
    
    const today = new Date().toISOString().split('T')[0];
    const lastReset = user.last_download_reset;
    
    if (lastReset !== today) {
      // 重置计数
      const stmt = db.prepare(`
        UPDATE users SET daily_downloads = 0, last_download_reset = ?
        WHERE id = ?
      `);
      stmt.run(today, id);
      user.daily_downloads = 0;
      user.last_download_reset = today;
    }
    
    return user;
  },

  /**
   * 增加下载次数
   */
  incrementDownloads(id) {
    const user = this.checkAndResetDaily(id);
    if (!user) return null;
    
    const stmt = db.prepare(`
      UPDATE users SET daily_downloads = daily_downloads + 1
      WHERE id = ?
    `);
    stmt.run(id);
    
    return { ...user, daily_downloads: user.daily_downloads + 1 };
  },

  /**
   * 获取用户使用量
   */
  getUsage(id) {
    const user = this.checkAndResetDaily(id);
    if (!user) return null;
    
    const isPro = user.tier === 'pro' && user.subscription_status === 'active';
    const limit = isPro ? -1 : FREE_DAILY_LIMIT; // -1 表示无限制
    
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
   * 更新订阅状态 (Lemon Squeezy webhook 调用)
   */
  updateSubscription(email, status, endsAt, lemonCustomerId, lemonSubscriptionId) {
    const stmt = db.prepare(`
      UPDATE users SET 
        subscription_status = ?,
        subscription_ends_at = ?,
        lemon_customer_id = ?,
        lemon_subscription_id = ?,
        tier = CASE WHEN ? = 'active' THEN 'pro' ELSE tier END
      WHERE email = ?
    `);
    stmt.run(status, endsAt, lemonCustomerId, lemonSubscriptionId, status, email.toLowerCase());
  },

  /**
   * 升级为Pro
   */
  upgradeToPro(email, endsAt) {
    const stmt = db.prepare(`
      UPDATE users SET 
        tier = 'pro',
        subscription_status = 'active',
        subscription_ends_at = ?
      WHERE email = ?
    `);
    stmt.run(endsAt, email.toLowerCase());
  },

  /**
   * 降级为Free
   */
  downgradeToFree(email) {
    const stmt = db.prepare(`
      UPDATE users SET 
        tier = 'free',
        subscription_status = 'cancelled'
      WHERE email = ?
    `);
    stmt.run(email.toLowerCase());
  }
};

module.exports = userDb;

/**
 * 生命周期邮件调度器
 * 
 * 由 cron job 每日调用一次，发送生命周期邮件：
 * - Day 1: 欢迎邮件（注册后当天）
 * - Day 3: 使用成就（下载量统计）
 * - Day 7: 限时优惠（首月 $2.99）
 */

const { createClient } = require('@libsql/client');
const { sendWelcomeEmail, sendDay3Email, sendDay7Email } = require('./services/email');

// 与 userDb.js 保持一致：本地 SQLite 路径通过 LOCAL_DB_PATH 覆盖
function buildDbUrl() {
  if (process.env.TURSO_DATABASE_URL) return process.env.TURSO_DATABASE_URL;
  const local = process.env.LOCAL_DB_PATH || './data/users.db';
  return /^(file|libsql|wss?):/i.test(local) ? local : 'file:' + local;
}

const db = createClient({
  url: buildDbUrl(),
  authToken: process.env.TURSO_AUTH_TOKEN,
});

// 邮件发送记录表
async function initTable() {
  await db.execute(`
    CREATE TABLE IF NOT EXISTS email_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id TEXT NOT NULL,
      email_type TEXT NOT NULL,
      sent_at INTEGER NOT NULL,
      UNIQUE(user_id, email_type)
    )
  `);
}

/**
 * 检查邮件是否已发送
 */
async function wasEmailSent(userId, emailType) {
  const result = await db.execute({
    sql: 'SELECT 1 FROM email_logs WHERE user_id = ? AND email_type = ?',
    args: [userId, emailType]
  });
  return result.rows.length > 0;
}

/**
 * 记录邮件发送
 */
async function logEmail(userId, emailType) {
  await db.execute({
    sql: 'INSERT OR IGNORE INTO email_logs (user_id, email_type, sent_at) VALUES (?, ?, ?)',
    args: [userId, emailType, Date.now()]
  });
}

/**
 * 执行生命周期邮件发送
 */
async function run() {
  await initTable();
  
  const now = Date.now();
  const DAY = 24 * 60 * 60 * 1000;
  
  // 获取所有已验证的用户
  const result = await db.execute(`
    SELECT id, email, created_at, email_verified, daily_downloads 
    FROM users 
    WHERE email_verified = 1
    ORDER BY created_at DESC
  `);
  
  let sent = 0;
  let skipped = 0;
  
  for (const user of result.rows) {
    const daysSinceReg = Math.floor((now - user.created_at) / DAY);
    const email = user.email;
    const userId = user.id;
    
    try {
      // Day 1: 欢迎邮件（注册后 0-1 天）
      if (daysSinceReg <= 1 && !(await wasEmailSent(userId, 'welcome'))) {
        await sendWelcomeEmail(email);
        await logEmail(userId, 'welcome');
        console.log(`[lifecycle] Welcome email sent to ${email}`);
        sent++;
        continue;
      }
      
      // Day 3: 使用成就（注册后 2-4 天）
      if (daysSinceReg >= 2 && daysSinceReg <= 4 && !(await wasEmailSent(userId, 'day3'))) {
        // 获取用户总下载量
        const usageResult = await db.execute({
          sql: 'SELECT SUM(download_count) as total FROM guest_downloads WHERE ip = ? OR EXISTS (SELECT 1 FROM users WHERE id = ? AND email = ?)',
          args: [userId, userId, email]
        });
        const downloadCount = Math.max(user.daily_downloads * daysSinceReg, 1); // 估算
        await sendDay3Email(email, downloadCount);
        await logEmail(userId, 'day3');
        console.log(`[lifecycle] Day3 email sent to ${email} (${downloadCount} downloads)`);
        sent++;
        continue;
      }
      
      // Day 7: 限时优惠（注册后 6-8 天，且不是 Pro）
      if (daysSinceReg >= 6 && daysSinceReg <= 8 && !(await wasEmailSent(userId, 'day7'))) {
        // 检查是否是付费用户
        const userResult = await db.execute({
          sql: 'SELECT tier FROM users WHERE id = ?',
          args: [userId]
        });
        if (userResult.rows[0]?.tier !== 'pro') {
          await sendDay7Email(email);
          await logEmail(userId, 'day7');
          console.log(`[lifecycle] Day7 email sent to ${email}`);
          sent++;
          continue;
        }
      }
      
      skipped++;
    } catch (err) {
      console.error(`[lifecycle] Error sending to ${email}:`, err.message);
    }
  }
  
  console.log(`[lifecycle] Done. Sent: ${sent}, Skipped: ${skipped}, Total users: ${result.rows.length}`);
  return { sent, skipped, total: result.rows.length };
}

// 支持直接运行
if (require.main === module) {
  run().then(result => {
    console.log('[lifecycle] Result:', result);
    process.exit(0);
  }).catch(err => {
    console.error('[lifecycle] Fatal error:', err);
    process.exit(1);
  });
}

module.exports = { run };

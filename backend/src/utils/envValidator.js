/**
 * 环境变量验证工具
 */

const logger = require('./logger');

// 生产环境必需的变量（缺一不可启动）
const REQUIRED_ENV_VARS = [
  'JWT_SECRET',
  'NODE_ENV',
  'TURSO_DATABASE_URL',
  'TURSO_AUTH_TOKEN',
];

// 推荐变量（警告但不退出）
const RECOMMENDED_ENV_VARS = [
  'TIKHUB_API_KEY_YT',
  'TIKHUB_API_KEY_DOUYIN',
  'RESEND_API_KEY',
  'CLOUDFLARE_ACCOUNT_ID'
];

/**
 * 验证环境变量
 */
function validateEnv() {
  let hasError = false;
  let hasWarning = false;

  // 检查必需变量
  logger.info('[env] Validating required environment variables...');
  for (const key of REQUIRED_ENV_VARS) {
    if (!process.env[key]) {
      logger.error(`❌ Missing required environment variable: ${key}`);
      hasError = true;
    } else {
      logger.info(`✅ ${key} is set`);
    }
  }

  // 检查推荐变量
  logger.info('[env] Checking recommended environment variables...');
  for (const key of RECOMMENDED_ENV_VARS) {
    if (!process.env[key]) {
      logger.warn(`⚠️ Recommended environment variable not set: ${key}`);
      hasWarning = true;
    } else {
      logger.info(`✅ ${key} is set`);
    }
  }

  if (hasError) {
    logger.error('[env] ❌ Environment validation failed! Please check your .env file.');
    process.exit(1);
  }

  if (hasWarning) {
    logger.warn('[env] ⚠️ Some recommended variables are missing. Some features may not work.');
  } else {
    logger.info('[env] ✅ All environment variables validated successfully');
  }
}

/**
 * 获取环境变量（带默认值）
 */
function getEnv(key, defaultValue = '') {
  return process.env[key] || defaultValue;
}

/**
 * 检查是否为生产环境
 */
function isProduction() {
  return process.env.NODE_ENV === 'production';
}

/**
 * 数据库健康检查（必须在 userDb 初始化后调用）
 */
async function validateDatabase(userDb) {
  try {
    const r = await userDb.db.execute('SELECT COUNT(*) as c FROM users');
    const count = r.rows[0].c;
    
    if (count === 0) {
      logger.error('⚠️  数据库健康检查: 用户表为空！');
      if (process.env.TURSO_DATABASE_URL) {
        logger.error(`   已连接 Turso: ${process.env.TURSO_DATABASE_URL.substring(0, 50)}...`);
        logger.error('   但用户数为 0，可能数据库被清空或指向了新库。');
      } else {
        logger.error('   TURSO_DATABASE_URL 未设置，可能连接了本地空库！');
      }
      logger.error('   服务将继续运行，但用户认证和 VIP 功能将不可用。');
    } else {
      logger.info(`✅ 数据库健康: ${count} 个用户`);
    }
    
    // 检查 VIP 用户
    const vipR = await userDb.db.execute("SELECT COUNT(*) as c FROM users WHERE tier = 'pro'");
    if (vipR.rows[0].c > 0) {
      logger.info(`✅ VIP 用户: ${vipR.rows[0].c} 个`);
    }
    
    // 连接类型标识
    if (process.env.TURSO_DATABASE_URL) {
      logger.info('✅ 数据库类型: Turso Cloud');
    } else {
      logger.warn('⚠️  数据库类型: 本地 SQLite（生产环境不推荐）');
    }
    
    return true;
  } catch (e) {
    logger.error('❌ 数据库健康检查失败:', e.message);
    return false;
  }
}

module.exports = {
  validateEnv,
  validateDatabase,
  getEnv,
  isProduction
};

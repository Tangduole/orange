/**
 * 环境变量验证工具
 */

const logger = require('./logger');

// 必需的环境变量
const REQUIRED_ENV_VARS = [
  'JWT_SECRET',
  'NODE_ENV'
];

// 推荐的环境变量（警告但不退出）
const RECOMMENDED_ENV_VARS = [
  'TURSO_DATABASE_URL',
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

module.exports = {
  validateEnv,
  getEnv,
  isProduction
};

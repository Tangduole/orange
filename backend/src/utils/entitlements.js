const userDb = require('../userDb');

const HOUR_MS = 60 * 60 * 1000;

function numberEnv(key, fallback) {
  const value = Number(process.env[key]);
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}

function getAiCopywriteMonthlyLimit(user) {
  if (userDb.isBasic(user)) return numberEnv('AI_COPYWRITE_MONTHLY_LIMIT_BASIC', 50);
  if (!userDb.isVip(user)) return numberEnv('AI_COPYWRITE_MONTHLY_LIMIT_FREE', 0);
  return numberEnv('AI_COPYWRITE_MONTHLY_LIMIT_PRO', 200);
}

function getFileRetentionHoursForTier(tier) {
  if (tier === 'pro') return numberEnv('PRO_FILE_RETENTION_HOURS', 24 * 7);
  if (tier === 'basic') return numberEnv('BASIC_FILE_RETENTION_HOURS', 72);
  if (tier === 'guest') return numberEnv('GUEST_FILE_RETENTION_HOURS', numberEnv('FREE_FILE_RETENTION_HOURS', 24));
  return numberEnv('FREE_FILE_RETENTION_HOURS', numberEnv('FILE_RETENTION_HOURS', 24));
}

async function getFileRetentionMsForTask(task) {
  if (!task) return getFileRetentionHoursForTier('guest') * HOUR_MS;
  if (!task.userId) return getFileRetentionHoursForTier('guest') * HOUR_MS;

  try {
    const user = await userDb.getById(task.userId);
    return getFileRetentionHoursForTier(userDb.isVip(user) ? 'pro' : userDb.isBasic(user) ? 'basic' : 'free') * HOUR_MS;
  } catch {
    return getFileRetentionHoursForTier('free') * HOUR_MS;
  }
}

function monthStartUnix(date = new Date()) {
  return Math.floor(new Date(date.getFullYear(), date.getMonth(), 1).getTime() / 1000);
}

function retentionSummaryForUser(user) {
  const tier = userDb.isVip(user) ? 'pro' : userDb.isBasic(user) ? 'basic' : 'free';
  return {
    hours: getFileRetentionHoursForTier(tier),
    tier
  };
}

module.exports = {
  getAiCopywriteMonthlyLimit,
  getFileRetentionHoursForTier,
  getFileRetentionMsForTask,
  monthStartUnix,
  retentionSummaryForUser
};

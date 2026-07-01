const crypto = require('crypto');

const DEFAULT_TTL_SECONDS = Number(process.env.DOWNLOAD_URL_TTL_SECONDS || 6 * 60 * 60);

function getSecret() {
  const secret = process.env.DOWNLOAD_URL_SECRET || process.env.JWT_SECRET;
  if (!secret) throw new Error('DOWNLOAD_URL_SECRET or JWT_SECRET is required');
  return secret;
}

function signPayload(filename, exp) {
  return crypto
    .createHmac('sha256', getSecret())
    .update(`${filename}:${exp}`)
    .digest('hex');
}

function isDownloadUrl(value) {
  return typeof value === 'string' && value.startsWith('/download/');
}

function extractFilename(downloadUrl) {
  try {
    const parsed = new URL(downloadUrl, 'https://orange.local');
    if (!parsed.pathname.startsWith('/download/')) return '';
    return decodeURIComponent(parsed.pathname.slice('/download/'.length));
  } catch {
    return '';
  }
}

function signDownloadUrl(downloadUrl, ttlSeconds = DEFAULT_TTL_SECONDS) {
  if (!isDownloadUrl(downloadUrl)) return downloadUrl;
  const filename = extractFilename(downloadUrl);
  if (!filename || filename.includes('/') || filename.includes('\\')) return downloadUrl;

  const exp = Math.floor(Date.now() / 1000) + ttlSeconds;
  const sig = signPayload(filename, exp);
  const parsed = new URL(downloadUrl, 'https://orange.local');
  parsed.searchParams.set('exp', String(exp));
  parsed.searchParams.set('sig', sig);
  return parsed.pathname + parsed.search;
}

function verifyDownloadRequest(filename, exp, sig) {
  if (!filename || filename.includes('/') || filename.includes('\\')) return false;
  const expNum = Number(exp);
  if (!Number.isFinite(expNum) || expNum < Math.floor(Date.now() / 1000)) return false;
  if (!sig || typeof sig !== 'string') return false;

  const expected = signPayload(filename, expNum);
  const sigBuf = Buffer.from(sig, 'hex');
  const expectedBuf = Buffer.from(expected, 'hex');
  return sigBuf.length === expectedBuf.length && crypto.timingSafeEqual(sigBuf, expectedBuf);
}

function signTaskDownloadFields(value) {
  if (!value || typeof value !== 'object') return value;
  const signed = Array.isArray(value) ? value.map(signTaskDownloadFields) : { ...value };

  for (const key of ['downloadUrl', 'thumbnailUrl', 'coverUrl', 'audioUrl', 'asrTxtUrl', 'translatedTxtUrl', 'subbedVideoUrl', 'copyTxtUrl', 'url']) {
    if (isDownloadUrl(signed[key])) signed[key] = signDownloadUrl(signed[key]);
  }

  if (Array.isArray(signed.subtitleFiles)) {
    signed.subtitleFiles = signed.subtitleFiles.map(item => signTaskDownloadFields(item));
  }
  if (Array.isArray(signed.imageFiles)) {
    signed.imageFiles = signed.imageFiles.map(item => signTaskDownloadFields(item));
  }

  return signed;
}

module.exports = {
  signDownloadUrl,
  verifyDownloadRequest,
  signTaskDownloadFields,
};

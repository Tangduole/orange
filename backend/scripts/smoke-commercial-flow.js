process.env.NODE_ENV = process.env.NODE_ENV || 'development';
process.env.DEV_COPYWRITE_MOCK = process.env.DEV_COPYWRITE_MOCK || '1';
process.env.DOWNLOAD_URL_SECRET = process.env.DOWNLOAD_URL_SECRET || 'dev-smoke-download-secret';

const assert = require('assert');
const path = require('path');
const fs = require('fs');

async function main() {
  const { validateUrl } = require('../src/utils/validator');
  const { detectPlatform } = require('../src/utils/media');
  const { signDownloadUrl, verifyDownloadRequest } = require('../src/utils/downloadToken');
  const { extractCopywrite } = require('../src/services/ai-copywrite');
  const { getAiCopywriteMonthlyLimit, getFileRetentionHoursForTier } = require('../src/utils/entitlements');

  assert.strictEqual(validateUrl('https://www.youtube.com/watch?v=dQw4w9WgXcQ', 'youtube').valid, true);
  assert.strictEqual(validateUrl('https://evil-youtube.com/watch?v=dQw4w9WgXcQ', 'youtube').valid, false);
  assert.strictEqual(detectPlatform('https://www.tiktok.com/@user/video/123'), 'tiktok');
  assert.strictEqual(detectPlatform('https://not-tiktok.com/@user/video/123'), 'auto');

  const signed = signDownloadUrl('/download/test-video.mp4', 60);
  const parsed = new URL(signed, 'https://orangedl.com');
  assert.strictEqual(
    verifyDownloadRequest('test-video.mp4', parsed.searchParams.get('exp'), parsed.searchParams.get('sig')),
    true
  );

  const mock = await extractCopywrite('smoke-task', 'youtube');
  assert.ok(mock.transcript.includes('smoke-task'));
  assert.ok(Array.isArray(mock.analysis.tags));
  assert.strictEqual(getAiCopywriteMonthlyLimit({ tier: 'free' }), 0);
  assert.ok(getAiCopywriteMonthlyLimit({ tier: 'pro', subscription_status: 'active', subscription_ends_at: Math.floor(Date.now() / 1000) + 86400 }) > 0);
  assert.ok(getFileRetentionHoursForTier('pro') >= getFileRetentionHoursForTier('free'));

  const extensionManifest = path.join(__dirname, '../../browser-extension/manifest.json');
  assert.ok(fs.existsSync(extensionManifest), 'browser extension manifest should exist');
  JSON.parse(fs.readFileSync(extensionManifest, 'utf8'));

  console.log('Commercial flow smoke checks passed.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

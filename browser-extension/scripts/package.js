#!/usr/bin/env node
/**
 * Browser Extension - Release Package Script
 * Usage: node browser-extension/scripts/package.js
 * Output: browser-extension-release.zip
 */

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const { createWriteStream } = require('fs');

const EXT_DIR = path.join(__dirname, '..');
const OUT = path.join(EXT_DIR, 'browser-extension-release.zip');

console.log('📦 Packaging browser extension...');

// First validate
try {
  console.log('🔍 Validating...');
  execSync(`node "${path.join(__dirname, 'validate.js')}"`, { cwd: EXT_DIR, stdio: 'inherit' });
} catch {
  console.error('❌ Validation failed. Fix errors before packaging.');
  process.exit(1);
}

// Create zip
const { execSync: exec } = require('child_process');
const exclude = [
  'scripts',
  'STORE_LISTING.md',
  'README.md',
  'QA_CHECKLIST.md',
  '*.zip',
  '*.md',
  'node_modules',
  '.git',
];
const excludeArgs = exclude.map(e => `-x "${e}"`).join(' ');

try {
  if (fs.existsSync(OUT)) fs.unlinkSync(OUT);
  exec(`cd "${EXT_DIR}" && zip -r "${OUT}" . ${excludeArgs}`, { stdio: 'inherit' });
  const size = (fs.statSync(OUT).size / 1024).toFixed(1);
  console.log(`✅ Release package created: browser-extension-release.zip (${size} KB)`);
} catch (e) {
  console.error('❌ Packaging failed:', e.message);
  process.exit(1);
}

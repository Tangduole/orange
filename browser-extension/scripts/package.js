#!/usr/bin/env node
/**
 * Browser Extension - Release Package Script
 * Usage: node browser-extension/scripts/package.js
 * Output: browser-extension-release.zip
 */

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const JSZip = require('jszip');

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

const exclude = [
  'scripts',
  'STORE_LISTING.md',
  'README.md',
  'QA_CHECKLIST.md',
  'package.json',
  'package-lock.json',
  'node_modules',
  '.git',
];

function shouldExclude(relativePath) {
  const normalized = relativePath.replace(/\\/g, '/');
  if (normalized.endsWith('.zip')) return true;
  if (normalized.endsWith('.md')) return true;
  return exclude.some(item => normalized === item || normalized.startsWith(`${item}/`));
}

function addDirectory(zip, dir, base = '') {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const relativePath = path.posix.join(base, entry.name);
    if (shouldExclude(relativePath)) continue;
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      addDirectory(zip, fullPath, relativePath);
    } else if (entry.isFile()) {
      zip.file(relativePath, fs.readFileSync(fullPath));
    }
  }
}

(async () => {
  if (fs.existsSync(OUT)) fs.unlinkSync(OUT);
  const zip = new JSZip();
  addDirectory(zip, EXT_DIR);
  const content = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
  fs.writeFileSync(OUT, content);
  const size = (fs.statSync(OUT).size / 1024).toFixed(1);
  console.log(`✅ Release package created: browser-extension-release.zip (${size} KB)`);
})().catch((e) => {
  console.error('❌ Packaging failed:', e.message);
  process.exit(1);
});

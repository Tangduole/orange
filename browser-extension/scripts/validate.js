const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const root = path.resolve(__dirname, '..');
const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));
const manifestPath = path.join(root, 'manifest.json');
const manifest = readJson(manifestPath);

const messageRefs = new Set();
const collectMessageRefs = (value) => {
  if (typeof value === 'string') {
    const match = value.match(/^__MSG_([A-Za-z0-9_]+)__$/);
    if (match) messageRefs.add(match[1]);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach(collectMessageRefs);
    return;
  }
  if (value && typeof value === 'object') {
    Object.values(value).forEach(collectMessageRefs);
  }
};

collectMessageRefs(manifest);

if (!manifest.manifest_version || manifest.manifest_version !== 3) {
  throw new Error('manifest.json must use Manifest V3');
}

if (!manifest.default_locale) {
  throw new Error('manifest.json must define default_locale');
}

const localesDir = path.join(root, '_locales');
const locales = fs.readdirSync(localesDir).filter(name => fs.statSync(path.join(localesDir, name)).isDirectory());
if (!locales.includes(manifest.default_locale)) {
  throw new Error(`default_locale ${manifest.default_locale} is missing from _locales`);
}

for (const locale of locales) {
  const messagesPath = path.join(localesDir, locale, 'messages.json');
  const messages = readJson(messagesPath);
  for (const ref of messageRefs) {
    if (!messages[ref]?.message) {
      throw new Error(`${locale}/messages.json missing manifest key: ${ref}`);
    }
  }
}

for (const script of ['popup.js', 'content.js']) {
  const result = spawnSync(process.execPath, ['--check', path.join(root, script)], { stdio: 'inherit' });
  if (result.status !== 0) {
    process.exit(result.status || 1);
  }
}

console.log(`[extension] Validated manifest, ${locales.length} locales, and popup/content syntax`);

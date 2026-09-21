#!/usr/bin/env node

// Publishes the frontend app bundle plus a manifest for the browser-side thin loader.
//
// Usage:
//   node tools/gen-bundle.js [--check]
//
//   --check  do not write anything; exit non-zero when build/app/manifest.json differs
//            from the manifest that would be generated (useful in CI).
//
// Output layout (paths relative to frontend/), all under build/app/:
//   build/app/js/app/platform.js, js/app/api.js, … js/index.js, css/app.css
//   build/app/manifest.json
//
// The bundle is deterministic: no timestamps and no randomness, so running the generator
// twice produces a byte-identical manifest.

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

// Canonical payload order — the loader relies on exactly this ordering.
const PAYLOAD = [
  'js/app/platform.js',
  'js/app/api.js',
  'js/app/auth.js',
  'js/app/ui.js',
  'js/app/catalog.js',
  'js/app/player.js',
  'js/app/audio.js',
  'js/index.js',
  'css/app.css',
];

const FRONTEND_DIR = 'frontend';
const OUT_DIR = 'build/app';
const MANIFEST_PATH = `${OUT_DIR}/manifest.json`;

const checkOnly = process.argv.slice(2).includes('--check');

const appinfo = JSON.parse(fs.readFileSync(path.join(FRONTEND_DIR, 'appinfo.json')));

const files = [];

for (const relPath of PAYLOAD) {
  const sourcePath = path.join(FRONTEND_DIR, relPath);

  if (!fs.existsSync(sourcePath)) {
    console.error(`gen-bundle: ${sourcePath} not found — payload file missing`);
    process.exit(1);
  }

  const bytes = fs.readFileSync(sourcePath);

  files.push({
    path: relPath,
    type: relPath.endsWith('.css') ? 'css' : 'js',
    size: bytes.length,
    sha256: crypto.createHash('sha256').update(bytes).digest('hex'),
    bytes,
  });
}

const versionInput = files.map((file) => `${file.path}:${file.sha256}\n`).join('');
const bundleVersion = crypto.createHash('sha256').update(versionInput, 'utf8').digest('hex').slice(0, 16);

const document = {
  schema: 1,
  bundleVersion,
  appVersion: appinfo.version,
  files: files.map((file) => ({
    path: file.path,
    type: file.type,
    size: file.size,
    sha256: file.sha256,
  })),
};

const serialized = `${JSON.stringify(document, null, 2)}\n`;

if (checkOnly) {
  const current = fs.existsSync(MANIFEST_PATH) ? fs.readFileSync(MANIFEST_PATH, 'utf8') : null;

  if (current !== serialized) {
    console.error(`gen-bundle: ${MANIFEST_PATH} is out of date — run "npm run bundle"`);
    process.exit(1);
  }

  console.log(`gen-bundle: ${MANIFEST_PATH} is up to date (${bundleVersion})`);
  process.exit(0);
}

for (const file of files) {
  const targetPath = path.join(OUT_DIR, file.path);

  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  fs.writeFileSync(targetPath, file.bytes);
}

fs.mkdirSync(OUT_DIR, { recursive: true });
fs.writeFileSync(MANIFEST_PATH, serialized);

console.log(`gen-bundle: wrote ${MANIFEST_PATH}`);
console.log(`  bundleVersion ${bundleVersion}`);
console.log(`  files         ${document.files.length}`);

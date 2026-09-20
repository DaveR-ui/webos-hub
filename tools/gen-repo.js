#!/usr/bin/env node

// Generates the Homebrew Channel repository document ({"packages":[...]}) for this fork.
//
// Usage:
//   node tools/gen-repo.js [baseUrl] [outfile]
//
//   baseUrl  HTTPS root the repository is served from (default: the fork's GitHub Pages site,
//            or $HBC_REPO_BASE_URL when set). Trailing slashes are ignored.
//   outfile  where to write the document (default: build/repo.json)
//
// The document embeds the manifest (never a manifestUrl): GitHub release assets do not send
// access-control-allow-origin, so a separate manifest fetch fails from HBC's webview.

const crypto = require('crypto');
const fs = require('fs');

const DEFAULT_BASE_URL = 'https://daver-ui.github.io/webos-hub';
const IPK_DIRECTORY = 'ipk';
const ICON_PATH = 'icons/jellyfin.png';
const SOURCE_URL = 'https://github.com/DaveR-ui/webos-hub';

const baseUrl = (process.argv[2] || process.env.HBC_REPO_BASE_URL || DEFAULT_BASE_URL).replace(/\/+$/, '');
const outfile = process.argv[3] || 'build/repo.json';

const appinfo = JSON.parse(fs.readFileSync('frontend/appinfo.json'));
const ipkfile = `${appinfo.id}_${appinfo.version}_all.ipk`;
const ipkPath = `build/${ipkfile}`;

if (!fs.existsSync(ipkPath)) {
  console.error(`gen-repo: ${ipkPath} not found — run "npm run package" first`);
  process.exit(1);
}

const sha256 = crypto.createHash('sha256').update(fs.readFileSync(ipkPath)).digest('hex');
const iconUri = `${baseUrl}/${ICON_PATH}`;
const ipkUrl = `${baseUrl}/${IPK_DIRECTORY}/${ipkfile}`;

const document = {
  packages: [
    {
      id: appinfo.id,
      title: appinfo.title,
      iconUri,
      rootRequired: false,
      manifest: {
        id: appinfo.id,
        version: appinfo.version,
        type: appinfo.type,
        title: appinfo.title,
        appDescription: appinfo.appDescription,
        iconUri,
        sourceUrl: SOURCE_URL,
        rootRequired: false,
        ipkUrl,
        ipkHash: {
          sha256,
        },
      },
    },
  ],
};

fs.writeFileSync(outfile, `${JSON.stringify(document, null, 2)}\n`);

console.log(`gen-repo: wrote ${outfile}`);
console.log(`  ipkUrl  ${ipkUrl}`);
console.log(`  iconUri ${iconUri}`);
console.log(`  sha256  ${sha256}`);

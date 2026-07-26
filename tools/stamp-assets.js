#!/usr/bin/env node
/**
 * tools/stamp-assets.js — cache-busting stamper for index.html.
 *
 * This app has no build step: index.html references ./js/*.js and ./css/*.css
 * by plain path. GitHub Pages serves those with caching headers, so a returning
 * browser keeps its copies — and, worse, refreshes them at different times.
 * That means a deploy can leave a user running *some* new files against *some*
 * old ones, which fails in stranger ways than being entirely out of date. A
 * blank map after a basemap change was exactly that.
 *
 * Appending `?v=<version>` to every local asset makes each release a distinct
 * URL, so a deploy is all-or-nothing and a hard refresh is never required.
 *
 * Usage:
 *   node tools/stamp-assets.js              # stamp with the current UTC time
 *   node tools/stamp-assets.js 5.2.0        # stamp with an explicit version
 *   node tools/stamp-assets.js --check      # exit 1 if anything is unstamped
 *
 * Run it before committing whenever a .js or .css file changed.
 */

const fs = require('fs');
const path = require('path');

const HTML = path.join(__dirname, '..', 'index.html');
/** Matches src/href for local js/css assets, capturing any existing ?v=. */
const ASSET = /((?:src|href)=")(\.\/(?:js|css|vendor)\/[^"?]+)(\?v=[^"]*)?(")/g;

function currentVersion() {
  const d = new Date();
  const p = n => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}-${p(d.getUTCHours())}${p(d.getUTCMinutes())}`;
}

function main() {
  const arg = process.argv[2];
  const check = arg === '--check';
  const version = (!arg || check) ? currentVersion() : arg;
  const html = fs.readFileSync(HTML, 'utf8');

  if (check) {
    const missing = [];
    let m;
    const re = new RegExp(ASSET.source, 'g');
    while ((m = re.exec(html))) if (!m[3]) missing.push(m[2]);
    if (missing.length) {
      console.error('Unstamped assets (run: node tools/stamp-assets.js):');
      missing.forEach(f => console.error('  ' + f));
      process.exit(1);
    }
    console.log('All assets carry a ?v= stamp.');
    return;
  }

  let count = 0;
  const out = html.replace(ASSET, (_, pre, file, __, post) => {
    count++;
    return `${pre}${file}?v=${version}${post}`;
  });
  fs.writeFileSync(HTML, out);
  console.log(`Stamped ${count} assets with ?v=${version}`);
}

main();

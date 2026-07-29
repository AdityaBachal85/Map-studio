#!/usr/bin/env node
/**
 * tools/stamp-assets.js — version bumper and cache-busting stamper.
 *
 * This app has no build step: index.html references ./js/*.js and ./css/*.css
 * by plain path. GitHub Pages serves those with caching headers, so a returning
 * browser keeps its copies — and, worse, refreshes them at different times.
 * That means a deploy can leave a user running *some* new files against *some*
 * old ones, which fails in stranger ways than being entirely out of date. A
 * blank map after a basemap change was exactly that.
 *
 * Appending `?v=<APP_VERSION>` to every local asset makes each release a
 * distinct set of URLs, so a deploy is all-or-nothing and a hard refresh is
 * never required.
 *
 * The stamp is deliberately the same string the sidebar displays. If the
 * version on screen is not the one that was released, the browser is on a stale
 * build — a diagnosis that otherwise costs a round of debugging.
 *
 * Usage:
 *   node tools/stamp-assets.js --bump   # 5.0000 -> 5.0001, then stamp   [usual]
 *   node tools/stamp-assets.js          # re-stamp at the current version
 *   node tools/stamp-assets.js 5.1000   # set an explicit version, then stamp
 *   node tools/stamp-assets.js --check  # exit 1 if anything is unstamped or stale
 *
 * Run it with --bump before committing whenever a .js or .css file changed.
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const HTML = path.join(ROOT, 'index.html');
const CONSTANTS = path.join(ROOT, 'js', 'constants.js');

/** Matches src/href for local js/css assets, capturing any existing ?v=. */
const ASSET = /((?:src|href)=")(\.\/(?:js|css|vendor)\/[^"?]+)(\?v=[^"]*)?(")/g;
/** The single declaration of APP_VERSION in js/constants.js. */
const VERSION_DECL = /(const APP_VERSION = ')([^']+)(';)/;

/** @returns {string} The version currently declared in js/constants.js. */
function readVersion() {
  const m = fs.readFileSync(CONSTANTS, 'utf8').match(VERSION_DECL);
  if (!m) throw new Error('APP_VERSION not found in js/constants.js');
  return m[2];
}

/**
 * Increment the trailing counter, preserving its width: 5.0000 -> 5.0001.
 * @param {string} v
 * @returns {string}
 */
function bumpVersion(v) {
  const m = v.match(/^(\d+)\.(\d+)$/);
  if (!m) throw new Error(`APP_VERSION "${v}" is not in <major>.<counter> form`);
  const next = String(parseInt(m[2], 10) + 1).padStart(m[2].length, '0');
  return `${m[1]}.${next}`;
}

/** Write a new version into js/constants.js. @param {string} v */
function writeVersion(v) {
  const src = fs.readFileSync(CONSTANTS, 'utf8');
  fs.writeFileSync(CONSTANTS, src.replace(VERSION_DECL, `$1${v}$3`));
}

/**
 * Stamp every local asset reference in index.html.
 * @param {string} version
 * @returns {number} assets stamped
 */
function stamp(version) {
  const html = fs.readFileSync(HTML, 'utf8');
  let count = 0;
  const out = html.replace(ASSET, (_, pre, file, __, post) => {
    count++;
    return `${pre}${file}?v=${version}${post}`;
  });
  fs.writeFileSync(HTML, out);
  return count;
}

/** Report anything unstamped or stamped at the wrong version. */
function check(version) {
  const html = fs.readFileSync(HTML, 'utf8');
  const problems = [];
  let m;
  const re = new RegExp(ASSET.source, 'g');
  while ((m = re.exec(html))) {
    if (!m[3]) problems.push(`unstamped  ${m[2]}`);
    else if (m[3] !== `?v=${version}`) problems.push(`stale ${m[3].slice(3)}  ${m[2]}`);
  }
  if (problems.length) {
    console.error(`Assets out of step with APP_VERSION ${version} (run: node tools/stamp-assets.js --bump):`);
    problems.forEach(p => console.error('  ' + p));
    process.exit(1);
  }
  console.log(`All assets stamped at v${version}.`);
}

function main() {
  const arg = process.argv[2];
  const current = readVersion();

  if (arg === '--check') return check(current);

  let version = current;
  if (arg === '--bump') version = bumpVersion(current);
  else if (arg && arg !== '--stamp') version = arg;

  if (version !== current) {
    writeVersion(version);
    console.log(`APP_VERSION ${current} -> ${version}`);
  }
  console.log(`Stamped ${stamp(version)} assets with ?v=${version}`);
}

main();

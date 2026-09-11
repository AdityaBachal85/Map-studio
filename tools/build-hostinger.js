#!/usr/bin/env node
/**
 * tools/build-hostinger.js — package the site for upload to Hostinger.
 *
 * WHY THIS EXISTS. The repository is 487 MB; the site inside it is about 7 MB.
 * `legacy/` alone is 473 MB of single-file build snapshots — 129 of them, each
 * a complete copy of the app. None of that belongs on a web host: it is build
 * output, it is regenerable with tools/build-single-file.js, and on a shared
 * plan it would spend most of the disk quota and a large share of the inode
 * allowance on files no visitor will ever request.
 *
 * `server/`, `tools/`, `diagnostics/`, `sql/` and `docs/` do not belong there
 * either. The .htaccess blocks all five, but blocking a directory and not
 * uploading it are different kinds of safe, and the second one cannot be
 * undone by a webserver config that did not load.
 *
 * WHAT IT PRODUCES. A dist/ directory holding exactly the files the running
 * site requests, and a .zip of it. Hostinger's File Manager extracts a zip in
 * place, so the whole deploy is: upload one file, right-click, Extract.
 *
 *   node tools/build-hostinger.js            # dist/ + dist-hostinger-<v>.zip
 *   node tools/build-hostinger.js --no-zip   # just dist/, for rsync or FTP
 *   node tools/build-hostinger.js --list     # print what would ship, change nothing
 *
 * It refuses to run against an unstamped tree, because a half-stamped upload
 * is the one failure this packaging cannot be seen to cause and would be
 * blamed for.
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const DIST = path.join(ROOT, 'dist');

/**
 * What ships.
 *
 * An ALLOW-list, not a deny-list. A deny-list is wrong by default: the next
 * directory somebody adds is published unless they remember to exclude it,
 * and the cost of forgetting is measured in what was in it. This way the cost
 * of forgetting is a missing file, which the site reports loudly on the first
 * page load.
 */
const SHIP_DIRS = ['css', 'js', 'vendor', 'assets'];
const SHIP_FILES = [
  'index.html', 'login.html', 'projects.html', '404.html',
  '.htaccess',
];

/** Never copied, wherever they turn up inside a shipped directory. */
const SKIP_NAMES = new Set(['.DS_Store', 'Thumbs.db', 'node_modules', '.git']);
const SKIP_EXT = new Set(['.md', '.log', '.cjs', '.sql', '.zip']);

const args = process.argv.slice(2);
const LIST_ONLY = args.includes('--list');
const NO_ZIP = args.includes('--no-zip');

/* ---------------------------------------------------------------------------
 * Refuse to package something that will not work
 * ------------------------------------------------------------------------ */

/** @returns {string} APP_VERSION as constants.js declares it */
function readVersion() {
  const src = fs.readFileSync(path.join(ROOT, 'js', 'constants.js'), 'utf8');
  const m = src.match(/APP_VERSION\s*=\s*['"]([\w.]+)['"]/);
  if (!m) throw new Error('APP_VERSION not found in js/constants.js');
  return m[1];
}

/**
 * The stamp check, run here rather than trusted.
 *
 * An upload where index.html asks for `?v=6.0228` and constants.js declares
 * 6.0229 puts every visitor on the freshness banner's wrong side: the page
 * reports itself stale, reloads, and is stale again. Catching it costs one
 * child process; not catching it costs a deploy.
 */
function assertStamped() {
  try {
    execFileSync(process.execPath, [path.join(ROOT, 'tools', 'stamp-assets.js'), '--check'],
      { stdio: 'pipe' });
  } catch (e) {
    const out = (e.stdout || Buffer.from('')).toString() + (e.stderr || Buffer.from('')).toString();
    console.error('\nRefusing to package: the tree is not stamped at one version.\n');
    console.error(out.trim() || String(e.message));
    console.error('\nRun:  node tools/stamp-assets.js --bump\n');
    process.exit(1);
  }
}

/* ---------------------------------------------------------------------------
 * Copying
 * ------------------------------------------------------------------------ */

let copied = 0, bytes = 0;
const manifest = [];

/** @param {string} rel a path relative to the repo root */
function copyFile(rel) {
  const from = path.join(ROOT, rel);
  const to = path.join(DIST, rel);
  const size = fs.statSync(from).size;
  manifest.push(rel);
  copied++; bytes += size;
  if (LIST_ONLY) return;
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.copyFileSync(from, to);
}

/** @param {string} rel a directory relative to the repo root */
function copyDir(rel) {
  const abs = path.join(ROOT, rel);
  if (!fs.existsSync(abs)) return;
  for (const name of fs.readdirSync(abs)) {
    if (SKIP_NAMES.has(name)) continue;
    const childRel = path.join(rel, name);
    const st = fs.statSync(path.join(ROOT, childRel));
    if (st.isDirectory()) { copyDir(childRel); continue; }
    if (SKIP_EXT.has(path.extname(name).toLowerCase())) continue;
    copyFile(childRel);
  }
}

/* ---------------------------------------------------------------------------
 * The one check that catches a missing file before a visitor does
 * ------------------------------------------------------------------------ */

/**
 * Every local src/href in the three entry pages must exist in dist/.
 *
 * This app loads 125 scripts in a load-bearing order and a missing one is not
 * a missing feature — it is a ReferenceError that halts the rest of the boot
 * sequence, so one absent file blanks the whole studio. The allow-list above
 * is exactly the kind of thing that goes one directory out of date, and this
 * is what makes that loud here instead of quiet in production.
 *
 * @returns {string[]} referenced paths that did not make it into dist/
 */
function missingReferences() {
  const gone = [];
  for (const page of ['index.html', 'login.html', 'projects.html', '404.html']) {
    const src = fs.readFileSync(path.join(ROOT, page), 'utf8');
    const re = /(?:src|href)="([^"]+)"/g;
    let m;
    while ((m = re.exec(src))) {
      let ref = m[1];
      if (/^(https?:|data:|blob:|#|mailto:)/.test(ref)) continue;
      ref = ref.split('?')[0].replace(/^\.\//, '').replace(/^\//, '');
      if (!ref) continue;
      const target = LIST_ONLY ? path.join(ROOT, ref) : path.join(DIST, ref);
      if (!fs.existsSync(target) && gone.indexOf(ref) < 0) gone.push(ref);
    }
  }
  return gone;
}

/* ---------------------------------------------------------------------------
 * Run
 * ------------------------------------------------------------------------ */

const version = readVersion();
assertStamped();

if (!LIST_ONLY) {
  fs.rmSync(DIST, { recursive: true, force: true });
  fs.mkdirSync(DIST, { recursive: true });
}

SHIP_FILES.forEach(f => {
  if (fs.existsSync(path.join(ROOT, f))) copyFile(f);
  else console.warn('  missing, not shipped: ' + f);
});
SHIP_DIRS.forEach(copyDir);

const gone = missingReferences();
if (gone.length) {
  console.error('\nRefusing to package: these are loaded by a page and are not in the build.\n');
  gone.forEach(g => console.error('  ' + g));
  console.error('\nAdd the directory to SHIP_DIRS in this file, then run it again.\n');
  process.exit(1);
}

const mb = (bytes / 1048576).toFixed(1);

if (LIST_ONLY) {
  console.log(manifest.join('\n'));
  console.log('\n' + copied + ' files, ' + mb + ' MB at v' + version);
  process.exit(0);
}

// A note next to the files saying what they are and when they were made.
// A dist/ found six months later with no version in it is a guess.
fs.writeFileSync(path.join(DIST, 'BUILD.txt'),
  'DBOT Map Studio\n'
  + 'version  ' + version + '\n'
  + 'built    ' + new Date().toISOString() + '\n'
  + 'files    ' + copied + '  (' + mb + ' MB)\n\n'
  + 'Upload the CONTENTS of this directory into public_html — including the\n'
  + 'hidden .htaccess file, which the File Manager only shows once "Show\n'
  + 'hidden files" is ticked in its settings.\n\n'
  + 'See docs/HOSTINGER-DEPLOY.md in the repository for the full procedure,\n'
  + 'including the four external services that need this domain added to them.\n');

let zipName = '';
if (!NO_ZIP) {
  zipName = 'map-studio-' + version + '-hostinger.zip';
  const zipPath = path.join(ROOT, zipName);
  fs.rmSync(zipPath, { force: true });
  try {
    // Zipped from inside dist/ so the archive has no wrapping folder: extracting
    // it in public_html puts index.html at public_html/index.html, not at
    // public_html/dist/index.html. That one level is the most common way a
    // first upload lands on a 403.
    execFileSync('zip', ['-rq', zipPath, '.', '-x', '.DS_Store'], { cwd: DIST });
  } catch (e) {
    console.warn('\n  zip unavailable — dist/ is built, archive it yourself:');
    console.warn('  cd dist && zip -r ../' + zipName + ' .\n');
    zipName = '';
  }
}

console.log('dist/  ' + copied + ' files, ' + mb + ' MB at v' + version);
if (zipName) {
  const zmb = (fs.statSync(path.join(ROOT, zipName)).size / 1048576).toFixed(1);
  console.log(zipName + '  ' + zmb + ' MB');
}

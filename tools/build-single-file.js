#!/usr/bin/env node
/**
 * tools/build-single-file.js — fold the whole app into one .html file.
 *
 * WHY
 *
 * `legacy/` keeps a frozen, openable copy of each stable version. The app is 63
 * scripts, 7 stylesheets, 6 vendored libraries and 2 fonts spread across
 * directories; a snapshot has to be one file that still runs years later, on a
 * machine with no server, no npm and no network.
 *
 * WHY EVERYTHING IS INLINED, INCLUDING THE LIBRARIES
 *
 * The older snapshots in `legacy/` pull Leaflet and html2canvas from a CDN. That
 * is a dependency on someone else's uptime and on a *version* — those files ask
 * for Leaflet 1.9.4 while this app is written against the 1.1.1 that is vendored
 * here, and the APIs differ. An archive that breaks when a CDN reorganises is not
 * an archive, so this inlines the vendored copies and the fonts too. The result
 * is a few megabytes and has no external dependency except map tiles.
 *
 * WHY IT READS index.html RATHER THAN A LIST
 *
 * The load order of 63 classic scripts is load-bearing and lives in index.html.
 * Duplicating it here would mean two lists to keep in step, and the failure —
 * a script running before the global it needs exists — is not obvious. This
 * parses the real order out of the real file.
 *
 * USAGE
 *   node tools/build-single-file.js [outfile]
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const read = p => fs.readFileSync(path.join(ROOT, p), 'utf8');
const readBin = p => fs.readFileSync(path.join(ROOT, p));
const strip = href => href.replace(/^\.\//, '').split('?')[0];

/** A literal `</script>` inside inlined JS or CSS would close the tag early. */
const safe = code => code.replace(/<\/script>/gi, '<\\/script>');

/** Inline any url(...) that points at a vendored font, as a data URI. */
function inlineFontUrls(css) {
  return css.replace(/url\(["']?([^"')]*vendor\/fonts\/[^"')?]+)(\?[^"')]*)?["']?\)/g, (m, rel) => {
    const file = path.join('vendor', 'fonts', path.basename(rel));
    if (!fs.existsSync(path.join(ROOT, file))) {
      console.warn('  ! font not found, left as-is:', rel);
      return m;
    }
    const b64 = readBin(file).toString('base64');
    return `url("data:font/woff2;base64,${b64}") format("woff2")`.replace(/ format\("woff2"\)$/, '');
  });
}

/** Resolve main.css's @import list, in order. */
function flattenCss(entry) {
  const src = read(entry);
  const dir = path.dirname(entry);
  const out = [];
  const re = /@import\s+['"]([^'"]+)['"]\s*;/g;
  let m, found = false;
  while ((m = re.exec(src))) {
    found = true;
    const child = path.normalize(path.join(dir, strip(m[1])));
    out.push(`/* ===== ${child} ===== */\n` + inlineFontUrls(read(child)));
  }
  if (!found) out.push(inlineFontUrls(src));
  return out.join('\n\n');
}

function build(outRel) {
  let html = read('index.html');

  // 1. Collect the stylesheets in document order, then remove their tags.
  const cssParts = [];
  html = html.replace(/[ \t]*<link[^>]+rel=["']stylesheet["'][^>]*>\s*\n?/gi, tag => {
    const href = (tag.match(/href=["']([^"']+)["']/) || [])[1];
    if (!href) return '';
    const file = strip(href);
    cssParts.push(file.endsWith('main.css')
      ? flattenCss(file)
      : `/* ===== ${file} ===== */\n` + inlineFontUrls(read(file)));
    return '';
  });

  // 2. The font preload has nothing left to point at once the font is a data URI.
  html = html.replace(/[ \t]*<link[^>]+rel=["']preload["'][^>]*>\s*\n?/gi, '');

  // 3. Collect the scripts in document order, then remove their tags.
  const jsParts = [];
  html = html.replace(/[ \t]*<script[^>]+src=["']([^"']+)["'][^>]*>\s*<\/script>\s*\n?/gi, (tag, src) => {
    const file = strip(src);
    if (!fs.existsSync(path.join(ROOT, file))) {
      console.warn('  ! missing script, skipped:', file);
      return '';
    }
    jsParts.push({ file, code: read(file) });
    return '';
  });

  // 4. Put the two bundles back where their tags were.
  //
  // The replacements are FUNCTIONS, not strings, and that is load-bearing.
  // `String.replace` with a string replacement expands `$&`, `` $` ``, `$'` and
  // `$n` inside it. The app builds an Excel range as '$A$2:$A$' + last, so the
  // `$'` in that literal was expanded to "everything after the match" — which
  // spliced the tail of the document into the middle of a string and left one
  // script unparseable. A function replacement disables that expansion entirely.
  const styleBlock = '<style>\n' + safe(cssParts.join('\n\n')) + '\n</style>';
  html = html.replace('</head>', () => styleBlock + '\n</head>');

  const scriptBlock = jsParts
    .map(p => `<script>\n/* ===== ${p.file} ===== */\n${safe(p.code)}\n</script>`)
    .join('\n');
  html = html.replace('</body>', () => scriptBlock + '\n</body>');

  // 5. Say what this file is, at the top, for whoever opens it in five years.
  const version = (read('js/constants.js').match(/APP_VERSION\s*=\s*['"]([^'"]+)['"]/) || [])[1] || 'unknown';
  const banner = `<!--\n  DBOT Property Map Studio — v${version}\n`
    + `  Single-file snapshot built ${new Date().toISOString().slice(0, 10)} by tools/build-single-file.js\n\n`
    + `  Everything is inlined: ${cssParts.length} stylesheets, ${jsParts.length} scripts,\n`
    + `  the vendored libraries and both fonts. Open it directly in a browser — no\n`
    + `  server, no build, no network except the map tile providers.\n-->\n`;
  html = banner + html;

  fs.writeFileSync(path.join(ROOT, outRel), html);
  const kb = (Buffer.byteLength(html) / 1024).toFixed(0);
  console.log(`built ${outRel}  (v${version}, ${cssParts.length} css, ${jsParts.length} js, ${kb} KB)`);
  return { version, out: outRel };
}

const version = (read('js/constants.js').match(/APP_VERSION\s*=\s*['"]([^'"]+)['"]/) || [])[1];
build(process.argv[2] || `legacy/map-studio-v${version}.html`);

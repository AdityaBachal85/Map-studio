/**
 * The board's exports are documents, and this reads them back to prove it.
 *
 * The PDF that prompted all this was parsed by hand first: one page, one
 * /DCTDecode image, zero fonts, zero text objects, a portrait-shaped board on a
 * landscape sheet with 152pt of blank white down each side — forty per cent of
 * the paper. Everything asserted below is that investigation, automated, so the
 * same file can never be shipped again without something going red.
 *
 * The three writers share dashExportModel() and dashPdfBreaks(), so this also
 * checks they agree: the same board, the same cards, in all three.
 *
 *   python3 -m http.server 8000        # from the repo root
 *   node diagnostics/dash-export.cjs
 */
const { chromium } = require('playwright');
const fs = require('fs');
const os = require('os');
const path = require('path');

const BASE = 'http://127.0.0.1:8000';
const REPO = path.join(__dirname, '..');
const OUT = fs.mkdtempSync(path.join(os.tmpdir(), 'dash-export-'));
const localAuthConfig = () => fs.readFileSync(path.join(REPO, 'js', 'config.js'), 'utf8')
  .replace(/const SUPABASE_URL = '[^']*';/, "const SUPABASE_URL = '';")
  .replace(/const SUPABASE_ANON_KEY = '[^']*';/, "const SUPABASE_ANON_KEY = '';");

const R = [];
const ck = (n, p, d) => { R.push(p); console.log((p ? 'PASS ' : 'FAIL ') + n + (d ? '  — ' + d : '')); };

/** Every PDF string drawn with Tj, decoded from the raw bytes. */
function pdfStrings(buf) {
  return (buf.toString('latin1').match(/\((?:[^()\\]|\\.)*\)\s*Tj/g) || [])
    .map(t => t.slice(1, t.lastIndexOf(')')));
}

/**
 * Minimal zip reader: entry names, and one entry's bytes.
 *
 * Enough of the format to avoid a dependency, and it has to actually
 * DECOMPRESS: pptxgenjs deflates its parts while JSZip here stores them, so
 * searching the raw file for "<a:tbl>" finds nothing in a PPTX and everything
 * in a DOCX — which looks exactly like the PowerPoint writer being broken.
 */
function zipEntries(buf) {
  const out = {};
  const s = buf.toString('latin1');
  const re = /PK\x01\x02/g;
  let m;
  while ((m = re.exec(s))) {
    const at = m.index;
    const method = buf.readUInt16LE(at + 10);
    const compSize = buf.readUInt32LE(at + 20);
    const nameLen = buf.readUInt16LE(at + 28);
    const localAt = buf.readUInt32LE(at + 42);
    const name = buf.toString('utf8', at + 46, at + 46 + nameLen);
    // The local header repeats the name and adds its own extra field, and the
    // two extra-field lengths differ — so the data offset must be read there.
    const lNameLen = buf.readUInt16LE(localAt + 26);
    const lExtraLen = buf.readUInt16LE(localAt + 28);
    const start = localAt + 30 + lNameLen + lExtraLen;
    out[name] = { method, start, compSize };
  }
  return out;
}

/** @returns {string} one entry's text, inflated if it needs to be */
function zipText(buf, entries, name) {
  const e = entries[name];
  if (!e) return '';
  const raw = buf.subarray(e.start, e.start + e.compSize);
  if (e.method === 0) return raw.toString('utf8');
  try { return require('zlib').inflateRawSync(raw).toString('utf8'); }
  catch (err) { return ''; }
}

(async () => {
  const b = await chromium.launch({
    executablePath: process.env.CHROME || undefined,
    args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
  });
  const ctx = await b.newContext({ viewport: { width: 1500, height: 1000 }, acceptDownloads: true });
  const p = await ctx.newPage();
  const errs = []; p.on('pageerror', e => errs.push(e.message));
  await p.route('**', r => {
    const u = r.request().url();
    return (u.startsWith(BASE) || u.startsWith('data:') || u.startsWith('blob:')) ? r.continue() : r.abort();
  });
  await p.route('**/js/config.js*', r =>
    r.fulfill({ status: 200, contentType: 'application/javascript', body: localAuthConfig() }));

  await p.goto(BASE + '/index.html', { waitUntil: 'domcontentloaded' });
  await p.waitForTimeout(3200);

  await p.evaluate(() => {
    map.setView([19.10, 72.88], 13, { animate: false });
    const site = addLocation({ name: 'Ashoka Site', lat: 19.10, lng: 72.88, type: 'site' });
    [['SVPN Police Academy', 19.12, 72.90, '#8B5CF6'],
      ['Shivarampalli Railway Station', 19.08, 72.90, '#EF4444']].forEach(([nm, lat, lng, col], i) => {
      const d = addLocation({ name: nm, lat, lng });
      const rt = addRoute();
      rt.fromId = site.id; rt.toId = d.id; rt.color = col; rt.labelText = ''; rt.cls = null;
      rt.alts = [{ d: (i + 1) * 600, t: (i + 1) * 180, coords: [[19.10, 72.88], [lat, lng]] }];
      rt.altIndex = 0;
    });
    rebuildLegend();
  });
  await p.evaluate(() => setAppMode('dashboard'));
  await p.waitForTimeout(2400);
  // One card with real content, so "everything is empty" cannot pass vacuously.
  await p.evaluate(() => {
    const t = dashCards.find(c => c.title === 'Executive summary');
    if (t) t.body = 'The site sits inside the Outer Ring Road.';
    renderDashboard();
  });
  await p.waitForTimeout(900);

  /** Run one export and return the saved file. */
  const grab = async (kind, ext) => {
    const wait = p.waitForEvent('download');
    await p.evaluate(k => dashExport(k), kind);
    const d = await wait;
    const file = path.join(OUT, kind + '.' + ext);
    await d.saveAs(file);
    return fs.readFileSync(file);
  };

  /* ---- PDF ---------------------------------------------------------------- */

  const pdf = await grab('pdf-a4', 'pdf');
  const raw = pdf.toString('latin1');

  const boxes = [...raw.matchAll(/\/MediaBox \[0 0 ([\d.]+) ([\d.]+)\]/g)]
    .map(m => ({ w: +m[1], h: +m[2] }));
  ck('the PDF has at least one page with a real MediaBox', boxes.length > 0, JSON.stringify(boxes[0]));

  const board = await p.evaluate(() => {
    const g = document.getElementById('dashGrid');
    return { w: g.getBoundingClientRect().width, h: g.scrollHeight };
  });
  const wantLandscape = board.w / board.h > 1.15;
  ck('the page is turned to suit the board, not fixed landscape',
    (boxes[0].w > boxes[0].h) === wantLandscape,
    'board ' + Math.round(board.w) + '×' + Math.round(board.h)
      + ' → ' + (boxes[0].w > boxes[0].h ? 'landscape' : 'portrait'));

  // THE 40%-MARGIN REGRESSION. The old writer centred one image with a uniform
  // fit, so a portrait board on a landscape sheet left 152pt of white down each
  // side. Content now spans the page's full text width.
  const cm = raw.match(/([\d.]+) 0 0 ([\d.]+) ([\d.]+) ([\d.]+) cm/);
  ck('nothing is letterboxed into the middle of the sheet',
    !cm || (+cm[3]) < boxes[0].w * 0.25,
    cm ? 'first image starts ' + (+cm[3]).toFixed(0) + 'pt from the left of ' + boxes[0].w.toFixed(0) : 'no image');

  const fonts = [...new Set((raw.match(/\/BaseFont\s*\/([A-Za-z-]+)/g) || []))];
  ck('the PDF carries fonts at all — it used to carry none',
    fonts.length > 0, fonts.join(', '));

  const strings = pdfStrings(pdf);
  ck('and real text objects, not just pixels', strings.length > 10, strings.length + ' strings');
  ck('the project is named on the page', strings.some(s => /Ashoka Site/.test(s)),
    strings.slice(0, 2).join(' | '));
  ck('a card\'s content is text, so the file is searchable',
    strings.some(s => /Outer Ring Road/.test(s)));
  ck('the access rows are text too', strings.some(s => /SVPN Police Academy/.test(s)));
  ck('the page is numbered', strings.some(s => /Page \d+ of \d+/.test(s)),
    strings.filter(s => /Page/.test(s)).join(' | '));

  // The editor prompts must never reach a file: they instruct a reader who has
  // no board and no controls.
  const prompts = strings.filter(s =>
    /turn on Edit board|Type the summary that opens|type values in the Format pane/i.test(s));
  ck('no editor prompt is printed into the document', prompts.length === 0, prompts.join(' | '));

  ck('the map is in there as an image', /\/Subtype \/Image/.test(raw));

  /* ---- PPTX --------------------------------------------------------------- */

  const pptx = await grab('pptx', 'pptx');
  const pentries = zipEntries(pptx);
  const pnames = Object.keys(pentries);
  ck('the PPTX is a valid package with a slide in it',
    pnames.indexOf('[Content_Types].xml') >= 0 && pnames.some(n => /^ppt\/slides\/slide\d+\.xml$/.test(n)),
    pnames.length + ' entries');

  const slideXml = zipText(pptx, pentries, 'ppt/slides/slide1.xml');
  ck('and its slide XML is readable', slideXml.length > 200, slideXml.length + ' bytes');
  ck('its cards are native tables, not pictures of tables',
    (slideXml.match(/<a:tbl>/g) || []).length > 0,
    (slideXml.match(/<a:tbl>/g) || []).length + ' tables');
  ck('and real text runs', (slideXml.match(/<a:t>/g) || []).length > 10,
    (slideXml.match(/<a:t>/g) || []).length + ' runs');
  // pptxgenjs emits duplicate shape ids and PowerPoint refuses to open the file;
  // ensureUniqueShapeIds exists for exactly that and must be running here too.
  const ids = (slideXml.match(/<p:cNvPr id="(\d+)"/g) || []).map(s => s.match(/\d+/)[0]);
  ck('every shape id is unique, so PowerPoint will open it',
    ids.length > 0 && new Set(ids).size === ids.length,
    ids.length + ' shapes, ' + new Set(ids).size + ' distinct ids');

  /* ---- DOCX --------------------------------------------------------------- */

  const docx = await grab('docx', 'docx');
  const dentries = zipEntries(docx);
  const dnames = Object.keys(dentries);
  ck('the DOCX is a valid package',
    ['[Content_Types].xml', 'word/document.xml', 'word/_rels/document.xml.rels']
      .every(n => dnames.indexOf(n) >= 0),
    dnames.length + ' entries');

  const docXml = zipText(docx, dentries, 'word/document.xml');
  ck('it is headings, paragraphs and tables rather than one image',
    (docXml.match(/<w:tbl>/g) || []).length > 0 && (docXml.match(/<w:p>/g) || []).length > 10,
    (docXml.match(/<w:tbl>/g) || []).length + ' tables, '
      + (docXml.match(/<w:p>/g) || []).length + ' paragraphs');
  ck('the map travels with it', dnames.some(n => /^word\/media\/.+\.jpg$/.test(n)),
    dnames.filter(n => n.startsWith('word/media')).join(', '));
  ck('and it carries the same title the PDF does', /Ashoka Site/.test(docXml));

  /* ---- the three agree ------------------------------------------------------ */

  const names = ['SVPN Police Academy', 'Shivarampalli Railway Station'];
  // Joined, because a name too long for its card is WRAPPED — and a wrapped
  // line is a separate text object, so "Shivarampalli Railway Station" is two
  // strings in the file and none of them is the whole name.
  const pdfAll = strings.join(' ');
  const missing = {
    pdf: names.filter(n => pdfAll.indexOf(n) < 0),
    pptx: names.filter(n => slideXml.indexOf(n) < 0),
    docx: names.filter(n => docXml.indexOf(n) < 0),
  };
  ck('all three formats name the same places, from the one model',
    !missing.pdf.length && !missing.pptx.length && !missing.docx.length,
    JSON.stringify(missing));

  ck('no page errors', errs.length === 0, errs.slice(0, 3).join(' // ') || 'none');
  await b.close();
  try { fs.rmSync(OUT, { recursive: true, force: true }); } catch (e) { /* leave it */ }
  console.log('\n' + R.filter(Boolean).length + '/' + R.length + ' passed');
  process.exit(R.every(Boolean) ? 0 : 1);
})().catch(e => { console.error('HARNESS ERROR', e); process.exit(2); });

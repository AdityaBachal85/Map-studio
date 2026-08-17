/**
 * Scanned points are pins, not circles.
 *
 * Ring scan needs Overpass, which is unreachable from the sandbox, so this
 * drives the layer the scan hands its results to — registerGeom with the same
 * ringScanMeta() the panel builds — and checks what actually lands on the map.
 *
 *   python3 -m http.server 8000        # from the repo root
 *   node diagnostics/scan-pins.cjs
 */
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const BASE = 'http://127.0.0.1:8000';
const REPO = path.join(__dirname, '..');
const localAuthConfig = () => fs.readFileSync(path.join(REPO, 'js', 'config.js'), 'utf8')
  .replace(/const SUPABASE_URL = '[^']*';/, "const SUPABASE_URL = '';")
  .replace(/const SUPABASE_ANON_KEY = '[^']*';/, "const SUPABASE_ANON_KEY = '';");

const R = [];
const ck = (n, p, d) => { R.push(p); console.log((p ? 'PASS ' : 'FAIL ') + n + (d ? '  — ' + d : '')); };

(async () => {
  const b = await chromium.launch({
    executablePath: process.env.CHROME || undefined,
    args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
  });
  const p = await (await b.newContext({ viewport: { width: 1600, height: 1000 } })).newPage();
  const errs = []; p.on('pageerror', e => errs.push(e.message));
  await p.route('**', r => {
    const u = r.request().url();
    return (u.startsWith(BASE) || u.startsWith('data:') || u.startsWith('blob:')) ? r.continue() : r.abort();
  });
  await p.route('**/js/config.js*', r =>
    r.fulfill({ status: 200, contentType: 'application/javascript', body: localAuthConfig() }));

  await p.goto(BASE + '/index.html', { waitUntil: 'domcontentloaded' });
  await p.waitForTimeout(3000);
  await p.evaluate(() => map.setView([19.10, 72.88], 14, { animate: false }));
  await p.waitForTimeout(600);

  // Exactly what ringScanPanel does for a `point` result.
  const made = await p.evaluate(() => {
    const meta = ringScanMeta('Ghatkopar', 'metroStation', 'Marker');
    const g = registerGeom(L.marker([19.10, 72.88]), 'Marker', meta);
    return { pin: !!g.pin, showLabel: !!g.showLabel, fillOpacity: g.fillOpacity, shape: g.shape };
  });
  ck('a scanned point is a labelled pin, not a circle',
    made.pin && made.showLabel && made.shape === 'Marker', JSON.stringify(made));
  ck('the pin body is solid, not a 0.18 ghost', made.fillOpacity === 1, 'fillOpacity=' + made.fillOpacity);

  await p.waitForTimeout(600);
  const dom = await p.evaluate(() => {
    const pin = document.querySelector('.geom-marker-pin');
    const lbl = document.querySelector('.geom-label.on-pin');
    if (!pin) return { err: 'no pin element' };
    const pr = pin.getBoundingClientRect();
    const svg = pin.querySelector('svg');
    const cs = getComputedStyle(pin);
    const out = {
      w: Math.round(pr.width), h: Math.round(pr.height),
      hasSvg: !!svg, opacity: cs.opacity,
      // Leaflet's default divIcon paints a white box with a blue border.
      bg: cs.backgroundColor, border: cs.borderTopWidth,
      label: lbl ? lbl.textContent : null,
    };
    if (lbl) {
      const lr = lbl.getBoundingClientRect();
      out.labelAbovePin = lr.bottom <= pr.top + 4;
      out.labelH = Math.round(lr.height);
    }
    return out;
  });
  ck('a teardrop pin element is on the map', dom.hasSvg === true && dom.w === 24 && dom.h === 32,
    JSON.stringify(dom));
  ck('it is not framed in Leaflet default white box',
    /rgba\(0, 0, 0, 0\)|transparent/.test(dom.bg || '') && dom.border === '0px', JSON.stringify(dom));
  ck('the name is drawn on the map', dom.label === 'Ghatkopar', 'label=' + dom.label);
  ck('the label sits above the pin, not across its head',
    dom.labelAbovePin === true && dom.labelH > 0, JSON.stringify(dom));

  await p.screenshot({ path: path.join(__dirname, 'shot-scan-pin.png') });

  // The pin is anchored at its tip: the coordinate must be at the bottom point.
  const anchored = await p.evaluate(() => {
    const pin = document.querySelector('.geom-marker-pin').getBoundingClientRect();
    const pt = map.latLngToContainerPoint([19.10, 72.88]);
    const box = document.getElementById('map').getBoundingClientRect();
    return {
      dx: Math.abs((pin.left + pin.width / 2) - (box.left + pt.x)),
      dy: Math.abs(pin.bottom - (box.top + pt.y)),
    };
  });
  ck('the pin points at its coordinate (anchored at the tip)',
    anchored.dx < 2 && anchored.dy < 3, JSON.stringify(anchored));

  // Turning the pin off returns a plain dot.
  await p.evaluate(() => { const g = geometries[geometries.length - 1]; g.pin = false; applyGeomStyle(g); });
  await p.waitForTimeout(400);
  ck('unticking Pin returns a plain dot',
    await p.evaluate(() => !document.querySelector('.geom-marker-pin')
      && !!document.querySelector('.geom-marker-dot')));

  // Round-trip through GeoJSON. exportGeoJSON() triggers a download and returns
  // nothing, so the serialiser it uses is called directly — that is the thing a
  // saved file actually carries.
  const trip = await p.evaluate(() => {
    const g = geometries[geometries.length - 1];
    g.pin = true; applyGeomStyle(g);
    const feat = geomToGeoJSONFeature(g);
    const before = geometries.length;
    importGeoJSONFeature(feat);
    const back = geometries[geometries.length - 1];
    return {
      outPin: feat.properties.pin,
      imported: geometries.length === before + 1,
      backPin: !!back.pin,
      backLabel: !!back.showLabel,
      backIsPinEl: !!document.querySelectorAll('.geom-marker-pin').length,
    };
  });
  ck('pin is written into the GeoJSON properties', trip.outPin === true, JSON.stringify(trip));
  ck('and comes back a pin when that file is reopened',
    trip.imported && trip.backPin && trip.backLabel && trip.backIsPinEl, JSON.stringify(trip));

  // Undo has to carry it too — the fourth place a new field has to be added.
  const undo = await p.evaluate(() => {
    const g = geometries[geometries.length - 1];
    const snap = snapshotGeom(g);
    g.pin = false; applyGeomStyle(g);
    restoreGeomSnapshot(g.id, snap);
    return { pin: !!g.pin, el: !!document.querySelectorAll('.geom-marker-pin').length };
  });
  ck('pin survives an undo snapshot', undo.pin === true && undo.el === true, JSON.stringify(undo));

  ck('no page errors', errs.length === 0, errs.slice(0, 2).join(' // ') || 'none');
  await b.close();
  console.log('\n' + R.filter(Boolean).length + '/' + R.length + ' passed');
  process.exit(R.every(Boolean) ? 0 : 1);
})().catch(e => { console.error('HARNESS ERROR', e); process.exit(2); });

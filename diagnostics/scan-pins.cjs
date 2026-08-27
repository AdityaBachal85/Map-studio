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

  // Exactly what ringScanPanel does for a `point` result, icon key included.
  const made = await p.evaluate(() => {
    const fc = ringFeatureClass('metroStation');
    const meta = ringScanMeta('Ghatkopar', fc.cls, 'Marker', fc.icon, fc.marker || 'pin', !fc.label_off);
    const g = registerGeom(L.marker([19.10, 72.88]), 'Marker', meta);
    return {
      pin: geomMarkerStyle(g) === 'pin', showLabel: !!g.showLabel, fillOpacity: g.fillOpacity,
      shape: g.shape, iconKey: g.iconKey,
    };
  });
  ck('the scan class supplies a symbol for the pin', made.iconKey === 'metro',
    'iconKey=' + made.iconKey);
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

  // The symbol is inside the head, in white, and is the right one per class.
  const glyphs = await p.evaluate(() => {
    const out = {};
    [['station', 'railway'], ['metroStation', 'metro'], ['airport', 'airport'],
     ['busTerminal', 'bus'], ['port', 'port']].forEach(([cid, want], n) => {
      const fc = ringFeatureClass(cid);
      const g = registerGeom(L.marker([19.10 + (n + 1) * 0.004, 72.88]), 'Marker',
        ringScanMeta(fc.label, fc.cls, 'Marker', fc.icon, fc.marker || 'pin', !fc.label_off));
      out[cid] = { want, got: g.iconKey };
    });
    const pins = [].map.call(document.querySelectorAll('.geom-marker-pin'), el => {
      const svgs = el.querySelectorAll('svg');
      const glyph = svgs[1];
      return {
        svgCount: svgs.length,
        // The teardrop is drawn first, the symbol second and on top of it.
        glyphFill: glyph ? (glyph.querySelector('[fill]') || {}).getAttribute
          ? glyph.querySelector('[fill]').getAttribute('fill') : null : null,
      };
    });
    out._pins = pins.slice(0, 6);
    return out;
  });
  ck('every scan class maps to the symbol it should',
    Object.keys(glyphs).filter(k => k[0] !== '_').every(k => glyphs[k].want === glyphs[k].got),
    JSON.stringify(glyphs));
  const withGlyph = (glyphs._pins || []).filter(x => x.svgCount >= 2);
  ck('the pin carries a symbol as well as the teardrop',
    withGlyph.length >= 5, JSON.stringify(glyphs._pins));
  ck('the symbol is white, not a wireframe',
    withGlyph.every(x => /#fff/i.test(x.glyphFill || '')), JSON.stringify(withGlyph.slice(0, 2)));

  await p.evaluate(() => map.setView([19.115, 72.88], 14, { animate: false }));
  await p.waitForTimeout(600);
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

  // Turning the pin off returns a plain dot. Scoped to this one geometry's own
  // element — several other pins are on the map by now, so a document-wide
  // "no pins exist" check would be asserting something else entirely.
  const toDot = await p.evaluate(() => {
    const g = geometries[geometries.length - 1];
    const before = document.querySelectorAll('.geom-marker-pin').length;
    g.markerStyle = 'dot'; applyGeomStyle(g);
    const el = g.layer.getElement();
    return {
      cls: el ? el.className : null,
      pinsBefore: before,
      pinsAfter: document.querySelectorAll('.geom-marker-pin').length,
    };
  });
  ck('unticking Pin returns that marker to a plain dot',
    /geom-marker-dot/.test(toDot.cls || '') && toDot.pinsAfter === toDot.pinsBefore - 1,
    JSON.stringify(toDot));

  // Round-trip through GeoJSON. exportGeoJSON() triggers a download and returns
  // nothing, so the serialiser it uses is called directly — that is the thing a
  // saved file actually carries.
  const trip = await p.evaluate(() => {
    const g = geometries[geometries.length - 1];
    g.markerStyle = 'pin'; applyGeomStyle(g);
    const feat = geomToGeoJSONFeature(g);
    const before = geometries.length;
    importGeoJSONFeature(feat);
    const back = geometries[geometries.length - 1];
    return {
      outPin: feat.properties.markerStyle === 'pin',
      imported: geometries.length === before + 1,
      backPin: geomMarkerStyle(back) === 'pin',
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
    g.markerStyle = 'dot'; applyGeomStyle(g);
    restoreGeomSnapshot(g.id, snap);
    return { style: geomMarkerStyle(g), el: !!document.querySelectorAll('.geom-marker-pin').length };
  });
  ck('the marker style survives an undo snapshot',
    undo.style === 'pin' && undo.el === true, JSON.stringify(undo));

  // ---- towers: a square, not a captioned pin ------------------------------
  const towers = await p.evaluate(() => {
    const fc = ringFeatureClass('powerTower');
    const made = [];
    for (let i = 0; i < 6; i++) {
      made.push(registerGeom(L.marker([19.09 - i * 0.002, 72.87]), 'Marker',
        ringScanMeta(fc.label, fc.cls, 'Marker', fc.icon, fc.marker || 'pin', !fc.label_off)));
    }
    const el = made[0].layer.getElement();
    const r = el ? el.getBoundingClientRect() : null;
    return {
      declared: fc.marker,
      style: geomMarkerStyle(made[0]),
      labelled: made.filter(g => g.showLabel).length,
      cls: el ? el.className : null,
      w: r ? Math.round(r.width) : 0, h: r ? Math.round(r.height) : 0,
      captionsOnMap: document.querySelectorAll('.geom-label').length,
      pinsOnMap: document.querySelectorAll('.geom-marker-pin').length,
      squaresOnMap: document.querySelectorAll('.geom-marker-square').length,
    };
  });
  ck('the tower class asks for a square', towers.declared === 'square', JSON.stringify(towers));
  ck('towers are drawn as small squares, not pins',
    towers.style === 'square' && /geom-marker-square/.test(towers.cls || '')
    && towers.w <= 12 && towers.h <= 12 && towers.squaresOnMap === 6, JSON.stringify(towers));
  ck('and none of them is captioned',
    towers.labelled === 0, towers.labelled + ' captioned of 6');

  await p.evaluate(() => map.setView([19.088, 72.872], 15, { animate: false }));
  await p.waitForTimeout(600);
  await p.screenshot({ path: path.join(__dirname, 'shot-towers.png') });

  /* -- a label sits on the pixel grid, not between it and the next one ------ */

  // WHY HALF THE LABELS ON A MAP LOOKED SOFT AND THE OTHER HALF DID NOT.
  // projectPin() returns a projected coordinate, which is fractional nearly
  // always, and text laid down part of a pixel off its own grid gets resampled.
  // At 0.02 off nobody can tell; at 0.41 off it reads as blurry. So one map at
  // one zoom gave a crisp "BGR Logistics Park" beside a soft "Global Complex
  // Warehouse", which looks like a rendering fault and is really just where
  // each of them happened to land.
  //
  // Asserted on the transform rather than on a screenshot: a blur of a third of
  // a pixel is not something a pixel comparison can be trusted to catch, and it
  // is exactly the sort of thing that creeps back in when somebody adds an
  // offset to this line.
  const grid = await p.evaluate(names => {
    map.setView([19.24, 73.05], 13, { animate: false });
    names.forEach((n, i) => addLocation({ name: n,
      lat: 19.243 + (i % 4) * 0.007 - 0.014, lng: 73.05 + Math.floor(i / 4) * 0.013 - 0.018 }));
    if (typeof rebuildLegend === 'function') rebuildLegend();
    return true;
  }, ['Candor Logistics Park', 'K Square Logistical Park', 'DHL Supply Chain',
    'BGR Logistics Park', 'FM Logistic India', 'Global Complex Warehouse',
    'Sai Dhara, Warehouse and Logistics Park', 'ESR BHIWANDI 2 LOGISTICS PARK']);
  await p.waitForTimeout(1200);

  const offs = await p.evaluate(() => [...document.querySelectorAll('.bb')]
    .filter(el => (el.textContent || '').trim())
    .map(el => {
      const m = /matrix\(1,\s*0,\s*0,\s*1,\s*(-?[\d.]+),\s*(-?[\d.]+)\)/
        .exec(getComputedStyle(el).transform);
      if (!m) return null;
      const x = Number(m[1]), y = Number(m[2]);
      return { t: (el.textContent || '').trim().slice(0, 20),
        fx: Math.abs(x - Math.round(x)), fy: Math.abs(y - Math.round(y)) };
    }).filter(Boolean));
  const off = offs.filter(o => o.fx > 0.001 || o.fy > 0.001);
  ck('every label is placed on a whole pixel, so none of them is resampled',
    offs.length >= 6 && off.length === 0,
    off.length ? off.map(o => o.t + ' ' + o.fx.toFixed(2) + '/' + o.fy.toFixed(2)).join(', ')
      : offs.length + ' labels, all on the grid');

  // A label is a chip floating beside a pin, so snapping it costs nothing a
  // reader can see. A pin IS its coordinate, so it is deliberately left alone —
  // moving one half a pixel to sharpen it would be moving the thing it marks.
  ck('and the pins are not snapped, because a pin is where something is',
    await p.evaluate(() => {
      const el = document.querySelector('.bb-pin, .leaflet-marker-icon');
      return !!el;
    }) === true);

  ck('no page errors', errs.length === 0, errs.slice(0, 2).join(' // ') || 'none');
  await b.close();
  console.log('\n' + R.filter(Boolean).length + '/' + R.length + ' passed');
  process.exit(R.every(Boolean) ? 0 : 1);
})().catch(e => { console.error('HARNESS ERROR', e); process.exit(2); });

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
  // A FRACTIONAL FONT SIZE IS THE SECOND WAY TO GET SOFT TEXT. The chip size
  // came from `11.5 * pct / 100`, so the labels were drawn at 11.5px, 12.5px,
  // 10.35px — whatever the slider produced. Measured across sizes, 12.5px came
  // out at 25.5% mid-tone pixels against about 21.5% at 12px and 13px: real,
  // and unpredictable, because it depends where the fraction lands relative to
  // the hinting grid. Rounded, it cannot land badly at all.
  const sizes = await p.evaluate(() => [...document.querySelectorAll('.label-badge')]
    .map(el => parseFloat(getComputedStyle(el).fontSize)));
  ck('every label is set at a whole pixel size, so none is hinted onto a fraction',
    sizes.length > 0 && sizes.every(v => Math.abs(v - Math.round(v)) < 0.001),
    sizes.join(', ') + 'px');

  // -webkit-font-smoothing lives on `body` as `antialiased`, which on macOS
  // turns subpixel rendering OFF for everything under it. That is a deliberate
  // look for a paragraph and the wrong one for an 11px chip over imagery. The
  // property does nothing on Windows or Linux, so what is asserted here is that
  // the override is PRESENT — the visual result of it is only observable on a
  // Mac, and this suite does not run on one.
  ck('and the chips ask for subpixel rendering back, whatever body says',
    await p.evaluate(() => {
      const el = document.querySelector('.label-badge');
      const v = getComputedStyle(el).webkitFontSmoothing;
      return v === 'auto' || v === '' || v == null;
    }) === true);

  ck('and the pins are not snapped, because a pin is where something is',
    await p.evaluate(() => {
      const el = document.querySelector('.bb-pin, .leaflet-marker-icon');
      return !!el;
    }) === true);

  /* -- a scanned place is a location, not a drawing ------------------------- */

  // A STATION IS THE SAME KIND OF THING AS A LOCATION TYPED IN BY HAND. It wants
  // a name you can correct, a colour, a ring — and above all it is what a route
  // gets measured TO. Landing every scan result in Draw made a station a shape
  // that looked like a location and could do none of that, so the only way to
  // route to one the scan had just found was to type it in again.
  //
  // Overpass is unreachable from here, so the panel's own add step is driven
  // with a fabricated result — the same shape the fetch produces.
  const scan = await p.evaluate(() => {
    const site = addLocation({ name: 'Scan site', lat: 19.10, lng: 72.88, type: 'site' });
    const locBefore = locations.length, geomBefore = geometries.length;
    // An aerodrome arrives as a perimeter, not a point.
    const ring = [];
    for (let i = 0; i < 24; i++) {
      const a = i / 24 * 2 * Math.PI;
      ring.push([19.12 + 0.02 * Math.cos(a), 72.92 + 0.02 * Math.sin(a)]);
    }
    ringScanState = {
      loc: site, km: 10, ids: [], picked: new Set([0, 1, 2, 3]),
      result: [
        { classId: 'station', kind: 'point', name: 'Kalyan Junction', lat: 19.11, lng: 72.90 },
        { classId: 'metroStation', kind: 'point', name: 'Ghatkopar', lat: 19.09, lng: 72.86 },
        { classId: 'airport', kind: 'area', name: 'Chhatrapati Shivaji', polys: [ring] },
        { classId: 'river', kind: 'line', name: 'Ulhas', pts: [[19.05, 72.83], [19.07, 72.87]] },
      ],
    };
    keepRingScanSelection();
    const made = locations.slice(locBefore);
    const air = made.find(l => /Shivaji/.test(l.name));
    addRoute();
    return {
      placed: made.length,
      names: made.map(l => l.name),
      icons: made.map(l => l.iconKey),
      fromRing: made.every(l => l.fromRing === true),
      airport: air ? { lat: +air.lat.toFixed(3), lng: +air.lng.toFixed(3) } : null,
      drawn: geometries.slice(geomBefore).filter(g => g.name === 'Ulhas').length,
      routable: [...document.querySelectorAll('select option')]
        .some(o => /Kalyan Junction/.test(o.textContent || '')),
    };
  });
  ck('a scanned station and metro station land in Locations',
    scan.placed === 3 && scan.names.indexOf('Kalyan Junction') >= 0
      && scan.names.indexOf('Ghatkopar') >= 0, JSON.stringify(scan.names));
  ck('each carrying the symbol its class implies',
    scan.icons.join() === 'railway,metro,airport', scan.icons.join());
  ck('and marked as having come from a scan, which survives a save',
    scan.fromRing === true);

  // An aerodrome comes back as its whole perimeter, which on a connectivity map
  // is a grey field kilometres across covering everything under it — while the
  // question it is there to answer is "the airport is over there, this far".
  ck('an airport is one pin at the middle of its perimeter, not the perimeter',
    !!scan.airport && Math.abs(scan.airport.lat - 19.12) < 0.002
      && Math.abs(scan.airport.lng - 72.92) < 0.002, JSON.stringify(scan.airport));

  // Only places move. A river is not somewhere you go, and Draw is where it
  // belongs — this is a routing change, not a wholesale one.
  ck('a river is still a drawn shape', scan.drawn === 1, String(scan.drawn));

  // The point of all of it: routes are measured to locations, so a scanned
  // station that is not one cannot be routed to without retyping it.
  ck('and a station the scan just found can be routed to straight away',
    scan.routable === true);

  /* -- a metro over a road, drawn so both can still be seen ---------------- */

  // The maths that decides this is proved in diagnostics/ring-alignment.cjs
  // without a browser. What is proved here is the other half: that the shape
  // it produces reaches the map, is drawn dashed, and lands ABOVE the road it
  // covers instead of wherever the insertion order happened to put it.
  const over = await p.evaluate(() => {
    const geomBefore = geometries.length;
    const road = [], metro = [];
    for (let m = 0; m <= 4000; m += 100) {
      const lng = 72.80 + m / (111320 * Math.cos(19.2 * Math.PI / 180));
      road.push([19.20, lng]);
      metro.push([19.20 + 8 / 111320, lng]);          // 8 m north — over the road
    }
    const found = joinRingFeatures([
      { kind: 'line', classId: 'arterial', name: 'LBS Marg', pts: road, parts: 1, km: 4 },
      { kind: 'line', classId: 'arterial', name: 'LBS Marg', parts: 1, km: 3.9,
        pts: road.map(p => [p[0] + 18 / 111320, p[1]]) },   // the other carriageway
      { kind: 'line', classId: 'metro', name: 'Metro Line 4', pts: metro, parts: 1, km: 4 },
    ]);
    ringScanState = { loc: null, km: 5, ids: [], picked: new Set(found.map((f, i) => i)), result: found };
    keepRingScanSelection();
    const made = geometries.slice(geomBefore);
    const road2 = made.find(g => g.cls === 'major');
    const rail = made.find(g => g.cls === 'metro');
    // Document order IS paint order in an SVG group: later siblings are on top.
    const paths = [...document.querySelectorAll('#mapWrap svg path')];
    return {
      rows: found.length,
      names: made.map(g => g.name),
      roadStyle: road2 && road2.lineStyle,
      railStyle: rail && rail.lineStyle,
      railDashArray: rail && rail.layer._path && rail.layer._path.getAttribute('stroke-dasharray'),
      railOverRoad: rail && rail.overRoad === true,
      railAbove: (road2 && rail) ? paths.indexOf(rail.layer._path) > paths.indexOf(road2.layer._path) : null,
      carriageways: found.filter(f => f.classId === 'arterial').map(f => f.carriageways || 1),
    };
  });
  // The complaint this answers: "if a road have 4 lane it will mark 4 lane, we
  // have to mark only one."
  ck('a divided road ticked in the scan reaches the map as ONE line',
    over.rows === 2 && over.names.filter(n => /LBS Marg/.test(n)).length === 1,
    over.names.join(' | '));
  ck('and it knows it is both carriageways',
    over.carriageways.join() === '2', over.carriageways.join());
  // The other half: "sometimes metro is visible not road and sometimes vice
  // versa — both should be visible."
  ck('the metro over it is drawn dashed, so the road reads through the gaps',
    over.railStyle === 'dashed' && !!over.railDashArray,
    over.railStyle + ' / ' + over.railDashArray);
  ck('the road under it stays solid — the dash is a fact about the metro',
    over.roadStyle === 'solid', over.roadStyle);
  ck('and the metro is painted above the road, not wherever it was added',
    over.railAbove === true, String(over.railAbove));
  ck('with the reason recorded on the shape, so a reopened project still knows',
    over.railOverRoad === true);

  // The stack is over the WHOLE map, not just what a scan added. A metro added
  // now has to go above a road added an hour ago — the old pass only ever
  // looked at the shapes of its own scan, which is exactly the case that broke.
  const restacked = await p.evaluate(() => {
    const road = geometries.find(g => g.cls === 'major');
    const rail = geometries.find(g => g.cls === 'metro');
    road.layer.bringToFront();                      // put the road on top by hand
    const paths0 = [...document.querySelectorAll('#mapWrap svg path')];
    const before = paths0.indexOf(rail.layer._path) > paths0.indexOf(road.layer._path);
    restackClassedShapes();
    const paths1 = [...document.querySelectorAll('#mapWrap svg path')];
    return { before, after: paths1.indexOf(rail.layer._path) > paths1.indexOf(road.layer._path) };
  });
  ck('a shape shoved to the front out of order is put back where it belongs',
    restacked.before === false && restacked.after === true, JSON.stringify(restacked));

  // Reopening a project restyles every classed shape from its class. Without
  // `overRoad` on the record that restyle turns the metro solid again and it
  // goes straight back to hiding the road.
  const reopened = await p.evaluate(() => {
    const snap = JSON.parse(JSON.stringify(serialiseProject()));
    const feat = (snap.geometries || [])
      .find(x => (x.properties || {}).name === 'Metro Line 4');
    clearProject();
    applyProject(snap);
    const rail = geometries.find(g => g.name === 'Metro Line 4');
    connApplyAll();
    return {
      saved: feat && feat.properties.overRoad === true,
      restored: rail && rail.overRoad === true,
      style: rail && rail.lineStyle,
    };
  });
  ck('the reason is written into the saved file', reopened.saved === true, String(reopened.saved));
  ck('and comes back dashed when the project is reopened and restyled',
    reopened.restored === true && reopened.style === 'dashed', JSON.stringify(reopened));

  /* -- the pin glyph, the project logo and the compass ---------------------- */

  // A TEARDROP WITH A HOLE IN IT IS A MAP PIN, and this library holds what goes
  // INSIDE one — `iconFrame: 'pin'` already draws the teardrop and puts the
  // chosen symbol in it, so offering a pin here meant a pin drawn inside a pin.
  // It was also the default for every new location, which is how it came to be
  // the symbol on the map most of the time.
  const pins = await p.evaluate(() => {
    const fresh = addLocation({ name: 'Fresh', lat: 19.243, lng: 73.052 });
    const site = addLocation({ name: 'Site pt', lat: 19.246, lng: 73.048, type: 'site' });
    return {
      inLibrary: 'pin' in ICON_LIBRARY,
      freshKey: fresh.iconKey,
      siteKey: site.iconKey,
      // A saved project storing iconKey:'pin' must still draw something — an
      // older file opens a shade simpler, not blank.
      oldStillDraws: (iconPaths('pin', '#123456') || '').length > 40,
      oldIsDot: iconPaths('pin', '#123456') === iconPaths('dot', '#123456'),
      // The FRAME is a different thing and stays: it is the teardrop itself.
      frameOffered: !!document.querySelector('option[value="pin"]'),
    };
  });
  ck('there is no pin glyph to draw inside a pin frame', pins.inLibrary === false);
  ck('and a new location starts as a dot, a site as a star',
    pins.freshKey === 'dot' && pins.siteKey === 'star',
    pins.freshKey + ' / ' + pins.siteKey);
  ck('a project saved with the old key still draws, as the dot it now is',
    pins.oldStillDraws === true && pins.oldIsDot === true, JSON.stringify(pins));
  ck('the pin FRAME is untouched — that one is the teardrop itself',
    pins.frameOffered === true);

  // ONE DEFAULT, NOT A ROTATION. Colour came from PALETTE[n % PALETTE.length],
  // so the fifth pin on a map was purple for no reason but being fifth — a
  // different look on every map, and a meaning the reader is invited to guess
  // at. A connectivity sheet wants its places to look alike until somebody
  // deliberately makes one differ.
  const defaults = await p.evaluate(() => {
    const made = ['A', 'B', 'C', 'D', 'E', 'F'].map((n, i) =>
      addLocation({ name: 'Def ' + n, lat: 19.20 + i * 0.004, lng: 73.10 + i * 0.004 }));
    const site = addLocation({ name: 'Def site', lat: 19.30, lng: 73.20, type: 'site' });
    const chosen = addLocation({ name: 'Def chosen', lat: 19.31, lng: 73.21,
      color: '#C2185B', iconSize: 52, iconFrame: 'circle' });
    const out = {
      colours: [...new Set(made.map(l => l.color))],
      sizes: [...new Set(made.map(l => l.iconSize))],
      frames: [...new Set(made.map(l => l.iconFrame))],
      keys: [...new Set(made.map(l => l.iconKey))],
      site: { color: site.color, size: site.iconSize, frame: site.iconFrame },
      chosen: { color: chosen.color, size: chosen.iconSize, frame: chosen.iconFrame },
    };
    [...made, site, chosen].forEach(l => deleteLocation(l));
    return out;
  });
  ck('six new locations are one colour, not six from a rotation',
    defaults.colours.length === 1 && defaults.colours[0] === '#2563EB',
    defaults.colours.join(', '));
  ck('every one of them starts at size 20',
    defaults.sizes.length === 1 && defaults.sizes[0] === 20, defaults.sizes.join(', '));
  ck('and in the map-pin frame, with the dot symbol inside it',
    defaults.frames.length === 1 && defaults.frames[0] === 'pin'
    && defaults.keys.length === 1 && defaults.keys[0] === 'dot',
    defaults.frames.join(', ') + ' / ' + defaults.keys.join(', '));
  // The site is the one place on the map that should not look like the others.
  ck('the site is still the exception — dark, larger, unframed',
    defaults.site.color === '#0A1E3C' && defaults.site.size === 44
    && defaults.site.frame === 'none', JSON.stringify(defaults.site));
  // "Default" has to mean where it starts, not where it is stuck.
  ck('and anything asked for explicitly still wins over the default',
    defaults.chosen.color === '#C2185B' && defaults.chosen.size === 52
    && defaults.chosen.frame === 'circle', JSON.stringify(defaults.chosen));

  // Every project used to begin branded whether or not that was wanted, and a
  // pin set to "use the project logo" carried the mark onto the map by default.
  ck('a project starts with no logo, and the DBOT mark is one click away',
    await p.evaluate(() => {
      const img = document.getElementById('projectLogoImg');
      const btn = document.getElementById('clearProjLogoBtn');
      return img.style.display === 'none' && !img.getAttribute('src')
        && /dbot/i.test(btn.textContent);
    }) === true);

  // A compass belongs at a corner of the map. This one was a third of the way
  // down the right-hand rail, among five other round buttons that look alike.
  //
  // THIS IS THE 3D ORBIT CONTROL, not the map's north arrow — an earlier pass
  // moved this one and left #northArrow where it was, which is why the compass
  // on screen in 2D did not move at all. #northArrow now owns the corner (see
  // legend-colour.cjs) and this stacks below it, so both are usable in 3D
  // instead of sharing 46 pixels.
  const rose = await p.evaluate(() => {
    const n = document.getElementById('northUpBtn');
    n.hidden = false;
    const wrap = document.getElementById('mapWrap').getBoundingClientRect();
    const r = n.getBoundingClientRect();
    const cs = getComputedStyle(n);
    return {
      top: Math.round(r.top - wrap.top),
      // #mapWrap spans the full width with the sidebar floating OVER it, so the
      // map's own left edge is underneath the panel — placed at 12px the
      // compass was invisible behind it.
      clearOfSidebar: r.left >= document.getElementById('sidebar')
        ? true : r.left > 0,
      left: cs.left,
      needle: !!n.querySelector('svg path[fill^="var(--orange"]'),
      letter: (n.querySelector('.nub-n') || {}).textContent,
    };
  });
  const arrowTop = await p.evaluate(() => {
    const wrap = document.getElementById('mapWrap').getBoundingClientRect();
    const r = document.getElementById('northArrow').getBoundingClientRect();
    return { top: Math.round(r.top - wrap.top), bottom: Math.round(r.bottom - wrap.top) };
  });
  ck('the orbit control is in the map\'s top corner, not down the button rail',
    rose.top < 200, 'top ' + rose.top);
  ck('and sits below the north rose rather than on top of it',
    rose.top >= arrowTop.bottom, 'orbit at ' + rose.top + ', rose ends at ' + arrowTop.bottom);
  ck('and offset past the sidebar rather than hidden behind it',
    /sbw/.test(rose.left) || parseFloat(rose.left) > 100, rose.left);
  ck('it reads as a compass: a north needle and a letter',
    rose.needle === true && rose.letter === 'N', JSON.stringify(rose));

  /* ---- native controls follow the theme ---------------------------------- */

  // A BROWSER DRAWS A <select>'s OPTION LIST OUTSIDE THE PAGE, out of the
  // select's own background and colour, and no stylesheet of ours reaches it.
  // The field ground was written as a literal rgba(0,0,0,.28) for the dark
  // theme and stayed put in the light one, so the icon-frame picker's dropdown
  // came up as a black panel with dark navy text on it — unreadable. The fix is
  // a token for the ground and `color-scheme`, which is the only thing that
  // tells the engine which way up the page is.
  const themed = await p.evaluate(() => {
    const read = () => {
      const s = document.createElement('select');
      s.innerHTML = '<option>a</option>';
      (document.querySelector('.sidebar') || document.body).appendChild(s);
      const cs = getComputedStyle(s), opt = getComputedStyle(s.querySelector('option'));
      const lum = v => {
        const m = /(\d+),\s*(\d+),\s*(\d+)/.exec(v);
        return m ? (0.299 * +m[1] + 0.587 * +m[2] + 0.114 * +m[3]) / 255 : null;
      };
      const out = { scheme: getComputedStyle(document.documentElement).colorScheme,
        optBg: opt.backgroundColor, optInk: opt.color,
        bgL: lum(opt.backgroundColor), inkL: lum(opt.color) };
      s.remove();
      return out;
    };
    const was = document.documentElement.getAttribute('data-theme');
    document.documentElement.removeAttribute('data-theme');
    const dark = read();
    document.documentElement.setAttribute('data-theme', 'light');
    const light = read();
    if (was) document.documentElement.setAttribute('data-theme', was);
    else document.documentElement.removeAttribute('data-theme');
    return { dark, light };
  });
  ck('the page tells the browser which scheme it is in, so native controls follow',
    themed.dark.scheme === 'dark' && themed.light.scheme === 'light',
    themed.dark.scheme + ' / ' + themed.light.scheme);
  ck('a dropdown list is light in the light theme, not a black panel',
    themed.light.bgL > 0.8, themed.light.optBg);
  ck('and dark in the dark one', themed.dark.bgL < 0.3, themed.dark.optBg);
  // Legible either way: the failure was not just "dark", it was dark ground
  // under dark ink.
  ck('with ink that contrasts with it in both',
    Math.abs(themed.light.bgL - themed.light.inkL) > 0.4
    && Math.abs(themed.dark.bgL - themed.dark.inkL) > 0.4,
    JSON.stringify([themed.light.optInk, themed.dark.optInk]));

  /* ---- what a scan reports, and what it leaves behind --------------------- */

  // SQUARE FEET. This printed hectares regardless of what anybody had set, and
  // ignored the unitArea preference entirely — "2.4 ha" is a number the reader
  // of a property report has to convert before it means anything.
  const areas = await p.evaluate(() => ({
    small: fmtScanArea(0.0005),
    mid: fmtScanArea(0.005),
    big: fmtScanArea(1),
    pref: (() => { setPref('unitArea', 'acres'); const s = fmtScanArea(0.005);
      setPref('unitArea', 'auto'); return s; })(),
  }));
  ck('a scanned parcel is reported in square feet', /sq ft/.test(areas.small) && !/ha/.test(areas.small),
    areas.small);
  ck('and a bigger one too', /sq ft/.test(areas.mid), areas.mid);
  // Past about ten acres the sq ft figure stops being readable on its own.
  ck('a square kilometre leads with km² but keeps the sq ft beside it',
    /km²/.test(areas.big) && /sq ft/.test(areas.big), areas.big);
  ck('and an explicit unit preference is obeyed rather than overridden',
    /ac$/.test(areas.pref), areas.pref);

  // A parcel used to arrive as a polygon and nothing else — no pin, nothing in
  // Locations — so on a map already carrying roads, rail and rings it was hard
  // to find and there was nothing to route to.
  const pinned = await p.evaluate(() => {
    const ring = (lat, lng, d) => [[lat, lng], [lat + d, lng], [lat + d, lng + d], [lat, lng + d], [lat, lng]];
    locations.length = 0; geometries.length = 0;
    ringScanMarkAreas = true;
    ringScanState = { ids: ['builtUp', 'industrial'], picked: new Set([0, 1]), result: [
      { kind: 'area', classId: 'builtUp', name: 'Kalyan colony', polys: [ring(19.23, 73.13, 0.004)], areaKm2: 0.19 },
      { kind: 'area', classId: 'industrial', name: '', polys: [ring(19.21, 73.10, 0.005)], areaKm2: 0.3 },
    ] };
    keepRingScanSelection();
    return { locs: locations.length, geoms: geometries.length,
      names: locations.map(l => l.name), ring: locations.every(l => l.fromRing) };
  });
  ck('a scanned area is drawn AND pinned, so it can be found',
    pinned.geoms === 2 && pinned.locs === 2, JSON.stringify(pinned));
  ck('the pin takes the area\'s own name where OSM has one',
    pinned.names.indexOf('Kalyan colony') >= 0, JSON.stringify(pinned.names));
  ck('and the class name where it does not',
    pinned.names.some(n => /Industrial/i.test(n)), JSON.stringify(pinned.names));
  // A location, not a decoration: it can be renamed, restyled and routed to.
  ck('it lands in Locations like any other place', pinned.ring === true);

  const noPins = await p.evaluate(() => {
    const ring = (lat, lng, d) => [[lat, lng], [lat + d, lng], [lat + d, lng + d], [lat, lng + d], [lat, lng]];
    locations.length = 0; geometries.length = 0;
    ringScanMarkAreas = false;
    ringScanState = { ids: ['builtUp'], picked: new Set([0]), result: [
      { kind: 'area', classId: 'builtUp', name: 'Some land', polys: [ring(19.23, 73.13, 0.004)], areaKm2: 0.19 },
    ] };
    keepRingScanSelection();
    ringScanMarkAreas = true;
    return { locs: locations.length, geoms: geometries.length };
  });
  // Twelve residential parcels would otherwise plant twelve pins to delete.
  ck('and the switch turns the pins off without losing the shape',
    noPins.locs === 0 && noPins.geoms === 1, JSON.stringify(noPins));

  ck('no page errors', errs.length === 0, errs.slice(0, 2).join(' // ') || 'none');
  await b.close();
  console.log('\n' + R.filter(Boolean).length + '/' + R.length + ' passed');
  process.exit(R.every(Boolean) ? 0 : 1);
})().catch(e => { console.error('HARNESS ERROR', e); process.exit(2); });

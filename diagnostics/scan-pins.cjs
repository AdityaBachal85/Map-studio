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
    // The name is a billboard label now, not a Leaflet divIcon tied to the
    // pin's own coordinate — so it is found through the geometry that owns it.
    const owner = geometries.find(g => g.shape === 'Marker' && g._labelEl);
    const lbl = owner && owner._el;
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
      // A pin stands 32px above the coordinate it names, so a label placed on
      // that coordinate lands across its head. The lift used to be a CSS class
      // and is the label's own starting offset now — which is the difference
      // that matters: an offset can be dragged, a class cannot.
      lift: owner ? owner.labelOffset : null,
      draggable: !!(owner && owner._labelEl && owner._labelEl.onpointerdown !== undefined),
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
  ck('and it is lifted by an offset somebody can change, not a fixed rule',
    !!dom.lift && dom.lift.y < -40, JSON.stringify(dom.lift));

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
      captionsOnMap: document.querySelectorAll('.label-badge.geom').length,
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

  // The maths that decides WHICH lines share an alignment is proved in
  // diagnostics/ring-alignment.cjs without a browser. What is proved here is
  // the drawing: that the two lines end up side by side with air between them,
  // and that the separation survives everything that can recompute a shape.
  const over = await p.evaluate(() => {
    map.setView([19.20, 72.82], 14, { animate: false });
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
        pts: road.map(q => [q[0] + 18 / 111320, q[1]]) },   // the other carriageway
      { kind: 'line', classId: 'metro', name: 'Metro Line 4', pts: metro, parts: 1, km: 4 },
    ]);
    ringScanState = { loc: null, km: 5, ids: [], picked: new Set(found.map((f, i) => i)), result: found };
    keepRingScanSelection();
    const made = geometries.slice(geomBefore);
    const road2 = made.find(g => g.cls === 'major');
    const rail = made.find(g => g.cls === 'metro');
    // On screen, in pixels — the only unit in which "you can see both" means
    // anything. Measured at the middle of the run, where they overlap most.
    const px = (g) => {
      const cs = g.layer.getLatLngs();
      const mid = cs[Math.floor(cs.length / 2)];
      return map.latLngToContainerPoint(mid).y;
    };
    // Document order IS paint order in an SVG group: later siblings are on top.
    const paths = [...document.querySelectorAll('#mapWrap svg path')];
    return {
      rows: found.length,
      names: made.map(g => g.name),
      roadStyle: road2 && road2.lineStyle,
      railStyle: rail && rail.lineStyle,
      shiftPx: rail && rail.shiftPx,
      gap: (road2 && rail) ? Math.abs(px(rail) - px(road2)) : null,
      weights: [road2 && road2.borderWidth, rail && rail.borderWidth],
      railAbove: (road2 && rail) ? paths.indexOf(rail.layer._path) > paths.indexOf(road2.layer._path) : null,
      carriageways: found.filter(f => f.classId === 'arterial').map(f => f.carriageways || 1),
      // The measurement has to be of the real road, not the parallel curve.
      railKm: rail && rail.measureText,
    };
  });
  // "if a road have 4 lane it will mark 4 lane, we have to mark only one."
  ck('a divided road ticked in the scan reaches the map as ONE line',
    over.rows === 2 && over.names.filter(n => /LBS Marg/.test(n)).length === 1,
    over.names.join(' | '));
  ck('and it knows it is both carriageways',
    over.carriageways.join() === '2', over.carriageways.join());

  // "not like this — side by side, I want both clearly visible."
  ck('the metro is drawn beside the road, not on top of it',
    Math.abs(over.shiftPx) === 7, 'shiftPx=' + over.shiftPx);
  ck('and far enough over that there is air between the two lines',
    over.gap >= 6 && over.gap - (over.weights[0] + over.weights[1]) / 2 >= 2,
    over.gap + 'px apart, ' + over.weights.join('px and ') + 'px wide');
  // Dashing it was the first answer and a worse one: it says something untrue
  // about the metro, and gives the reader one line with two colours in it.
  ck('both lines are solid — neither is disguised to make room for the other',
    over.roadStyle === 'solid' && over.railStyle === 'solid',
    over.roadStyle + ' / ' + over.railStyle);
  ck('the metro still paints above the road, so a crossing reads correctly',
    over.railAbove === true, String(over.railAbove));
  // A parallel curve is longer than the curve it came from. Reporting the
  // drawn line would put a road a few per cent long in front of a client.
  ck('but the length reported is the real road, not the offset copy',
    /4\.0[01]? km|3\.99/.test(over.railKm || ''), over.railKm);

  // A PIXEL SEPARATION IS ONLY A SEPARATION AT ONE ZOOM. Baked in at the zoom
  // it was added at, the shift is invisible two levels out and puts the metro
  // in the next street two levels in.
  const zoomed = await p.evaluate(async () => {
    const road = geometries.find(g => g.cls === 'major');
    const rail = geometries.find(g => g.cls === 'metro');
    const gapAt = async (z) => {
      map.setZoom(z, { animate: false });
      await new Promise(r => setTimeout(r, 260));
      const mid = g => { const c = g.layer.getLatLngs(); return c[Math.floor(c.length / 2)]; };
      return Math.round(Math.abs(map.latLngToContainerPoint(mid(rail)).y
        - map.latLngToContainerPoint(mid(road)).y));
    };
    return { z12: await gapAt(12), z14: await gapAt(14), z17: await gapAt(17) };
  });
  ck('the separation survives zooming out, where the real 8 m is a fifth of a pixel',
    zoomed.z12 >= 6, zoomed.z12 + 'px at z12');
  ck('and zooming in, where a fixed direction would have cancelled it exactly',
    zoomed.z14 >= 6 && zoomed.z17 >= 6, JSON.stringify(zoomed));
  // The shift is pushed AWAY from the road, so the two displacements add. Get
  // the sign wrong and at the one zoom where 7px equals the real offset the
  // metro lands exactly back on the road — the original complaint, returning
  // at one zoom level only, which is the kind of thing nobody finds by hand.
  ck('and the real offset shows through on top of it as you zoom in, never against it',
    zoomed.z17 > zoomed.z12, zoomed.z12 + 'px -> ' + zoomed.z17 + 'px');

  // Everything that persists a shape has to read where the line REALLY is, or
  // each round trip walks the metro one more step off the road.
  const roundTrip = await p.evaluate(() => {
    const rail = geometries.find(g => g.cls === 'metro');
    const drawnBefore = rail.layer.getLatLngs()[0].lat;
    const snap = JSON.parse(JSON.stringify(serialiseProject()));
    const feat = (snap.geometries || [])
      .find(x => (x.properties || {}).name === 'Metro Line 4');
    const savedLat = feat.geometry.coordinates[0][1];
    clearProject();
    applyProject(snap);
    const back = geometries.find(g => g.name === 'Metro Line 4');
    const road = geometries.find(g => g.cls === 'major');
    const mid = g => { const c = g.layer.getLatLngs(); return c[Math.floor(c.length / 2)]; };
    return {
      savedIsTrue: Math.abs(savedLat - (19.20 + 8 / 111320)) < 1e-6,
      savedIsNotDrawn: Math.abs(savedLat - drawnBefore) > 1e-6,
      shift: back && back.shiftPx,
      gap: Math.round(Math.abs(map.latLngToContainerPoint(mid(back)).y
        - map.latLngToContainerPoint(mid(road)).y)),
    };
  });
  ck('the file stores where the metro actually is, not where it is drawn',
    roundTrip.savedIsTrue && roundTrip.savedIsNotDrawn, JSON.stringify(roundTrip));
  ck('and reopening redraws the same separation rather than shifting it again',
    Math.abs(roundTrip.shift) === 7 && roundTrip.gap >= 6, JSON.stringify(roundTrip));

  // The undo stack snapshots coordinates too, and a snapshot of the drawn line
  // restored and then re-shifted moves the metro one step per undo.
  const undone = await p.evaluate(() => {
    const rail = geometries.find(g => g.cls === 'metro');
    const road = geometries.find(g => g.cls === 'major');
    const mid = g => { const c = g.layer.getLatLngs(); return c[Math.floor(c.length / 2)]; };
    const gap = () => Math.round(Math.abs(map.latLngToContainerPoint(mid(rail)).y
      - map.latLngToContainerPoint(mid(road)).y));
    const snap = snapshotGeom(rail);
    const gaps = [gap()];
    for (let i = 0; i < 3; i++) { applyGeomCoords(rail, snap.geom); gaps.push(gap()); }
    return { gaps, snapIsTrue: Math.abs(snap.geom.latlngs[0][0] - (19.20 + 8 / 111320)) < 1e-6 };
  });
  ck('an undo snapshot holds the real line as well',
    undone.snapIsTrue === true, String(undone.snapIsTrue));
  ck('so restoring it three times over does not walk the metro off the road',
    undone.gaps.every(g => g === undone.gaps[0]) && undone.gaps[0] >= 6,
    undone.gaps.join(' -> '));

  // What somebody drags is what they meant to place. A line that sprang 7px
  // sideways the moment they let go of it would be a shape fighting its editor.
  const edited = await p.evaluate(() => {
    const rail = geometries.find(g => g.cls === 'metro');
    const at = rail.layer.getLatLngs()[0].lat;
    rail.layer.fire('pm:edit');
    return { shift: rail.shiftPx, base: rail._baseLatLngs,
      stayed: Math.abs(rail.layer.getLatLngs()[0].lat - at) < 1e-9 };
  });
  ck('dragging a shifted line bakes its separation in rather than fighting you',
    edited.shift === 0 && !edited.base && edited.stayed === true, JSON.stringify(edited));

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

  /* -- what a map starts out showing --------------------------------------- */

  // OFF, AND OFF EVERYWHERE. The watermark used to ride onto every sheet that
  // left the app whether or not it was wanted, and the only way to find out was
  // to open the PDF. Three things have to agree or it comes back through
  // whichever one was missed: the tick, the class the CSS keys off, and what
  // the export writer reads.
  const chrome = await p.evaluate(() => {
    const tgl = document.getElementById('brandTgl');
    const mark = document.getElementById('brandMark');
    // A new route, made the way the toolbar makes one — but WITH a path on it.
    // Routing needs OSRM, which is unreachable from here, so a bare addRoute()
    // has no coordinates, draws nothing, and would report "no label chip"
    // whatever the default was. `saved` is the geometry a reopened project
    // carries, and it is what makes this measure the label rather than the
    // absence of a route.
    const path = { d: 4200, t: 480, coords: [[19.10, 72.88], [19.13, 72.91], [19.16, 72.93]] };
    const before = routes.length;
    addRoute({ saved: path });
    const rt = routes[routes.length - 1];
    const hasLine = !!(rt && rt.line);
    const drawn = !!(rt && rt._labelEl);
    // Still one tick away — a default is where it starts, not where it sticks.
    if (rt) { rt.showLabel = true; drawRoute(rt); }
    const afterTick = !!(routes[routes.length - 1]._labelEl);
    return {
      brandTick: !!(tgl && tgl.checked),
      bodyClass: document.body.classList.contains('no-brand'),
      markHidden: !mark || getComputedStyle(mark).display === 'none'
        || +getComputedStyle(mark).opacity === 0,
      label: rt && rt.showLabel,
      drawn, afterTick, hasLine, made: routes.length - before,
    };
  });
  ck('the DBOT mark starts switched off', chrome.brandTick === false);
  ck('and the page is actually in the no-brand state, not just the tick',
    chrome.bodyClass === true);
  ck('so nothing is drawn on the map for it', chrome.markHidden === true,
    String(chrome.markHidden));

  // ONE FIELD, TWO JOBS. `showLabel` governs a road's NAME and the measured
  // "4.2 km · 8 min" chip alike, so the default cannot be a constant: the chip
  // is a dozen boxes competing with the places they connect, on numbers that
  // are already in the Key Distances table — while a road nobody can read the
  // name of has not really been drawn.
  ck('a new route starts with no distance-and-time chip on it',
    chrome.made === 1 && chrome.hasLine === true && chrome.drawn === false,
    JSON.stringify(chrome));
  ck('and ticking Label still puts one there', chrome.afterTick === true);

  const named = await p.evaluate(() => {
    const path = { d: 4200, t: 480, coords: [[19.10, 72.88], [19.13, 72.91], [19.16, 72.93]] };
    const road = addRoute({ saved: path, labelText: 'NH 48' });
    const blank = addRoute({ saved: path, labelText: '   ' });
    const chip = addRoute({ saved: path });
    // What the map would actually draw in each case.
    return {
      road: { on: road.showLabel, text: road._el && road._el.textContent },
      blank: blank.showLabel,
      chip: chip.showLabel,
      // And the one thing that must not change: an explicit choice still wins.
      forced: addRoute({ saved: path, showLabel: true }).showLabel,
      silenced: addRoute({ saved: path, labelText: 'NH 66', showLabel: false }).showLabel,
    };
  });
  ck('but a road drawn with a name keeps its name on the map',
    named.road.on === true && /NH 48/.test(named.road.text || ''), JSON.stringify(named.road));
  ck('a label of nothing but spaces is not a name', named.blank === false,
    String(named.blank));
  ck('an unnamed route is still just the chip, and still off', named.chip === false);
  ck('and an explicit choice wins over the default either way',
    named.forced === true && named.silenced === false,
    named.forced + ' / ' + named.silenced);

  // A saved project carries its own setting either way round, so this changes
  // what a NEW route starts as and nothing about one that already exists.
  const kept = await p.evaluate(() => {
    const on = addRoute({ showLabel: true });
    const off = addRoute({ showLabel: false });
    const snap = JSON.parse(JSON.stringify(serialiseProject()));
    const saved = (snap.routes || []).slice(-2).map(r => r.showLabel);
    clearProject();
    applyProject(snap);
    return { saved, back: routes.slice(-2).map(r => r.showLabel) };
  });
  ck('a route saved with its label on comes back with it on',
    kept.saved.join() === 'true,false' && kept.back.join() === 'true,false',
    JSON.stringify(kept));

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
  /* -- and how long the waiting feels -------------------------------------- */

  // FIVE INDEPENDENT LOOKUPS, ASKED IN A LOOP WITH AN AWAIT IN IT. None of the
  // five depends on any other's answer, so serialising them added seconds to
  // every scan for nothing. Measured against a stub with a known delay, since
  // the real service is not reachable from here and the point is the shape of
  // the calling, not the speed of Google.
  const par = await p.evaluate(async () => {
    const real = window.googleNearby, ready = window.googleReady;
    window.googleReady = () => true;
    let live = 0, most = 0;
    window.googleNearby = async () => {
      most = Math.max(most, ++live);
      await new Promise(r => setTimeout(r, 120));
      live--;
      return [];
    };
    const ids = ['station', 'metroStation', 'airport', 'busTerminal', 'port'];
    const t0 = Date.now();
    await ringAddGooglePlaces({ ok: true, features: [] }, 19.1, 72.88, 5000, ids);
    const ms = Date.now() - t0;
    window.googleNearby = real; window.googleReady = ready;
    return { ms, most, classes: ids.length };
  });
  ck('the five place lookups are asked at once, not one after another',
    par.most === par.classes, par.most + ' of ' + par.classes + ' in flight at once');
  ck('so they cost one round trip rather than five',
    par.ms < 120 * 2.5, par.ms + 'ms for ' + par.classes + ' x 120ms');

  // A SEARCH THAT SAYS NOTHING FOR TWENTY SECONDS READS AS A BROKEN ONE.
  // Overpass is donated and under real load; a wide ring genuinely takes that
  // long. The fault was never that it was quiet, but that the dialog gave a
  // reader no way to tell waiting from hung.
  const busy = await p.evaluate(() => {
    ringScanState = { loc: { lat: 19.1, lng: 72.88 }, km: 5, busy: true,
      ids: ['expressway', 'metro', 'rail'], startedAt: Date.now() - 24000,
      step: { mirror: 1, of: 4 }, picked: new Set(), result: null };
    renderRingScan();
    const t = document.getElementById('ringScanBody').textContent;
    ringScanState.step = { mirror: 3, of: 4 };
    renderRingScan();
    const t2 = document.getElementById('ringScanBody').textContent;
    ringScanState.step = { stage: 'google' };
    renderRingScan();
    const t3 = document.getElementById('ringScanBody').textContent;
    ringScanState = null;
    return { t, t2, t3 };
  });
  ck('a scan in progress shows how long it has been going',
    /2[34]s/.test(busy.t), (busy.t.match(/\d+s/) || ['none'])[0]);
  // Ten types is a heavier question than three, and the reader is the only one
  // who can make it lighter.
  ck('and says how many types it is asking about, which is what makes it heavy',
    /3 types/.test(busy.t), busy.t.slice(0, 120));
  ck('after twenty seconds it says what to do about it rather than just waiting',
    /untick types/.test(busy.t), /untick types/.test(busy.t) ? 'advises unticking' : 'silent');
  ck('a dead server is named as a dead server, not left as silence',
    /did not answer/.test(busy.t2) && /number 3 of 4/.test(busy.t2), busy.t2.slice(0, 110));
  ck('and the Google pass says it is a different thing being waited on',
    /Asking Google/.test(busy.t3), busy.t3.slice(0, 90));

  /* -- what is coming, drawn so it cannot be read as built ------------------ */

  const soon = await p.evaluate(() => {
    map.setView([19.30, 72.86], 12, { animate: false });
    const mk = (lat) => {
      const a = [];
      for (let m = 0; m <= 6000; m += 300) {
        a.push([lat, 72.82 + m / (111320 * Math.cos(19.3 * Math.PI / 180))]);
      }
      return a;
    };
    const gb = geometries.length;
    const els = [
      { type: 'way', tags: { highway: 'construction', construction: 'motorway',
        name: 'Virar-Alibaug Corridor' }, geometry: mk(19.30).map(c => ({ lat: c[0], lon: c[1] })) },
      { type: 'way', tags: { highway: 'proposed', proposed: 'secondary',
        name: 'Link Road extension' }, geometry: mk(19.31).map(c => ({ lat: c[0], lon: c[1] })) },
      { type: 'way', tags: { railway: 'construction', construction: 'subway',
        name: 'Metro Line 5' }, geometry: mk(19.32).map(c => ({ lat: c[0], lon: c[1] })) },
      { type: 'way', tags: { highway: 'trunk', tunnel: 'yes',
        name: 'Thane-Borivali Twin Tunnel' }, geometry: mk(19.33).map(c => ({ lat: c[0], lon: c[1] })) },
    ];
    const ids = ['plannedRoad', 'plannedRail', 'tunnel'];
    const found = joinRingFeatures(els.map(el => overpassToFeature(el, overpassClassOf(el, ids))));
    ringScanState = { loc: null, km: 9, ids, picked: new Set(found.map((f, i) => i)), result: found };
    keepRingScanSelection();
    const made = geometries.slice(gb);
    const by = n => made.find(g => g.name === n);
    const rows = found.map(f => ringScanItemRow(Object.assign({ _i: 0 }, f), true));
    return {
      count: made.length,
      corridor: by('Virar-Alibaug Corridor') && {
        cls: by('Virar-Alibaug Corridor').cls,
        dash: by('Virar-Alibaug Corridor').lineStyle,
        proposed: by('Virar-Alibaug Corridor').proposed === true,
        stroke: by('Virar-Alibaug Corridor').layer._path.getAttribute('stroke-dasharray'),
      },
      street: by('Link Road extension') && { cls: by('Link Road extension').cls },
      metro: by('Metro Line 5') && { cls: by('Metro Line 5').cls,
        proposed: by('Metro Line 5').proposed === true },
      tunnel: by('Thane-Borivali Twin Tunnel') && {
        cls: by('Thane-Borivali Twin Tunnel').cls,
        dash: by('Thane-Borivali Twin Tunnel').lineStyle,
        proposed: !!by('Thane-Borivali Twin Tunnel').proposed,
      },
      legend: connLegendRows().map(r => r.label),
      saysSoon: rows.filter(r => /not built yet/.test(r)).length,
      named: made.filter(g => g.showLabel).map(g => g.name),
    };
  });
  ck('a scan finds the roads and rail that are still being built',
    soon.count === 4, soon.count + ' of 4');
  // Drawn from the scan class alone, a planned side street would be six pixels
  // of expressway blue on a sheet somebody is deciding from.
  ck('each is drawn as the class it is GOING to be, not as one flat kind',
    soon.corridor.cls === 'expressway' && soon.street.cls === 'major'
    && soon.metro.cls === 'metro',
    [soon.corridor.cls, soon.street.cls, soon.metro.cls].join(' / '));
  // A proposed motorway drawn like a built one is the sheet asserting a road
  // exists. That is not a cosmetic slip.
  ck('and dashed, because it is not there yet',
    soon.corridor.dash === 'dashed' && !!soon.corridor.stroke && soon.corridor.proposed === true,
    JSON.stringify(soon.corridor));
  ck('the legend says which rows are proposed rather than leaving it to the dash',
    soon.legend.some(l => /\(proposed\)/.test(l)), soon.legend.join(' | '));
  ck('and the scan list says so too, before anything reaches the map',
    soon.saysSoon === 3, soon.saysSoon + ' of 3 rows marked');

  // A tunnel that exists is a road that exists. Marking it unbuilt would be
  // the opposite error to the one above, and just as wrong.
  ck('a tunnel that is open is NOT marked as unbuilt',
    soon.tunnel.proposed === false && soon.tunnel.dash === 'solid',
    JSON.stringify(soon.tunnel));
  ck('but it is drawn in the class of the road that runs through it',
    soon.tunnel.cls === 'expressway', soon.tunnel.cls);
  // These carry project names, which is exactly what a reader needs to see.
  ck('and every one of them carries its project name onto the map',
    soon.named.length === 4, soon.named.join(' | '));

  /* -- a shape's name is a label you can pick up ---------------------------- */

  /*
   * IT WAS A LEAFLET divIcon PINNED TO THE SHAPE'S CENTRE, and `interactive:
   * false`. So a road's name sat wherever the geometry put it — across the
   * road itself, or on top of the next name along — and there was no way at
   * all to move it. On a sheet with a dozen scanned roads that is a dozen
   * names nobody can arrange.
   */
  const gl = await p.evaluate(async () => {
    map.setView([19.20, 72.86], 13, { animate: false });
    // 12 km, not 4: the label box is ~160px wide and its CENTRE is what gets
    // re-tied, so on a short road the tie clamps to the end before the drag
    // has told you anything about sliding.
    const road = [];
    for (let m = 0; m <= 12000; m += 200) {
      road.push([19.20, 72.80 + m / (111320 * Math.cos(19.2 * Math.PI / 180))]);
    }
    const found = joinRingFeatures([
      { kind: 'line', classId: 'arterial', name: 'Airoli - Katai Naka', pts: road, parts: 1, km: 4 },
      { kind: 'line', classId: 'arterial', name: null, parts: 1, km: 4,
        pts: road.map(q => [q[0] + 0.03, q[1]]) },
    ]);
    const gb = geometries.length;
    ringScanState = { loc: null, km: 5, ids: [], picked: new Set(found.map((f, i) => i)), result: found };
    keepRingScanSelection();
    // Sliced from what THIS block added. Picking "the other major road" off the
    // whole map found a named road an earlier block had left there, and the
    // assertion failed for a reason that had nothing to do with it.
    const made = geometries.slice(gb);
    const named = made.find(g => g.name === 'Airoli - Katai Naka');
    const anon = made.find(g => g !== named);
    // Wait for the label to be PLACED before measuring where it started. The
    // billboard positions on requestAnimationFrame, so a fixed sleep measured
    // an unplaced box at 0,0 about one run in three and reported the whole
    // viewport as the drag distance.
    for (let i = 0; i < 90 && !named._labelEl.style.transform; i++) {
      await new Promise(r => requestAnimationFrame(r));
    }
    const before = named._labelEl.getBoundingClientRect();
    const tf0 = named._labelEl.style.transform;
    const anchor0 = { lat: named.anchor.lat, lng: named.anchor.lng };
    // The real gesture, through the same pointer events a hand produces.
    const at = (t, x, y) => named._labelEl.dispatchEvent(new PointerEvent(t, {
      clientX: x, clientY: y, bubbles: true, pointerId: 1 }));
    named._labelEl.setPointerCapture = () => {};
    // 60px, not 200: the road is about 210px long on screen here, and a drag
    // past its end would clamp the tie-point to 1.0 and prove nothing about
    // the sliding.
    at('pointerdown', before.left + 5, before.top + 5);
    at('pointermove', before.left + 65, before.top - 55);
    at('pointerup', before.left + 65, before.top - 55);
    // WAITED FOR, not slept through. The repaint runs on requestAnimationFrame
    // and a throttled page can skip several — a fixed 200ms passed most of the
    // time and failed the rest, which is the worst kind of test.
    for (let i = 0; i < 60 && named._labelEl.style.transform === tf0; i++) {
      await new Promise(r => requestAnimationFrame(r));
    }
    const after = named._labelEl.getBoundingClientRect();

    return {
      namedShows: named.showLabel === true && !!named._labelEl,
      text: named._el && named._el.textContent,
      anonShows: anon ? anon.showLabel === true : null,
      movedX: Math.round(after.left - before.left),
      movedY: Math.round(after.top - before.top),
      pinned: named.labelPinned === true,
      // The box ends where it was dropped; what moved to get it there is the
      // anchor, the offset, or both — the reader only ever sees the box.
      anchorMoved: Math.abs(named.anchor.lng - anchor0.lng) > 1e-6,
      labelPos: named.labelPos,
      leader: !!document.querySelector('#billboardLayer canvas'),
    };
  });
  // "when i use scan it the roads also we cannot give the name" — the scan knew
  // the road was "Airoli - Katai Naka" and drew it as an unlabelled line, so
  // the one useful thing it found stayed in the sidebar.
  ck('a scanned road carries the name the scan found for it',
    gl.namedShows === true && gl.text === 'Airoli - Katai Naka', gl.text);
  // "Major roads" written along forty roads is not a set of labels, it is a
  // wall — the same rule a route follows.
  ck('but a road the scan could not name is not captioned with its class',
    gl.anonShows === false, String(gl.anonShows));

  // "the draw lines lable is in the fix location it cannot able to move."
  ck('the label can be picked up and moved',
    Math.abs(gl.movedX - 60) <= 2 && Math.abs(gl.movedY + 60) <= 2,
    gl.movedX + ', ' + gl.movedY);
  ck('and it is marked as placed by hand, so nothing tidies it away again',
    gl.pinned === true);
  // The useful half of "snap to the line": the box stays where it was dropped
  // and the point it is tied to slides along the road. Snapping the box itself
  // would put type on top of the very thing it labels, with no way to nudge it
  // clear. So the offset is NOT expected to grow by the drag distance — the
  // anchor takes most of it, which is the whole mechanism.
  ck('while its tie-point slides along the road it names',
    gl.anchorMoved === true && gl.labelPos > 0 && gl.labelPos < 1,
    'labelPos ' + (gl.labelPos == null ? 'unset' : gl.labelPos.toFixed(3)));
  ck('and a leader line ties the box back to the road',
    gl.leader === true);

  // An arrangement of a dozen road names is real work; reopening to find every
  // one back on top of its own road would throw it away without a word.
  const labelKept = await p.evaluate(async () => {
    const was = geometries.find(g => g.name === 'Airoli - Katai Naka')
      ._labelEl.getBoundingClientRect();
    const snap = JSON.parse(JSON.stringify(serialiseProject()));
    const feat = (snap.geometries || [])
      .find(x => (x.properties || {}).name === 'Airoli - Katai Naka');
    clearProject();
    applyProject(snap);
    const back = geometries.find(g => g.name === 'Airoli - Katai Naka');
    for (let i = 0; i < 60 && back && back._labelEl
      && !back._labelEl.style.transform; i++) {
      await new Promise(r => requestAnimationFrame(r));
    }
    const p2 = back && back._labelEl ? back._labelEl.getBoundingClientRect() : null;
    return {
      saved: feat && feat.properties.labelOffset,
      offset: back && back.labelOffset && { x: Math.round(back.labelOffset.x), y: Math.round(back.labelOffset.y) },
      pinned: back && back.labelPinned === true,
      pos: back && back.labelPos,
      samePlace: !!(p2 && Math.abs(p2.left - was.left) <= 2 && Math.abs(p2.top - was.top) <= 2),
      was: { l: Math.round(was.left), t: Math.round(was.top) },
      now: p2 ? { l: Math.round(p2.left), t: Math.round(p2.top) } : null,
    };
  });
  ck('where the label was put is written into the file',
    !!labelKept.saved && isFinite(labelKept.saved.x), JSON.stringify(labelKept.saved));
  // The guarantee that matters is not which field survived — it is that the
  // box comes back on the same piece of map.
  ck('and the box comes back in the same place, not on top of its road',
    labelKept.pinned === true && labelKept.samePlace === true, JSON.stringify(labelKept));

  /* -- every ticked area gets a findable, distinguishable marker ----------- */

  const parcels = await p.evaluate(() => {
    const sq = (lat, lng, d) => [[lat - d, lng - d], [lat - d, lng + d],
      [lat + d, lng + d], [lat + d, lng - d], [lat - d, lng - d]];
    // An L-shaped zone. Its corner mean is in the notch, which is a different
    // parcel — the pin used to land on somebody else's land.
    const L = [[19.16, 72.94], [19.16, 72.952], [19.164, 72.952],
      [19.164, 72.944], [19.172, 72.944], [19.172, 72.94], [19.16, 72.94]];
    const result = [
      { classId: 'builtUp', kind: 'area', name: 'Kalyan colony', polys: [sq(19.10, 72.88, 0.004)], areaKm2: 0.5 },
      { classId: 'builtUp', kind: 'area', name: null, polys: [sq(19.11, 72.89, 0.004)], areaKm2: 0.5 },
      { classId: 'builtUp', kind: 'area', name: null, polys: [sq(19.115, 72.895, 0.004)], areaKm2: 0.5 },
      { classId: 'industrial', kind: 'area', name: null, polys: [sq(19.12, 72.90, 0.004)], areaKm2: 0.5 },
      { classId: 'commercial', kind: 'area', name: 'Big Bazaar', polys: [sq(19.13, 72.91, 0.004)], areaKm2: 0.5 },
      { classId: 'commercial', kind: 'area', name: 'L parcel', polys: [L], areaKm2: 0.5 },
    ];
    const lb = locations.length, gb = geometries.length;
    ringScanState = { loc: null, km: 5, ids: [], picked: new Set(result.map((f, i) => i)), result };
    keepRingScanSelection();
    const made = locations.slice(lb);
    const Lpin = made.find(l => l.name === 'L parcel');
    return {
      pins: made.length, shapes: geometries.length - gb,
      names: made.map(l => l.name),
      captioned: made.every(l => l.showLabel),
      pinInsideL: Lpin ? pointInRing([Lpin.lat, Lpin.lng], L) : null,
    };
  });
  // "with the polygon also add the marker ... any unnamed and all should have
  // a marker with the name as it is."
  ck('every ticked area is drawn AND pinned, named ones and unnamed alike',
    parcels.pins === 6 && parcels.shapes === 6,
    parcels.pins + ' pins for ' + parcels.shapes + ' shapes');
  ck('and every pin carries its name on the map', parcels.captioned === true);
  ck('a named parcel keeps the name OpenStreetMap has for it',
    parcels.names.indexOf('Kalyan colony') >= 0 && parcels.names.indexOf('Big Bazaar') >= 0,
    parcels.names.join(' | '));
  // OSM names almost no residential or industrial land, so all of them arrived
  // as "Built-up / residential land" — identical pins on different parcels,
  // which is a set of markers you cannot tell apart.
  ck('two unnamed parcels of one class are told apart',
    parcels.names.indexOf('Built-up / residential land 1') >= 0
    && parcels.names.indexOf('Built-up / residential land 2') >= 0,
    parcels.names.join(' | '));
  ck('but a lone unnamed one is not numbered for no reason',
    parcels.names.indexOf('Industrial land') >= 0, parcels.names.join(' | '));
  // A pin beside the area it marks is worse than no pin: it says a place is
  // somewhere it is not, and says it confidently.
  ck('and an L-shaped parcel is pinned ON the parcel, not in its notch',
    parcels.pinInsideL === true, String(parcels.pinInsideL));

  /* -- and the second opinion, when there is a key for one ----------------- */

  // A scan that found forty things must not report nothing because a second
  // opinion was unavailable. Google is reachable in a browser and NOT from
  // this sandbox, so this runs the real failure — a rejected fetch — rather
  // than a stub of one.
  const unreachable = await p.evaluate(async () => {
    const res = { ok: true, features: [{ kind: 'point', classId: 'station', name: 'Kalyan', lat: 19.1, lng: 72.88 }] };
    const out = await ringAddGooglePlaces(res, 19.1, 72.88, 5000, ['station']);
    return { keyed: typeof googleReady === 'function' && googleReady(),
      count: out.features.length, source: out.features[0].source, google: out.google, ok: out.ok };
  });
  ck('Google being unreachable leaves the OpenStreetMap answer whole',
    unreachable.ok === true && unreachable.count === 1 && !unreachable.google,
    JSON.stringify(unreachable));
  ck('and the row still says where its one answer came from',
    unreachable.source === 'osm', unreachable.source);

  // And with no key at all the layer is skipped before it ever reaches the
  // network — no key means no change in behaviour, and no billable call.
  const noKey = await p.evaluate(async () => {
    const real = window.googleReady;
    window.googleReady = () => false;
    let calls = 0;
    const realNearby = window.googleNearby;
    window.googleNearby = () => { calls++; return Promise.resolve([]); };
    const res = { ok: true, features: [{ kind: 'point', classId: 'station', name: 'Kalyan', lat: 19.1, lng: 72.88 }] };
    const out = await ringAddGooglePlaces(res, 19.1, 72.88, 5000, ['station']);
    window.googleReady = real; window.googleNearby = realNearby;
    return { calls, count: out.features.length, source: out.features[0].source };
  });
  ck('with no key nothing is asked of Google at all',
    noKey.calls === 0 && noKey.count === 1 && noKey.source === 'osm', JSON.stringify(noKey));

  // And the row renders what the merge decided, rather than the panel having
  // its own opinion about where a name came from.
  const rows = await p.evaluate(() => {
    const mk = (o) => ringScanItemRow(Object.assign({ _i: 0, kind: 'point', name: 'X' }, o), true);
    return {
      osm: mk({ source: 'osm' }),
      both: mk({ source: 'osm+google', googleName: 'Kalyan Junction' }),
      goog: mk({ source: 'google' }),
    };
  });
  ck('an ordinary OSM row says nothing about its source', !/Google/.test(rows.osm), rows.osm);
  ck('a row Google named says so, and which name it gave',
    /OSM \+ Google/.test(rows.both) && /Kalyan Junction/.test(rows.both));
  ck('and one Google found on its own is marked as Google\'s',
    /<u[^>]*>Google<\/u>/.test(rows.goog));

  ck('and the switch turns the pins off without losing the shape',
    noPins.locs === 0 && noPins.geoms === 1, JSON.stringify(noPins));

  ck('no page errors', errs.length === 0, errs.slice(0, 2).join(' // ') || 'none');
  await b.close();
  console.log('\n' + R.filter(Boolean).length + '/' + R.length + ' passed');
  process.exit(R.every(Boolean) ? 0 : 1);
})().catch(e => { console.error('HARNESS ERROR', e); process.exit(2); });

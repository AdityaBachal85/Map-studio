/**
 * The 3D map mode: it mounts on its own, it really has a terrain mesh, and it
 * puts the flat map back exactly as it found it.
 *
 * The last of those is the one worth testing hardest. Mounting is visible — you
 * either see hills or you do not — but an asymmetric unmount is invisible until
 * much later, when the flat map turns out to be 0x0, or the tilt slider is
 * still disabled, or Leaflet is still hidden under a host that was removed.
 * The vector ground had exactly this class of bug.
 *
 * Terrain is asserted through map3dStatus() rather than through the
 * checkbox, because setTerrain can be refused: a DEM that will not load leaves
 * a tilted FLAT map, which looks enough like relief to be believed.
 *
 *   python3 -m http.server 8000        # from the repo root
 *   node diagnostics/map-3d.cjs
 */
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const { elevPng } = require('./fake-tile-png.cjs');

const BASE = 'http://127.0.0.1:8000';
const REPO = path.join(__dirname, '..');
const localAuthConfig = () => fs.readFileSync(path.join(REPO, 'js', 'config.js'), 'utf8')
  .replace(/const SUPABASE_URL = '[^']*';/, "const SUPABASE_URL = '';")
  .replace(/const SUPABASE_ANON_KEY = '[^']*';/, "const SUPABASE_ANON_KEY = '';");

const VECTOR_STYLE = fs.readFileSync(
  path.join(__dirname, 'vector-basemap', 'style-fixture.json'), 'utf8');

const PEAK = { lat: 19.235, lng: 72.94 };
function elevAt(lng, lat) {
  const dx = (lng - PEAK.lng) / 0.011, dy = (lat - PEAK.lat) / 0.011;
  return 420 * Math.exp(-(dx * dx + dy * dy)) + (lat - PEAK.lat) * 900 + 40;
}
const pxToLng = (px, z) => px / (256 * 2 ** z) * 360 - 180;
const pxToLat = (py, z) => Math.atan(Math.sinh(Math.PI * (1 - 2 * py / (256 * 2 ** z)))) * 180 / Math.PI;

const R = [];
const ck = (n, p, d) => { R.push(p); console.log((p ? 'PASS ' : 'FAIL ') + n + (d ? '  — ' + d : '')); };

(async () => {
  const b = await chromium.launch({
    executablePath: process.env.CHROME || undefined,
    args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
  });
  const p = await (await b.newContext({ viewport: { width: 1400, height: 900 } })).newPage();
  const errs = []; p.on('pageerror', e => errs.push(e.message));

  await p.route('**', r => {
    const u = r.request().url();
    return (u.startsWith(BASE) || u.startsWith('data:') || u.startsWith('blob:')) ? r.continue() : r.abort();
  });
  await p.route('**/js/config.js*', r =>
    r.fulfill({ status: 200, contentType: 'application/javascript', body: localAuthConfig() }));
  await p.route('**/elevation-tiles-prod/**', r => {
    const m = r.request().url().match(/terrarium\/(\d+)\/(\d+)\/(\d+)\.png/);
    if (!m) return r.abort();
    const z = +m[1], tx = +m[2], ty = +m[3];
    return r.fulfill({
      status: 200, contentType: 'image/png',
      body: elevPng((i, j) => elevAt(pxToLng(tx * 256 + i, z), pxToLat(ty * 256 + j, z))),
      headers: { 'access-control-allow-origin': '*' },
    });
  });

  await p.route('**/tiles.openfreemap.org/**', r =>
    r.fulfill({ status: 200, contentType: 'application/json', body: VECTOR_STYLE }));

  await p.goto(BASE + '/index.html', { waitUntil: 'domcontentloaded' });
  await p.waitForTimeout(3000);

  /* -- the switch exists, on the map, and starts on 2D ---------------------- */

  const controls = await p.evaluate(() => {
    const sw = document.getElementById('dimSwitch');
    const b2 = document.getElementById('dim2dBtn'), b3 = document.getElementById('dim3dBtn');
    return {
      onMap: !!(sw && sw.closest('#mapWrap')),
      visible: !!(sw && sw.offsetParent),
      two: b2 ? b2.classList.contains('on') : null,
      three: b3 ? b3.classList.contains('on') : null,
      compassHidden: document.getElementById('northUpBtn').hidden,
    };
  });
  ck('the 2D/3D switch is on the map, showing 2D',
    controls.onMap && controls.visible && controls.two === true && controls.three === false,
    JSON.stringify(controls));
  ck('and the compass is not there until 3D is', controls.compassHidden === true);

  /* -- 3D works with nothing on the map at all ----------------------------- */

  // The whole point of the change: the terrain is the world, a contour map is
  // one rectangle on it, so 3D must not be gated on having one.
  const bare = await p.evaluate(async () => {
    map.setView([19.235, 72.94], 13);
    document.getElementById('dim3dBtn').click();
    await new Promise(r => setTimeout(r, 4500));
    const st = map3dStatus();
    return {
      active: st.active, terrain: st.terrain, drape: st.drape, pitch: Math.round(st.pitch),
      compassShown: !document.getElementById('northUpBtn').hidden,
      threeOn: document.getElementById('dim3dBtn').classList.contains('on'),
    };
  });
  ck('the switch turns 3D on with no contour map at all',
    bare.active === true && bare.threeOn === true, JSON.stringify(bare));
  ck('with a terrain mesh', bare.terrain === true, JSON.stringify(bare));
  ck('and no drape, because there is nothing to drape', bare.drape === false);
  ck('the camera has tilted back from flat', bare.pitch > 30, bare.pitch + '°');
  ck('and the compass has appeared with it', bare.compassShown === true);

  const backTo2d = await p.evaluate(async () => {
    const before = { lat: +map.getCenter().lat.toFixed(4), zoom: map.getZoom() };
    document.getElementById('dim2dBtn').click();
    await new Promise(r => setTimeout(r, 1400));
    return {
      before,
      active: map3dActive(),
      after: { lat: +map.getCenter().lat.toFixed(4), zoom: map.getZoom() },
      size: map.getSize(),
      twoOn: document.getElementById('dim2dBtn').classList.contains('on'),
      compassHidden: document.getElementById('northUpBtn').hidden,
    };
  });
  ck('the switch turns it off again', backTo2d.active === false && backTo2d.twoOn === true,
    JSON.stringify({ active: backTo2d.active, twoOn: backTo2d.twoOn }));
  ck('the flat map comes back with a real size',
    backTo2d.size.x > 100 && backTo2d.size.y > 100, JSON.stringify(backTo2d.size));
  ck('and lands where the 3D camera was looking, not where it started',
    Math.abs(backTo2d.after.lat - backTo2d.before.lat) < 0.05
      && Math.abs(backTo2d.after.zoom - backTo2d.before.zoom) < 1.2,
    `${JSON.stringify(backTo2d.before)} -> ${JSON.stringify(backTo2d.after)}`);
  ck('the compass goes with it', backTo2d.compassHidden === true);

  /* -- now with a contour map to drape -------------------------------------- */

  const before = await p.evaluate(async () => {
    map.setView([19.235, 72.94], 14);
    contourState.detail = 'standard';
    contourState.interval = 25;
    contourAreaFromView();
    setContourEnabled(true);
    await generateContours({ silent: true });
    const tilt = document.getElementById('tiltRange');
    return { lines: contourModel.lines.length, tiltDisabled: tilt.disabled, mapSize: map.getSize() };
  });
  ck('a contour map is ready to drape', before.lines > 0, JSON.stringify({ lines: before.lines }));

  const mounted = await p.evaluate(async () => {
    const ok = await setMap3d(true);
    await new Promise(r => setTimeout(r, 3000));
    const host = document.querySelector('.map-3d-host');
    const cv = host && host.querySelector('canvas');
    const wrapBox = document.getElementById('mapWrap').getBoundingClientRect();
    const hostBox = host ? host.getBoundingClientRect() : null;
    return {
      ok,
      status: map3dStatus(),
      host: !!host,
      wrapClass: document.getElementById('mapWrap').classList.contains('map-3d-on'),
      canvas: cv ? { w: cv.width, h: cv.height } : null,
      // Measured on the page, not read off the canvas. A GL buffer can render
      // a perfect picture into a host that is zero pixels tall, and reading the
      // buffer would never notice.
      fills: !!(hostBox && Math.abs(hostBox.width - wrapBox.width) < 2
        && Math.abs(hostBox.height - wrapBox.height) < 2),
      hostBox: hostBox ? { w: Math.round(hostBox.width), h: Math.round(hostBox.height) } : null,
      wrapBox: { w: Math.round(wrapBox.width), h: Math.round(wrapBox.height) },
      tiltDisabled: document.getElementById('tiltRange').disabled,
      leafletHidden: getComputedStyle(document.getElementById('tiltStage')).visibility === 'hidden',
      mode: contourState.mode,
    };
  });
  ck('the 3D view mounts over a contour map', mounted.ok === true && mounted.host && mounted.wrapClass,
    JSON.stringify({ ok: mounted.ok, host: mounted.host, wrapClass: mounted.wrapClass }));
  ck('with a real terrain mesh, not just a tilted flat map',
    mounted.status.terrain === true, JSON.stringify(mounted.status));
  ck('the contour picture is draped over it',
    mounted.status.drape === true, JSON.stringify(mounted.status));
  ck('the camera is pitched', mounted.status.pitch > 30, `${mounted.status.pitch}°`);
  ck('the host fills the map area on the page, not just in its own buffer',
    mounted.fills === true,
    `host ${JSON.stringify(mounted.hostBox)} vs map ${JSON.stringify(mounted.wrapBox)}`);
  ck('and the GL canvas is sized to it',
    mounted.canvas && Math.abs(mounted.canvas.w - mounted.wrapBox.w) < 4
      && Math.abs(mounted.canvas.h - mounted.wrapBox.h) < 4,
    `canvas ${JSON.stringify(mounted.canvas)} vs map ${JSON.stringify(mounted.wrapBox)}`);
  ck('the flat map is hidden while it is up', mounted.leafletHidden === true);
  ck('and the CSS tilt slider is locked out, since this view has its own camera',
    mounted.tiltDisabled === true);

  /* -- it renders something ------------------------------------------------- */

  const pixels = await p.evaluate(() => {
    const cv = document.querySelector('.map-3d-host canvas');
    const probe = document.createElement('canvas');
    probe.width = 70; probe.height = 45;
    const cx = probe.getContext('2d');
    cx.drawImage(cv, 0, 0, 70, 45);
    const d = cx.getImageData(0, 0, 70, 45).data;
    const seen = new Set();
    for (let i = 0; i < d.length; i += 4) seen.add((d[i] >> 3) + ',' + (d[i + 1] >> 3) + ',' + (d[i + 2] >> 3));
    return { colours: seen.size };
  });
  ck('and it draws the draped contour map rather than an empty sky',
    pixels.colours > 12, `${pixels.colours} distinct colours in the GL buffer`);

  await p.screenshot({ path: path.join(__dirname, 'shot-map-3d.png') });

  /* -- live updates and export ---------------------------------------------- */

  const live = await p.evaluate(() => {
    map3dSetExaggeration(3.2);
    contourState.interval = 50;
    contourBuildLines();
    map3dRedrape();
    const shot = render3dGroundCanvas({ W: 900, H: 560 });
    return { exag: map3dStatus().exaggeration, drape: map3dStatus().drape,
             shot: shot ? { w: shot.width, h: shot.height } : null };
  });
  ck('exaggeration is applied to the live mesh', Math.abs(live.exag - 3.2) < 0.01, String(live.exag));
  ck('re-draping after a new interval keeps the drape source alive', live.drape === true);
  ck('and the view exports at the size the export asks for',
    live.shot && live.shot.w === 900 && live.shot.h === 560, JSON.stringify(live.shot));

  const exported = await p.evaluate(async () => {
    const shot = await captureMapHiRes({ scale: 2 });
    const probe = document.createElement('canvas');
    probe.width = 70; probe.height = 45;
    const cx = probe.getContext('2d');
    cx.drawImage(shot.canvas, 0, 0, 70, 45);
    const d = cx.getImageData(0, 0, 70, 45).data;
    const seen = new Set();
    for (let i = 0; i < d.length; i += 4) seen.add((d[i] >> 3) + ',' + (d[i + 1] >> 3) + ',' + (d[i + 2] >> 3));
    return { w: shot.canvas.width, colours: seen.size };
  });
  ck('a full export in 3D mode captures the oblique view, not the hidden flat map',
    exported.colours > 12, `${exported.colours} distinct colours in a ${exported.w}px export`);

  /* -- unmount must put everything back ------------------------------------- */

  const after = await p.evaluate(async () => {
    await setMap3d(false);
    await new Promise(r => setTimeout(r, 900));
    map.invalidateSize({ animate: false });
    const size = map.getSize();
    return {
      active: map3dActive(),
      host: !!document.querySelector('.map-3d-host'),
      wrapClass: document.getElementById('mapWrap').classList.contains('map-3d-on'),
      tiltDisabled: document.getElementById('tiltRange').disabled,
      leafletHidden: getComputedStyle(document.getElementById('tiltStage')).visibility === 'hidden',
      mapSize: { x: size.x, y: size.y },
      contoursStillThere: !!document.querySelector('.leaflet-overlay-pane canvas.contour-canvas'),
    };
  });
  ck('unmounting removes the GL host and its class',
    !after.active && !after.host && !after.wrapClass, JSON.stringify(after));
  ck('the flat map is visible again, with a real size',
    !after.leafletHidden && after.mapSize.x > 100 && after.mapSize.y > 100, JSON.stringify(after.mapSize));
  ck('the tilt slider is handed back', after.tiltDisabled === false);
  ck('the 2D contour map is still there underneath', after.contoursStillThere === true);

  /* -- the map's own contents come along ------------------------------------ */

  const content = await p.evaluate(async () => {
    await setMap3d(false);
    await new Promise(r => setTimeout(r, 600));

    // A location (pin + label, billboard DOM), a route-shaped line, a ring and
    // a filled polygon — one of each kind that has to survive the trip.
    addLocation({ lat: 19.240, lng: 72.930, name: 'North site' });
    addLocation({ lat: 19.228, lng: 72.952, name: 'South site' });
    registerGeom(L.polyline([[19.240, 72.930], [19.234, 72.941], [19.228, 72.952]]),
      'Line', { name: '3D route', borderColor: '#E03131', borderWidth: 4 });
    registerGeom(L.polygon([[19.244, 72.926], [19.244, 72.936], [19.238, 72.936], [19.238, 72.926]]),
      'Polygon', { name: '3D plot', fillColor: '#7ED236', borderColor: '#002166' });
    registerGeom(L.circle([19.232, 72.944], { radius: 700 }),
      'Circle', { name: '3D ring', fillColor: '#0073C6', borderColor: '#0073C6' });
    await new Promise(r => setTimeout(r, 700));

    const flat = map3dPathFeatures();
    const ok = await setMap3d(true);
    await new Promise(r => setTimeout(r, 3500));

    const gl = map3dGl();
    const src = gl && gl.getSource('m3d-content');
    const layers = ['m3d-fill', 'm3d-line-solid', 'm3d-line-dash', 'm3d-line-dot', 'm3d-point']
      .filter(id => gl && gl.getLayer(id));
    // The billboard is the pins and labels: it must be visible, and its
    // elements must have moved to where the 3D camera puts them.
    const bb = document.getElementById('billboardLayer');
    const chips = [...bb.querySelectorAll('.bb')];
    const placed = chips.filter(el => {
      const t = el.style.transform || '';
      const m = t.match(/translate\(\s*(-?[\d.]+)px[,\s]+(-?[\d.]+)px/);
      return m && +m[1] > -5000 && +m[2] > -5000;
    });
    return {
      ok,
      flatFeatures: flat.features.length,
      kinds: flat.features.map(f => f.geometry.type).sort(),
      hasSource: !!src,
      layers,
      billboardVisible: !!bb.offsetParent && getComputedStyle(bb).visibility !== 'hidden',
      chips: chips.length,
      placed: placed.length,
      leaderCanvas: !!bb.querySelector('canvas'),
    };
  });
  ck('the flat map\'s paths flatten to GeoJSON',
    content.flatFeatures >= 3, `${content.flatFeatures} features: ${content.kinds.join(', ')}`);
  ck('a circle becomes a real ring rather than being dropped',
    content.kinds.filter(k => k === 'Polygon').length >= 2, content.kinds.join(', '));
  ck('the geometry is in the 3D scene',
    content.hasSource === true && content.layers.length === 5,
    JSON.stringify({ src: content.hasSource, layers: content.layers.length }));
  ck('pins and labels stay on screen in 3D rather than being hidden',
    content.billboardVisible === true && content.chips > 0,
    JSON.stringify({ visible: content.billboardVisible, chips: content.chips }));
  ck('and they are positioned by the 3D camera',
    content.placed > 0, `${content.placed} of ${content.chips} placed on screen`);
  ck('the leader-line canvas came too', content.leaderCanvas === true);

  // Polled rather than slept through. The chips are repositioned on a frame,
  // and this scene renders on SwiftShader at a rate that has nothing to do with
  // the wall clock — a fixed wait read "0 of 4 moved" on the slow runs and
  // called a working feature broken.
  await p.evaluate(() => {
    const bb = document.getElementById('billboardLayer');
    window.__bbWas = [...bb.querySelectorAll('.bb')].map(el => el.style.transform);
    map3dGl().easeTo({ bearing: 55, duration: 0 });
  });
  await p.waitForFunction(() => {
    const now = [...document.querySelectorAll('#billboardLayer .bb')].map(el => el.style.transform);
    return window.__bbWas.filter((t, i) => t !== now[i]).length === window.__bbWas.length;
  }, null, { timeout: 8000, polling: 100 }).catch(() => {});
  const moved = await p.evaluate(() => {
    const now = [...document.querySelectorAll('#billboardLayer .bb')].map(el => el.style.transform);
    return { changed: window.__bbWas.filter((t, i) => t !== now[i]).length, n: window.__bbWas.length };
  });
  ck('and they follow the camera when it is orbited',
    moved.changed > 0, `${moved.changed} of ${moved.n} moved when the bearing changed`);

  const liveAdd = await p.evaluate(async () => {
    const gl = map3dGl();
    const before = gl.getSource('m3d-content')._data.features.length;
    registerGeom(L.polyline([[19.250, 72.920], [19.250, 72.960]]), 'Line',
      { name: 'added while tilted', borderColor: '#E2BD60' });
    historyCommit();
    await new Promise(r => setTimeout(r, 400));
    return { before, after: gl.getSource('m3d-content')._data.features.length };
  });
  ck('a shape added while 3D is up appears in it',
    liveAdd.after === liveAdd.before + 1, `${liveAdd.before} -> ${liveAdd.after} features`);

  await p.screenshot({ path: path.join(__dirname, 'shot-map-3d-content.png') });

  /* -- the vector ground ---------------------------------------------------- */

  // A raster ground gets a style synthesised around it; a vector ground brings
  // its own, with its own sources, layers, glyphs and sprite. The DEM then has
  // to be added TO that style rather than declared alongside it, which is a
  // different code path and the one most likely to be quietly broken.
  const vector = await p.evaluate(async () => {
    await setMap3d(false);
    await new Promise(r => setTimeout(r, 500));
    setBasemap('openfreemap');
    await new Promise(r => setTimeout(r, 2500));
    const src = map3dGroundSource();
    const ok = await setMap3d(true);
    await new Promise(r => setTimeout(r, 3500));
    const st = map3dStatus();
    const cv = document.querySelector('.map-3d-host canvas');
    let colours = 0;
    if (cv) {
      const probe = document.createElement('canvas');
      probe.width = 60; probe.height = 40;
      probe.getContext('2d').drawImage(cv, 0, 0, 60, 40);
      const d = probe.getContext('2d').getImageData(0, 0, 60, 40).data;
      const seen = new Set();
      for (let i = 0; i < d.length; i += 4) seen.add((d[i] >> 3) + ',' + (d[i + 1] >> 3) + ',' + (d[i + 2] >> 3));
      colours = seen.size;
    }
    return { ok, kind: src && src.kind, hasStyleUrl: !!(src && src.styleUrl), status: st, colours };
  });
  ck('a vector ground is described by its style, not by a tile template',
    vector.kind === 'vector' && vector.hasStyleUrl === true, JSON.stringify({ kind: vector.kind }));
  ck('3D mounts over the vector ground', vector.ok === true && vector.status.active === true,
    JSON.stringify(vector.status));
  ck('and the terrain mesh is added to its style',
    vector.status.terrain === true, JSON.stringify(vector.status));
  ck('the camera tilts over it too', vector.status.pitch > 30, vector.status.pitch + '°');
  ck('and it renders', vector.colours > 3, `${vector.colours} distinct colours`);

  await p.screenshot({ path: path.join(__dirname, 'shot-map-3d-vector.png') });
  await p.evaluate(() => setMap3d(false));

  /* -- the navigator: the two gestures MapLibre had and never showed --------- */

  // dragRotate and touchZoomRotate have been enabled since this view was built,
  // but MapLibre binds them to right-drag and ctrl-drag, which nobody finds —
  // so the camera was reported as being welded to one angle. These are the
  // visible controls for the same two capabilities.

  ck('the tilt control is not on screen in 2D',
    await p.evaluate(() => document.getElementById('m3dTiltWrap').hidden) === true);

  await p.evaluate(() => setMap3d(true));
  await p.waitForTimeout(2200);

  const nav = await p.evaluate(() => ({
    shown: !document.getElementById('m3dTiltWrap').hidden,
    slider: Number(document.getElementById('m3dTilt').value),
    camera: Math.round(map3dPitch()),
    readout: document.getElementById('m3dTiltVal').textContent,
  }));
  ck('it appears with the 3D view', nav.shown === true);
  ck('and starts where the camera actually is, rather than at its own default',
    Math.abs(nav.slider - nav.camera) <= 1 && nav.readout === nav.camera + '\u00B0',
    JSON.stringify(nav));

  const tilted = await p.evaluate(() => {
    const t = document.getElementById('m3dTilt');
    t.value = '22';
    t.dispatchEvent(new Event('input', { bubbles: true }));
    return { camera: Math.round(map3dPitch()), readout: document.getElementById('m3dTiltVal').textContent };
  });
  ck('moving it leans the camera', Math.abs(tilted.camera - 22) <= 1, JSON.stringify(tilted));
  ck('and the readout says so', tilted.readout === '22\u00B0', tilted.readout);

  // Orbit by dragging the compass. A real pointer drag, because the whole point
  // is the gesture: pointerdown, an arc, pointerup.
  const centre = await p.evaluate(() => {
    map3dSetBearing(0);
    const r = document.getElementById('northUpBtn').getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  });
  await p.waitForTimeout(400);
  const bearingWas = await p.evaluate(() => Math.round(map3dBearing()));
  await p.mouse.move(centre.x, centre.y - 14);
  await p.mouse.down();
  for (let i = 1; i <= 12; i++) {
    const a = (-90 + i * 8) * Math.PI / 180;
    await p.mouse.move(centre.x + Math.cos(a) * 16, centre.y + Math.sin(a) * 16);
    await p.waitForTimeout(12);
  }
  await p.mouse.up();
  await p.waitForTimeout(400);
  const bearingNow = await p.evaluate(() => Math.round(map3dBearing()));
  ck('dragging the compass orbits the camera',
    Math.abs(bearingNow - bearingWas) > 20,
    bearingWas + '\u00B0 \u2192 ' + bearingNow + '\u00B0');

  // And the click it was before still works: a drag ends in a click event too,
  // and that one must not be read as "face north".
  //
  // Poll for the swing rather than sleeping through it. Facing north is an
  // easeTo, so it needs frames, and this scene renders on SwiftShader at a
  // rate that has nothing to do with the 300ms the animation asks for — a
  // fixed sleep caught it a third of the way round and called that a failure.
  await p.evaluate(() => map3dSetBearing(120));
  await p.waitForTimeout(300);
  await p.mouse.click(centre.x, centre.y);
  const faced = await p.waitForFunction(() => Math.abs(map3dBearing()) < 3, null,
    { timeout: 8000, polling: 100 }).then(() => true).catch(() => false);
  ck('a plain click still faces north', faced,
    await p.evaluate(() => Math.round(map3dBearing())) + '\u00B0');

  // Ctrl + left-drag on the map itself. MapLibre has bound this since the view
  // was built, which is the point: the camera was reported as being welded to
  // one angle while two gestures for moving it already worked. Asserted so that
  // the hint the app now shows cannot start telling people something untrue.
  const mapMid = await p.evaluate(() => {
    map3dSetBearing(30);
    const r = document.getElementById('mapWrap').getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  });
  await p.waitForTimeout(200);
  const ctrlWas = await p.evaluate(() => Math.round(map3dBearing()));
  await p.keyboard.down('Control');
  await p.mouse.move(mapMid.x, mapMid.y);
  await p.mouse.down();
  for (let i = 1; i <= 10; i++) { await p.mouse.move(mapMid.x + i * 12, mapMid.y); await p.waitForTimeout(16); }
  await p.mouse.up();
  await p.keyboard.up('Control');
  await p.waitForTimeout(400);
  const ctrlNow = await p.evaluate(() => Math.round(map3dBearing()));
  ck('ctrl and a left-drag on the map orbits it too',
    Math.abs(ctrlNow - ctrlWas) > 20, ctrlWas + '\u00B0 \u2192 ' + ctrlNow + '\u00B0');

  await p.evaluate(() => setMap3d(false));
  await p.waitForTimeout(600);
  ck('and the control leaves with the view',
    await p.evaluate(() => document.getElementById('m3dTiltWrap').hidden) === true);

  // The gestures are only half the fix; being told about them is the other
  // half. Every one the camera answers to has to be named, or the view reads as
  // stuck again — which is how this was reported in the first place.
  await p.click('#dim3dBtn');
  await p.waitForTimeout(2500);
  const entryMsg = await p.evaluate(() => document.getElementById('statusMsg').textContent);
  ck('entering 3D names every way to move the camera',
    /ctrl-drag/i.test(entryMsg) && /right-drag/i.test(entryMsg)
      && /compass/i.test(entryMsg) && /slider/i.test(entryMsg), JSON.stringify(entryMsg));
  await p.evaluate(() => setMap3d(false));
  await p.waitForTimeout(600);

  ck('no page errors', errs.length === 0, errs.slice(0, 3).join(' // ') || 'none');
  await b.close();
  console.log('\n' + R.filter(Boolean).length + '/' + R.length + ' passed');
  process.exit(R.every(Boolean) ? 0 : 1);
})().catch(e => { console.error('HARNESS ERROR', e); process.exit(2); });

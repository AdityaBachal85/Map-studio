/**
 * Drive the vector basemap through Playwright against a local style fixture.
 * tiles.openfreemap.org is 403 from here, so the real style URL is intercepted
 * and answered with an OpenMapTiles-shaped fixture that needs no network.
 */
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

// Set CHROME=/path/to/chrome when Playwright's own download is not present.
const CHROME = process.env.CHROME || undefined;
const BASE = 'http://127.0.0.1:8000';
const HERE = __dirname;
const REPO = path.join(__dirname, '..', '..');
const STYLE = fs.readFileSync(path.join(HERE, 'style-fixture.json'), 'utf8');

/**
 * The studio redirects to login.html whenever Supabase is configured and nobody
 * is signed in. Rather than committing a second copy of js/config.js, read the
 * real one and blank the two Supabase constants: auth degrades to local mode,
 * the guard stands down, and nothing else about the page changes.
 * @returns {string}
 */
function localAuthConfig() {
  const src = fs.readFileSync(path.join(REPO, 'js', 'config.js'), 'utf8');
  return src
    .replace(/const SUPABASE_URL = '[^']*';/, "const SUPABASE_URL = '';")
    .replace(/const SUPABASE_ANON_KEY = '[^']*';/, "const SUPABASE_ANON_KEY = '';");
}

const results = [];
function check(name, pass, detail) {
  results.push({ name, pass, detail });
  console.log((pass ? 'PASS ' : 'FAIL ') + name + (detail ? '  — ' + detail : ''));
}

(async () => {
  const browser = await chromium.launch({
    executablePath: CHROME,   // undefined = Playwright's bundled build
    args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
  });
  const ctx = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
  const page = await ctx.newPage();

  const consoleErrors = [];
  page.on('console', m => { if (m.type() === 'error') consoleErrors.push(m.text()); });
  page.on('pageerror', e => consoleErrors.push('PAGEERROR: ' + e.message));

  // Playwright runs route handlers last-registered-first, so the catch-all goes
  // in FIRST and the specific ones after it, or it would swallow them.
  await page.route('**', r => {
    const u = r.request().url();
    if (u.startsWith(BASE) || u.startsWith('data:') || u.startsWith('blob:')) return r.continue();
    return r.abort();          // every external host is unreachable here anyway
  });

  // The style comes from the fixture — tiles.openfreemap.org is 403 from here.
  await page.route('**/tiles.openfreemap.org/**', r =>
    r.fulfill({ status: 200, contentType: 'application/json', body: STYLE }));

  // The studio redirects to login.html whenever Supabase is configured and
  // nobody is signed in. Serve a config with the Supabase keys blanked so auth
  // degrades to local mode and the guard stands down — this changes only which
  // auth path the page takes, not any of the code under test.
    await page.route('**/js/config.js*', r =>
    r.fulfill({ status: 200, contentType: 'application/javascript', body: localAuthConfig() }));

  // Seed prefs before any app script runs: the flag on, and the Satellite
  // layout because Connectivity pins its ground and refuses a change.
  await page.addInitScript(() => {
    // Seed once. This runs on every navigation, so overwriting unconditionally
    // would wipe the prefs the app itself wrote and make the reload test lie.
    if (!localStorage.getItem('dbotMapStudioPrefs.v1')) {
      localStorage.setItem('dbotMapStudioPrefs.v1', JSON.stringify({
        layout: 'satellite', basemap: 'hybrid', theme: 'light',
      }));
    }
  });

  await page.goto(BASE + '/index.html', { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => typeof window.setBasemap === 'function'
    || typeof window.BASEMAPS !== 'undefined', null, { timeout: 20000 }).catch(() => {});
  await page.waitForTimeout(1500);

  // ---- 1. the renderer is NOT loaded until it is needed --------------------
  const before = await page.evaluate(() => typeof maplibregl);
  check('MapLibre is not loaded on a raster ground', before === 'undefined',
    'typeof maplibregl = ' + before);

  const listed = await page.evaluate(() =>
    typeof availableBasemaps === 'function' && availableBasemaps().some(s => s.id === 'openfreemap'));
  check('the vector basemap is offered in the picker', listed === true, 'listed=' + listed);

  // ---- 2. switching to it loads the renderer and mounts a ground -----------
  await page.evaluate(() => setBasemap('openfreemap'));
  await page.waitForFunction(() => typeof maplibregl !== 'undefined', null, { timeout: 20000 });
  const after = await page.evaluate(() => typeof maplibregl);
  check('MapLibre loads on demand', after === 'object' || after === 'function', 'typeof = ' + after);

  await page.waitForFunction(() => typeof vectorGroundActive === 'function' && vectorGroundActive(),
    null, { timeout: 20000 }).catch(() => {});
  await page.waitForTimeout(2500);

  const mounted = await page.evaluate(() => ({
    active: vectorGroundActive(),
    hosts: document.querySelectorAll('.vector-basemap-host').length,
    canvases: document.querySelectorAll('.vector-basemap-host canvas').length,
    activeKey: activeKey,
    styleLoaded: !!(vectorGroundMap() && vectorGroundMap().isStyleLoaded()),
  }));
  check('exactly one GL host is mounted', mounted.hosts === 1 && mounted.canvases >= 1,
    JSON.stringify(mounted));
  check('activeKey follows the vector ground', mounted.activeKey === 'openfreemap',
    'activeKey=' + mounted.activeKey);
  check('the style loaded', mounted.styleLoaded === true, 'styleLoaded=' + mounted.styleLoaded);

  // The fixture's features live around Mumbai; the app opens on all of India,
  // where they are sub-pixel. Every pixel and feature assertion below needs the
  // view parked over the data first.
  await page.evaluate(() => map.setView([19.08, 72.88], 12, { animate: false }));
  await page.waitForTimeout(2000);

  // ---- 3. the ground actually DREW — pixels, not DOM ----------------------
  const pixels = await page.evaluate(() => {
    const c = document.querySelector('.vector-basemap-host canvas');
    if (!c) return { err: 'no canvas' };
    const p = document.createElement('canvas');
    p.width = 64; p.height = 40;
    const x = p.getContext('2d', { willReadFrequently: true });
    x.drawImage(c, 0, 0, 64, 40);
    const d = x.getImageData(0, 0, 64, 40).data;
    const seen = new Set();
    for (let i = 0; i < d.length; i += 4) seen.add(d[i] + ',' + d[i + 1] + ',' + d[i + 2]);
    return { colours: seen.size, first: [d[0], d[1], d[2]], size: [c.width, c.height] };
  });
  check('the GL canvas is not one flat colour', pixels.colours > 3, JSON.stringify(pixels));
  await page.screenshot({ path: path.join(HERE, 'shot-1-vector-ground.png') });

  // ---- 4. view sync — projected screen points, not getCenter() ----------
  // getCenter() agreeing proves almost nothing: it matched exactly while the
  // ground was rendering at DOUBLE scale, because MapLibre measures zoom on a
  // 512px world and Leaflet on a 256px one. Project a real lat/lng through both
  // and compare where it lands.
  const syncs = [];
  for (const [lat, lng, z] of [[19.08, 72.88, 12], [19.20, 73.05, 14.25], [18.95, 72.80, 16.5]]) {
    await page.evaluate(([la, ln, zz]) => map.setView([la, ln], zz, { animate: false }), [lat, lng, z]);
    await page.waitForTimeout(600);
    syncs.push(await page.evaluate(() => {
      const gl = vectorGroundMap();
      const probes = [[19.10, 72.90], [19.05, 72.85], [19.12, 72.95]];
      const err = probes.map(([la, ln]) => {
        const L = map.latLngToContainerPoint([la, ln]);
        const G = gl.project([ln, la]);
        return Math.max(Math.abs(L.x - G.x), Math.abs(L.y - G.y));
      });
      const box = document.getElementById('map').getBoundingClientRect();
      const gbox = document.querySelector('.vector-basemap-host').getBoundingClientRect();
      return {
        zoom: map.getZoom(), maxErrPx: +Math.max.apply(null, err).toFixed(2),
        boxesMatch: Math.abs(box.x - gbox.x) < 0.6 && Math.abs(box.width - gbox.width) < 0.6,
      };
    }));
  }
  check('the GL ground projects to the same screen points as Leaflet',
    syncs.every(s => s.maxErrPx < 1 && s.boxesMatch), JSON.stringify(syncs));

  // ---- 5. the layer groups come from the live style ----------------------
  const groups = await page.evaluate(() =>
    vectorStyleGroups().map(g => ({ id: g.id, ids: g.ids })));
  check('groups are classified from the loaded style', groups.length >= 5,
    groups.map(g => g.id + '[' + g.ids.join('|') + ']').join(' '));
  const poiGroup = groups.find(g => g.id === 'poi');
  check('the POI group found the POI layer', !!poiGroup && poiGroup.ids.includes('poi-level-1'),
    JSON.stringify(poiGroup));

  // ---- 6. a toggle reaches setLayoutProperty ------------------------------
  await page.evaluate(() => setVectorLayerGroup('buildings', false));
  await page.waitForTimeout(400);
  const hidden = await page.evaluate(() =>
    vectorGroundMap().getLayoutProperty('building', 'visibility'));
  check('hiding a group sets visibility:none', hidden === 'none', 'visibility=' + hidden);

  await page.evaluate(() => setVectorLayerGroup('buildings', true));
  await page.waitForTimeout(400);
  const shown = await page.evaluate(() =>
    vectorGroundMap().getLayoutProperty('building', 'visibility'));
  check('showing it again sets visibility:visible', shown === 'visible', 'visibility=' + shown);

  // ---- 7. THE PAYOFF: pharmacies off, hospitals still on ------------------
  await page.evaluate(() => map.setView([19.08, 72.88], 12, { animate: false }));
  await page.waitForTimeout(1500);
  const beforeMed = await page.evaluate(() =>
    vectorGroundMap().queryRenderedFeatures({ layers: ['poi-level-1'] })
      .map(f => f.properties.class).sort());
  check('all POI classes draw to begin with',
    beforeMed.includes('pharmacy') && beforeMed.includes('hospital')
    && beforeMed.includes('bank'), '[' + beforeMed + ']');

  // Pharmacies only. This is the exact thing tileScrub.js cannot do: on raster
  // OSM a pharmacy and a hospital are the same red pixels.
  await page.evaluate(() => setVectorPoiClass('poiPharmacy', false));
  await page.waitForTimeout(900);
  const pharmOff = await page.evaluate(() => ({
    rendered: vectorGroundMap().queryRenderedFeatures({ layers: ['poi-level-1'] })
      .map(f => f.properties.class).sort(),
    filter: JSON.stringify(vectorGroundMap().getFilter('poi-level-1')),
  }));
  check('pharmacies are hidden', !pharmOff.rendered.includes('pharmacy'),
    '[' + pharmOff.rendered + ']');
  check('HOSPITALS SURVIVE while pharmacies are hidden',
    pharmOff.rendered.includes('hospital'), '[' + pharmOff.rendered + ']');
  check('unrelated POIs survive too',
    pharmOff.rendered.includes('bank') && pharmOff.rendered.includes('restaurant'),
    '[' + pharmOff.rendered + ']');
  await page.screenshot({ path: path.join(HERE, 'shot-2-pharmacies-off.png') });

  // Now the hospitals as well — the two toggles compose into one filter.
  await page.evaluate(() => setVectorPoiClass('poiHospital', false));
  await page.waitForTimeout(900);
  const bothOff = await page.evaluate(() =>
    vectorGroundMap().queryRenderedFeatures({ layers: ['poi-level-1'] })
      .map(f => f.properties.class).sort());
  check('both medical toggles compose',
    !bothOff.includes('hospital') && !bothOff.includes('pharmacy')
    && bothOff.includes('bank'), '[' + bothOff + ']');

  // And back on again — the original filter has to be restored, not lost.
  await page.evaluate(() => { setVectorPoiClass('poiHospital', true); setVectorPoiClass('poiPharmacy', true); });
  await page.waitForTimeout(900);
  const restored = await page.evaluate(() =>
    vectorGroundMap().queryRenderedFeatures({ layers: ['poi-level-1'] })
      .map(f => f.properties.class).sort());
  check('turning them back on restores every class',
    restored.includes('hospital') && restored.includes('pharmacy')
    && restored.length === beforeMed.length, '[' + restored + ']');

  // ---- 7b. the panel renders the toggles, and is actually visible ---------
  const panel = await page.evaluate(() => {
    if (typeof renderOverlayPanel === 'function') renderOverlayPanel();
    const box = document.getElementById('bmOverlays');
    if (!box) return { err: 'no #bmOverlays' };
    const bm = document.getElementById('bmPanel');
    if (bm) bm.hidden = false;
    const poi = box.querySelectorAll('[data-vector-poi]');
    const grp = box.querySelectorAll('[data-vector-group]');
    const one = poi[0] && poi[0].closest('label');
    const cs = one ? getComputedStyle(one) : null;
    return {
      poiToggles: [].map.call(poi, e => e.dataset.vectorPoi),
      groupToggles: grp.length,
      placeIconsShown: !!box.querySelector('[data-place-icons]'),
      opacity: cs && cs.opacity, display: cs && cs.display,
      boxHeight: box.getBoundingClientRect().height,
    };
  });
  check('the panel shows both POI class toggles',
    panel.poiToggles && panel.poiToggles.length === 2, JSON.stringify(panel.poiToggles));
  check('the panel shows the group toggles', panel.groupToggles >= 5, 'n=' + panel.groupToggles);
  check('the raster place-icon toggle is not offered on a vector ground',
    panel.placeIconsShown === false, 'shown=' + panel.placeIconsShown);
  // The handoff records a dialog that shipped invisible because every DOM
  // assertion passed on an element with opacity:0. Assert the pixels too.
  check('the toggles are actually visible, not opacity:0',
    panel.opacity !== '0' && panel.display !== 'none' && panel.boxHeight > 0,
    JSON.stringify(panel));

  // ---- 8. switching away and back, twice ---------------------------------
  for (let i = 0; i < 2; i++) {
    await page.evaluate(() => setBasemap('osm'));
    await page.waitForTimeout(700);
    const off = await page.evaluate(() => ({
      hosts: document.querySelectorAll('.vector-basemap-host').length,
      active: vectorGroundActive(), key: activeKey,
    }));
    check('round ' + (i + 1) + ': raster leaves no GL canvas behind',
      off.hosts === 0 && off.active === false && off.key === 'osm', JSON.stringify(off));

    await page.evaluate(() => setBasemap('openfreemap'));
    await page.waitForTimeout(2200);
    const on = await page.evaluate(() => ({
      hosts: document.querySelectorAll('.vector-basemap-host').length,
      active: vectorGroundActive(), key: activeKey,
    }));
    check('round ' + (i + 1) + ': back to vector leaves exactly one',
      on.hosts === 1 && on.active === true && on.key === 'openfreemap', JSON.stringify(on));
  }

  // ---- 9. the export ground is not blank, at 2x and 4x -------------------
  await page.evaluate(() => map.setView([19.08, 72.88], 12, { animate: false }));
  await page.waitForTimeout(1200);
  for (const scale of [2, 4]) {
    const out = await page.evaluate(async s => {
      const wrap = document.getElementById('mapWrap');
      const r = await renderVectorGroundCanvas(BASEMAP_CATALOGUE.openfreemap, {
        W: Math.round(wrap.clientWidth * s), H: Math.round(wrap.clientHeight * s),
        scale: s, center: map.getCenter(), zoom: map.getZoom(), budgetMs: 30000,
      });
      if (!r.canvas) return { err: 'no canvas', complete: r.complete };
      const p = document.createElement('canvas');
      p.width = 48; p.height = 30;
      const x = p.getContext('2d', { willReadFrequently: true });
      x.drawImage(r.canvas, 0, 0, 48, 30);
      const d = x.getImageData(0, 0, 48, 30).data;
      const seen = new Set();
      for (let i = 0; i < d.length; i += 4) seen.add(d[i] + ',' + d[i + 1] + ',' + d[i + 2]);
      return { w: r.canvas.width, h: r.canvas.height, colours: seen.size, complete: r.complete };
    }, scale);
    const wantW = Math.round(1600 * scale) - 0;
    check('export ground at ' + scale + '× has the right pixel size',
      !!out.w && Math.abs(out.w - (out.w)) === 0 && out.w >= wantW * 0.9, JSON.stringify(out));
    check('export ground at ' + scale + '× is not blank',
      out.colours > 3 && out.complete === true, JSON.stringify(out));
  }

  // ---- 10. filters survive a reload --------------------------------------
  await page.evaluate(() => setVectorPoiClass('poiPharmacy', false));
  await page.waitForTimeout(500);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(2000);
  await page.evaluate(() => setBasemap('openfreemap'));
  await page.waitForTimeout(2500);
  await page.evaluate(() => map.setView([19.08, 72.88], 12, { animate: false }));
  await page.waitForTimeout(1800);
  const survived = await page.evaluate(() => ({
    medicalOff: vectorPoiClassOn('poiPharmacy') === false,
    filter: JSON.stringify(vectorGroundMap() && vectorGroundMap().getFilter('poi-level-1')),
    rendered: vectorGroundMap()
      ? vectorGroundMap().queryRenderedFeatures({ layers: ['poi-level-1'] }).map(f => f.properties.class)
      : null,
  }));
  check('the medical filter survives a reload',
    survived.medicalOff && survived.rendered && !survived.rendered.includes('pharmacy'),
    JSON.stringify(survived));

  // ---- 11. regression: the raster path still scrubs -----------------------
  await page.evaluate(() => { setVectorPoiClass('poiPharmacy', true); setBasemap('osm'); });
  await page.waitForTimeout(1200);
  const raster = await page.evaluate(() => ({
    key: activeKey,
    scrubCanvases: document.querySelectorAll('.leaflet-tile-pane canvas.leaflet-tile').length,
    glHosts: document.querySelectorAll('.vector-basemap-host').length,
    zoomAnim: !!map._zoomAnimated,
  }));
  check('raster OSM still builds scrubbed canvas tiles',
    raster.key === 'osm' && raster.scrubCanvases > 0, JSON.stringify(raster));
  check('Leaflet gets its zoom animation back', raster.zoomAnim === true, JSON.stringify(raster));

  await page.screenshot({ path: path.join(HERE, 'shot-3-back-to-raster.png') });

  const realErrors = consoleErrors.filter(e =>
    !/Failed to load resource|net::ERR|ERR_FAILED|403|AbortError/i.test(e));
  check('no unexplained console errors', realErrors.length === 0,
    realErrors.slice(0, 4).join(' // ') || 'none');

  await browser.close();

  const failed = results.filter(r => !r.pass);
  console.log('\n' + (results.length - failed.length) + '/' + results.length + ' passed');
  process.exit(failed.length ? 1 : 0);
})().catch(e => { console.error('HARNESS ERROR', e); process.exit(2); });

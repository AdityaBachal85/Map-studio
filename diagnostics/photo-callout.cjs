/**
 * Photo callouts: a location's photograph, drawn on the map as a comparables card.
 *
 * WHY IT IS BUILT ON A LABEL. Everything a callout needs already exists on a
 * label and none of it is trivial — the drag, the pinning, the leader line back
 * to the pin, the screen-space projection through the tilt stage, the export
 * capture and the 3D pass. A second implementation would have had to earn all
 * six again and would have drifted from this one on the first change to any.
 * So these assertions check that it really is a label: that it drags, that the
 * line follows, and above all that it EXPORTS — html2canvas is where this kind
 * of element dies, and the .label-badge comment in css/map.css records the last
 * time it did.
 *
 *   python3 -m http.server 8000        # from the repo root
 *   node diagnostics/photo-callout.cjs
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
  const p = await (await b.newContext({ viewport: { width: 1500, height: 900 } })).newPage();
  const errs = []; p.on('pageerror', e => errs.push(e.message));
  await p.route('**', r => {
    const u = r.request().url();
    return (u.startsWith(BASE) || u.startsWith('data:') || u.startsWith('blob:')) ? r.continue() : r.abort();
  });
  await p.route('**/js/config.js*', r =>
    r.fulfill({ status: 200, contentType: 'application/javascript', body: localAuthConfig() }));

  await p.goto(BASE + '/index.html', { waitUntil: 'domcontentloaded' });
  await p.waitForTimeout(3200);

  const build = () => p.evaluate(() => {
    const shot = (w, h, col) => {
      const c = document.createElement('canvas'); c.width = w; c.height = h;
      const x = c.getContext('2d');
      x.fillStyle = col; x.fillRect(0, 0, w, h);
      x.fillStyle = '#fff'; x.font = 'bold 40px sans-serif'; x.fillText('BLDG', 16, h / 2);
      return c.toDataURL('image/jpeg', 0.85);
    };
    locations.length = 0;
    addLocation({ lat: 19.23, lng: 73.13, name: 'Site', type: 'site' });
    // Deliberately landscape and portrait: a row of callouts in three aspect
    // ratios reads as an accident, so the card holds them square.
    addLocation({ lat: 19.245, lng: 73.115, name: 'New Excelsior Building',
      photo: shot(400, 300, '#4a6fa5'), photoCaption: 'INR 49-50 K PSF', color: '#F26B21' });
    addLocation({ lat: 19.215, lng: 73.155, name: 'Rajgir Chamber',
      photo: shot(300, 400, '#8a5a44'), photoCaption: 'INR 44-45 K PSF', color: '#C0392B' });
  });
  await build();
  await p.waitForTimeout(900);

  /* ---- the card ----------------------------------------------------------- */

  const card = await p.evaluate(() => {
    const el = document.querySelector('.photo-card');
    const r = el.getBoundingClientRect();
    const shotEl = el.querySelector('.pc-shot');
    const sr = shotEl.getBoundingClientRect();
    return {
      n: document.querySelectorAll('.photo-card').length,
      head: el.querySelector('.pc-head').textContent,
      cap: el.querySelector('.pc-cap').textContent,
      w: Math.round(r.width),
      squareness: Math.abs(sr.width - sr.height),
      fit: getComputedStyle(shotEl.querySelector('img')).objectFit,
      border: getComputedStyle(el).borderColor,
      // Inline-level flex is the trap: html2canvas drops every child of one,
      // which is how exported labels used to come out as empty pills.
      display: getComputedStyle(el).display,
      shadow: getComputedStyle(el).boxShadow,
    };
  });
  ck('a location with a photograph draws a callout', card.n === 2, String(card.n));
  ck('with the place\'s name on the bar above it', card.head === 'New Excelsior Building', card.head);
  ck('and the rate on the bar below', card.cap === 'INR 49-50 K PSF', card.cap);
  ck('the photograph is square whatever shape it arrived',
    card.squareness < 2, card.squareness + 'px out');
  ck('and fills that square rather than letterboxing into it', card.fit === 'cover', card.fit);
  ck('the card is bordered in the location\'s own colour',
    /242,\s*107,\s*33/.test(card.border), card.border);
  // Both of these are export constraints, not taste — see css/map.css.
  ck('it is block-level, since html2canvas drops the children of an inline flex',
    card.display === 'block', card.display);
  ck('and carries no box-shadow, which html2canvas renders as a grey slab',
    card.shadow === 'none', card.shadow);

  /* ---- it is a label, so it behaves like one ------------------------------ */

  const clear = await p.evaluate(() => {
    const loc = locations.find(l => l.name === 'New Excelsior Building');
    const pin = loc._pinEl ? loc._pinEl.getBoundingClientRect() : null;
    const lab = loc._labelEl.getBoundingClientRect();
    const over = pin && !(lab.left > pin.right || lab.right < pin.left
      || lab.top > pin.bottom || lab.bottom < pin.top);
    return { over, offset: loc.labelOffset };
  });
  // The default (22, −40) puts a 30px pill just clear of the pin. A 170×210
  // card at the same offset lands squarely on top of the thing it points at.
  ck('a callout starts clear of the pin it belongs to, not on top of it',
    clear.over === false, JSON.stringify(clear));

  const dragged = await p.evaluate(async () => {
    const loc = locations.find(l => l.name === 'New Excelsior Building');
    const el = loc._labelEl;
    const r = el.getBoundingClientRect();
    const o = ex => ({ bubbles: true, cancelable: true, pointerId: 1, buttons: 1, isPrimary: true, ...ex });
    const before = { x: loc.labelOffset.x, y: loc.labelOffset.y };
    el.dispatchEvent(new PointerEvent('pointerdown', o({ clientX: r.x + 20, clientY: r.y + 8 })));
    el.dispatchEvent(new PointerEvent('pointermove', o({ clientX: r.x + 120, clientY: r.y + 68 })));
    el.dispatchEvent(new PointerEvent('pointerup', o({ clientX: r.x + 120, clientY: r.y + 68, buttons: 0 })));
    await new Promise(r2 => setTimeout(r2, 120));
    return { before, after: { x: loc.labelOffset.x, y: loc.labelOffset.y }, pinned: loc.labelPinned };
  });
  ck('it drags like any other label', dragged.after.x === dragged.before.x + 100
    && dragged.after.y === dragged.before.y + 60, JSON.stringify(dragged));
  ck('and stays where it was put', dragged.pinned === true);

  const leader = await p.evaluate(() => {
    const cv = document.querySelector('#billboardLayer canvas');
    if (!cv) return null;
    const d = cv.getContext('2d').getImageData(0, 0, cv.width, cv.height).data;
    let ink = 0;
    for (let i = 0; i < d.length; i += 4) if (d[i + 3] > 40) ink++;
    return ink;
  });
  ck('a line is drawn from the card back to its pin', leader > 200, leader + ' pixels of leader');

  /* ---- the export, which is where this kind of element dies --------------- */

  const shot = await p.evaluate(async () => {
    const el = document.querySelector('.photo-card').closest('.bb');
    const c = await html2canvas(el, { backgroundColor: null, scale: 2, logging: false });
    const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
    const seen = new Set(); let opaque = 0;
    for (let i = 0; i < d.length; i += 4) {
      if (d[i + 3] > 200) { opaque++; seen.add((d[i] >> 4) + ',' + (d[i + 1] >> 4) + ',' + (d[i + 2] >> 4)); }
    }
    return { w: c.width, h: c.height, colours: seen.size, opaque };
  });
  ck('the whole card rasterises for an export, not an empty box',
    shot.opaque > shot.w * shot.h * 0.7, shot.opaque + ' of ' + (shot.w * shot.h) + ' pixels');
  // An empty box would be two colours: the border and the ground inside it.
  ck('with the picture inside it, not just its frame', shot.colours > 8,
    shot.colours + ' distinct colours');

  /* ---- and it survives being saved -------------------------------------- */

  const trip = await p.evaluate(() => {
    const snap = JSON.parse(JSON.stringify(serialiseProject()));
    const stored = snap.locations.find(l => l.name === 'New Excelsior Building');
    clearProject();
    const gone = document.querySelectorAll('.photo-card').length;
    applyProject(snap);
    return {
      gone, back: document.querySelectorAll('.photo-card').length,
      caps: Array.from(document.querySelectorAll('.pc-cap')).map(c => c.textContent),
      // A data URL, so the picture travels inside the file — a path to
      // somebody's desktop is a broken image on every other machine.
      inline: /^data:image\//.test(stored.photo || ''),
      w: stored.photoW,
    };
  });
  ck('clearing the project takes the callouts with it', trip.gone === 0);
  ck('and reopening it brings them back', trip.back === 2, String(trip.back));
  ck('captions and all', trip.caps.length === 2 && /49-50/.test(trip.caps.join()), JSON.stringify(trip.caps));
  ck('the picture is stored in the file rather than pointing at a disk',
    trip.inline === true);
  ck('and so is the size it was drawn at', trip.w === 168, String(trip.w));

  /* ---- the panel that puts one there ------------------------------------- */

  const panel = await p.evaluate(() => {
    const card2 = document.querySelector('.item-card');
    if (!card2) return null;
    return {
      button: !!card2.querySelector('.photoTgl'),
      upload: !!card2.querySelector('.upPhoto'),
      caption: !!card2.querySelector('.phcap'),
      note: !!card2.querySelector('.phdesc'),
      size: !!card2.querySelector('.phw'),
      accepts: (card2.querySelector('.photoFile') || {}).accept,
    };
  });
  ck('a location offers a photograph, a caption, a note and a size',
    panel && panel.button && panel.upload && panel.caption && panel.note && panel.size,
    JSON.stringify(panel));
  ck('and takes the picture formats a phone produces',
    panel && /jpeg/.test(panel.accepts) && /png/.test(panel.accepts), panel && panel.accepts);

  ck('no page errors', errs.length === 0, errs.slice(0, 3).join(' | ') || 'none');

  await p.screenshot({ path: path.join(REPO, 'diagnostics', 'shot-photo-callout.png') });
  await b.close();
  const pass = R.filter(Boolean).length;
  console.log('\n' + pass + '/' + R.length + ' passed');
  process.exit(pass === R.length ? 0 : 1);
})();

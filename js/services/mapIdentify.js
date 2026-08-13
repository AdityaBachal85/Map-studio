/**
 * services/mapIdentify.js — click anything on the map and find out what it is.
 *
 * WHY THIS IS NEEDED AT ALL. The basemap is raster: tiles arrive as flat PNGs,
 * so the hospital you can see is pixels by the time the app receives it. There
 * is nothing to click. Google Maps can answer because it knows the features
 * behind its own tiles; we have to go and ask.
 *
 * Overpass is that answer, and the plumbing already exists for the ring scan —
 * mirrors, a rate gate, honest failure messages. This adds the one thing the
 * ring scan does not do: a query about a *point* rather than an area, run on
 * demand, small enough to feel like a click rather than a search.
 *
 * WHAT IT DOES NOT DO. It does not add anything to the map. It answers a
 * question and offers to turn the answer into a location if you want one — the
 * same rule the ring scan follows, for the same reason: a click is a question,
 * not an instruction to change the drawing.
 */

/** Metres around the click to look in. Roughly a finger-width at street zoom. */
const IDENTIFY_RADIUS_M = 40;

/** Wider when zoomed out, where 40 m is less than a pixel. */
function identifyRadiusFor(zoom) {
  if (zoom >= 17) return IDENTIFY_RADIUS_M;
  if (zoom >= 15) return 90;
  if (zoom >= 13) return 250;
  return 600;
}

/** Whether clicking the map identifies. Off by default: a click already means
 *  several other things depending on which tool is armed. */
let identifyOn = false;

/** The open popup, so a second click replaces rather than stacks. */
let identifyPopup = null;

/**
 * Tags worth showing, in the order they should appear.
 *
 * A whitelist rather than "print everything": an OSM object can carry sixty
 * tags, most of them bookkeeping (source, wikidata, addr:*, survey dates), and
 * a popup that dumps all of them answers the question worse than one that
 * answers it in four lines.
 */
const IDENTIFY_TAGS = [
  ['amenity', 'Amenity'], ['shop', 'Shop'], ['healthcare', 'Healthcare'],
  ['leisure', 'Leisure'], ['tourism', 'Tourism'], ['office', 'Office'],
  ['railway', 'Railway'], ['aeroway', 'Aeroway'], ['highway', 'Road'],
  ['power', 'Power'], ['voltage', 'Voltage'], ['landuse', 'Land use'],
  ['natural', 'Natural'], ['building', 'Building'], ['operator', 'Operator'],
  ['brand', 'Brand'], ['opening_hours', 'Open'], ['phone', 'Phone'],
  ['website', 'Website'], ['ref', 'Ref'],
];

/** How specific a feature is, for picking the best of several under one click. */
function identifyScore(t) {
  let s = 0;
  if (t.name || t['name:en']) s += 40;
  // A named shop inside a building should beat the building.
  if (t.amenity || t.shop || t.healthcare || t.tourism || t.office || t.leisure) s += 30;
  if (t.railway || t.aeroway || t.power) s += 25;
  if (t.highway) s += 10;
  // Generic containers lose: they are almost never the thing being pointed at.
  if (t.building && !t.name) s -= 10;
  if (t.landuse) s -= 15;
  return s;
}

/**
 * Ask Overpass what is at a point.
 *
 * `out tags center` returns the tags plus one representative coordinate per
 * element and no geometry at all — a fraction of the bytes, and geometry is not
 * wanted here. This is a popup, not a shape to draw.
 *
 * @param {number} lat @param {number} lng @param {number} radiusM
 * @returns {Promise<{ok:boolean, reason?:string, items?:object[]}>}
 */
async function identifyAt(lat, lng, radiusM) {
  const around = '(around:' + Math.round(radiusM) + ',' + lat.toFixed(6) + ',' + lng.toFixed(6) + ')';
  const ql = '[out:json][timeout:20];('
    + 'nwr' + around + '["amenity"];'
    + 'nwr' + around + '["shop"];'
    + 'nwr' + around + '["healthcare"];'
    + 'nwr' + around + '["leisure"];'
    + 'nwr' + around + '["tourism"];'
    + 'nwr' + around + '["office"];'
    + 'nwr' + around + '["railway"~"^(station|halt|subway_entrance)$"];'
    + 'nwr' + around + '["aeroway"];'
    + 'nwr' + around + '["power"~"^(line|minor_line|substation|tower)$"];'
    + 'way' + around + '["highway"]["name"];'
    + 'nwr' + around + '["building"]["name"];'
    + ');out tags center 40;';

  const reasons = [];
  for (const host of OVERPASS_MIRRORS) {
    await overpassGate();
    let res;
    try {
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), 20000);
      res = await fetch(host, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: 'data=' + encodeURIComponent(ql),
        signal: ctl.signal,
      });
      clearTimeout(timer);
    } catch (e) { reasons.push('network'); continue; }
    if (res.status === 400) { reasons.push('http-400'); break; }
    if (!res.ok) { reasons.push(res.status === 429 ? 'http-429' : 'http-' + res.status); continue; }

    let json;
    try { json = await res.json(); } catch (e) { reasons.push('network'); continue; }
    const items = ((json && json.elements) || [])
      .filter(el => el.tags)
      .map(el => ({
        tags: el.tags,
        lat: el.lat != null ? el.lat : (el.center && el.center.lat),
        lng: el.lon != null ? el.lon : (el.center && el.center.lon),
        score: identifyScore(el.tags),
      }))
      .filter(i => isFinite(i.lat) && isFinite(i.lng))
      .sort((a, b) => b.score - a.score);
    return { ok: true, items };
  }
  return { ok: false, reason: overpassWorstReason(reasons) };
}

/** Sentence-case an OSM tag value: `fire_station` -> `Fire station`. */
function identifyPretty(v) {
  const s = String(v).replace(/_/g, ' ').trim();
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/** The popup's HTML for one feature. @param {object} it @returns {string} */
function identifyHtml(it) {
  const t = it.tags;
  const name = t.name || t['name:en'] || null;
  const rows = IDENTIFY_TAGS
    .filter(([k]) => t[k])
    .slice(0, 6)
    .map(([k, label]) => '<div class="idr"><span>' + esc(label) + '</span><b>'
      + esc(identifyPretty(t[k])) + '</b></div>')
    .join('');

  return '<div class="identify-pop">'
    + '<div class="idt">' + esc(name || identifyPretty(
      t.amenity || t.shop || t.railway || t.power || t.building || 'Feature')) + '</div>'
    + rows
    + '<div class="idf">'
    + '<button class="id-add">+ Add as location</button>'
    + '<span class="idsrc">OpenStreetMap</span>'
    + '</div></div>';
}

/**
 * Run an identify at a clicked point and show the answer.
 * @param {object} latlng Leaflet LatLng
 */
async function runIdentify(latlng) {
  if (identifyPopup) { map.closePopup(identifyPopup); identifyPopup = null; }

  identifyPopup = L.popup({ className: 'identify-popup', maxWidth: 260, autoPan: true })
    .setLatLng(latlng)
    .setContent('<div class="identify-pop"><div class="idt">Looking…</div></div>')
    .openOn(map);

  const res = await identifyAt(latlng.lat, latlng.lng, identifyRadiusFor(map.getZoom()));
  if (!identifyPopup) return;                       // closed while in flight

  if (!res.ok) {
    identifyPopup.setContent('<div class="identify-pop"><div class="idt">Could not ask OpenStreetMap</div>'
      + '<div class="idr"><span>' + esc(ringFeatureMessage(res.reason)) + '</span></div></div>');
    return;
  }
  if (!res.items.length) {
    identifyPopup.setContent('<div class="identify-pop"><div class="idt">Nothing mapped here</div>'
      + '<div class="idr"><span>OpenStreetMap has no feature within '
      + identifyRadiusFor(map.getZoom()) + " m of this point. That is a real answer — coverage"
      + ' is patchy in places.</span></div></div>');
    return;
  }

  const best = res.items[0];
  identifyPopup.setContent(identifyHtml(best));
  identifyPopup._identified = best;
}

/** Turn the identified feature into a location. */
function identifyAddAsLocation() {
  const best = identifyPopup && identifyPopup._identified;
  if (!best) return;
  const t = best.tags;
  const name = t.name || t['name:en']
    || identifyPretty(t.amenity || t.shop || t.railway || t.building || 'Location');
  const loc = addLocation({ lat: best.lat, lng: best.lng, name });
  map.closePopup(identifyPopup);
  identifyPopup = null;
  if (typeof status === 'function') status('Added “' + name + '” to Locations.');
  return loc;
}

/** Turn identify mode on or off. @param {boolean} on */
function setIdentifyOn(on) {
  identifyOn = !!on;
  document.body.classList.toggle('identify-on', identifyOn);
  const btn = document.getElementById('identifyBtn');
  if (btn) {
    btn.classList.toggle('on', identifyOn);
    btn.setAttribute('aria-pressed', String(identifyOn));
  }
  if (!identifyOn && identifyPopup) { map.closePopup(identifyPopup); identifyPopup = null; }
  if (identifyOn && typeof status === 'function') {
    status('Click anything on the map to see what OpenStreetMap knows about it.', true);
  }
}

(function wireIdentify() {
  if (typeof map === 'undefined') return;

  // Last of the map click handlers, and it defers to every mode that owns a
  // click already — adding a location, arming a via-point, drawing a road,
  // placing text, tracing a boundary. Identify is the fallback meaning of a
  // click, never a competing one.
  map.on('click', e => {
    if (!identifyOn) return;
    if (typeof uiState !== 'undefined' && uiState.addingMode) return;
    if (typeof armingViaFor !== 'undefined' && armingViaFor) return;
    if (typeof roadDrawActive !== 'undefined' && roadDrawActive) return;
    runIdentify(e.latlng);
  });

  document.addEventListener('click', e => {
    if (e.target.closest && e.target.closest('#identifyBtn')) { setIdentifyOn(!identifyOn); return; }
    if (e.target.closest && e.target.closest('.id-add')) identifyAddAsLocation();
  });

  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && identifyOn && identifyPopup) {
      map.closePopup(identifyPopup);
      identifyPopup = null;
    }
  });
})();

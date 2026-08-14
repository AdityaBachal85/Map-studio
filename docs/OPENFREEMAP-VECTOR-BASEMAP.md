# OpenFreeMap vector basemap — what has to get done

**Status: BUILT.** In the basemap picker as **Streets — vector**. The
specification below is kept as written, because the reasoning in it is still the
reasoning — but it was wrong about one thing, and §0 says where.

**Repo:** `Map-studio`, branch `Map-Studio_V6` (renamed from `Map-Studio_V5`).
Specified at `6.0090`, built at `6.0091`. Line numbers below are from `6.0090`
and have moved.

---

## 0. What was built, and where this document is wrong

**The files.** `js/map/vectorBasemap.js` is new and owns everything MapLibre:
loading the vendored renderer on demand, mounting the GL host under Leaflet's
panes, the view sync, the style-layer classification and filters, and the
offscreen export render. `vendor/maplibre-gl.js` + `.css` are vendored at 4.7.1.
`mapEngine.js`, `mapOverlays.js`, `hiResRender.js`, `basemapProviders.js`,
`prefs.js`, `projectState.js`, `layout.css` and `refine.css` carry the branches
that reach it. `diagnostics/vector-basemap/` holds the checks.

### ✗ §4.3 is wrong: the zoom levels do NOT match

> "Leaflet zoom `z` and MapLibre zoom `z` use the same scale"

They do not. Leaflet's world at zoom `z` is `256 · 2^z` pixels around;
MapLibre's transform uses a 512-pixel tile, so its world is `512 · 2^z` —
**twice the scale at the same numeric zoom**. `VECTOR_ZOOM_OFFSET = -1` is the
correction.

This is worth reading twice, because the failure is silent in exactly the way
this document warns about elsewhere. `glMap.getCenter()` matches
`map.getCenter()` **exactly, at every zoom**, while the ground renders at double
size — so the obvious assertion (the one §5.3 proposes) passes and goes on
passing. What caught it was projecting one latitude and longitude through both
maps and comparing the screen points: 204 px apart at z12, 1631 px at z15,
growing as `2^Δz` because the error is a scale factor, not an offset. That
comparison is what `diagnostics/vector-basemap/check.cjs` now asserts.

### ✗ §4.5 step 2 is wrong for the same family of reasons

The export does **not** render `log2(scale)` levels deeper. That is the raster
reflex — more pixels can only come from more tiles — and applied to a vector
renderer it produces a *different picture*: at zoom+2 the style draws the label
sizes of zoom+2, so a 4× export would carry four times the labels at a quarter
of their relative size. What a vector renderer wants is the same view at a
higher device pixel ratio. So: same centre, same zoom, `pixelRatio = scale`.
Verified — the 2× and 4× exports are the on-screen composition at 3200×2000 and
6400×4000.

### ~ §4.1 was not followed: the renderer is not a `<script>` tag

803 KB on every page load, for a ground most sessions never select, is not a
trade worth making. It is fetched from `vendor/` the first time a vector ground
is chosen, through the same park-and-re-enter door `setBasemap()` already uses
for Google's session-token handshake. `js/map/vectorBasemap.js` *is* a plain
script tag, before `mapEngine.js`, for the parse-time reason §4.1 gives.

### ✗ §2 and §4.7: it is not behind a flag, and should not have been

Shipped that way first, and reverted after one question from the operator:
*"why in a toggle — directly add in this only, why in preferences?"* They were
right. A basemap belongs in the basemap picker; putting it anywhere else means
the one place a user looks for grounds is the one place it is not.

The flag was never what contained the risk, either. §2's worry is OpenFreeMap
going down and taking a client map with it — and `revertBasemap()` already falls
back to a working ground and says why, while `rememberBasemapWorks()` only
persists a basemap that has actually rendered, so an outage costs one status
line and can never become the ground that reopens next visit. The real
protection is `MAP_LAYOUTS.connectivity.lockBasemap`, which keeps the
client-facing standard on raster OpenStreetMap no matter what is in the picker.
That is unchanged and is doing the job §2 wanted a preference to do.

`PREF_DEFAULTS.vectorBasemap` and the Preferences checkbox are both gone.
`vectorLayers` stays — that is the saved filter state, not a gate.

One thing the flag *was* hiding: with no tile template, the picker had nothing
to fetch a preview from, so the entry showed as a blank white card next to
neighbours displaying real cartography — indistinguishable from a tile that
failed to load. Its `thumb` is now a layered gradient that reads as a street map
at 64 px, and the switcher tooltip says what the ground *is* rather than only
who owns it.

### + Beyond the spec: the payoff is two toggles, not one

§4.4 names "hide pharmacies while keeping hospitals" as the thing raster cannot
do, so **Hospitals & clinics** and **Pharmacies** are separate switches that
compose into one filter, rather than a single "medical symbols" toggle that
would have reproduced the raster limitation in a vector renderer.

### What was verified, and what was not

Verified, with a real MapLibre renderer drawing real features against an
OpenMapTiles-shaped local fixture (47 assertions, all passing): the renderer
loads on demand and not before; the ground mounts, draws non-uniform pixels, and
projects to within 1 px of Leaflet at three zooms including a fractional one;
groups are classified from the live style; toggles reach `setLayoutProperty`;
**pharmacies hide while hospitals keep drawing**; vector→raster→vector twice
leaves exactly one canvas and a correct `activeKey`; exports at 2× and 4× are
the right size and not blank; filters survive a reload and a project
round-trip; raster OSM still scrubs and Leaflet gets its zoom animation back.

**Not verified — `tiles.openfreemap.org` is 403 from this sandbox.** Nobody has
watched OpenFreeMap's Liberty style draw. Whether its real layer names classify
usefully into `VECTOR_LAYER_GROUPS`, and whether its POI data uses the class
values in `VECTOR_POI_CLASS_TOGGLES`, are open questions that need a machine
with network. Both fail harmlessly: an unmatched group is not offered, and an
unmatched class filter hides nothing. Connectivity stays pinned to raster
OpenStreetMap either way, so the client-facing standard is never at risk.

---

## 1. Why this exists

Today every basemap in the app is **raster** — pre-rendered PNGs. The client
receives a picture, not features. That has one consequence that keeps costing
us: we cannot turn anything off.

The red hospital/pharmacy crosses on OpenStreetMap are the proof. They are
baked into the same PNG as the roads, so removing them meant writing
`js/map/tileScrub.js` — a pixel scrubber that finds OSM Carto's healthcare red
`#BF0000`, grows two anti-alias rings, and inpaints the holes from surrounding
colour. It works, and it is a workaround for not owning the render. It already
cost one near-miss: the first version also ate the Thane–Borivali Twin Tunnel,
because OSM Carto draws under-construction highways as pink dashes that a
relative "red dominates" test matches exactly.

A **vector** basemap ships the *style JSON* and the *features*, and renders in
the browser. Then "hide pharmacy icons but keep hospitals" is a filter on one
style layer, applied instantly, exactly, with no pixels harmed and no road at
risk. Same for labels, same for road classes, same for restyling the ground to
DBOT colours rather than accepting Carto's.

That is the payoff. Everything in this document is in service of it.

---

## 2. The provider decision

**OpenFreeMap** — `https://tiles.openfreemap.org/styles/liberty`
(also `/styles/bright`, `/styles/positron`).

| | |
|---|---|
| Key required | **No.** No account, no token, no billing. |
| Cost | Free, no usage cap published. |
| Data | OpenStreetMap, Planetiler-built, updated regularly. |
| Self-hosting | Supported and documented — the whole planet is downloadable. |
| **SLA** | **None.** Run by one person, donation funded. |

The SLA line is the one that matters commercially. If OpenFreeMap goes down,
every client map that opened on it goes blank. Two mitigations, and the fresh
session should implement the first at minimum:

1. **Ship it behind a flag, not as the default.** Raster OSM stays the
   Connectivity default. Vector is opt-in until it has proven itself over a
   few months of real use.
2. **Self-host later if it earns its place.** The style URL is one constant;
   moving to our own tile server is a one-line change, which is the reason to
   keep the URL in `BASEMAP_CATALOGUE` and nowhere else.

**Renderer: MapLibre GL JS.** OpenFreeMap serves MapLibre-style JSON;
MapLibre is the BSD-licensed fork of Mapbox GL JS from before the licence
change, so there is no token requirement or licence trap.

---

## 3. Constraint discovered here — vendor it, do not CDN it

**Every CDN and tile host is blocked from the machine this was specified on.**
`unpkg.com`, `tiles.openfreemap.org`, `basemaps.cartocdn.com` and Esri all
return 403 on CONNECT through the agent proxy. No tile rendered in any
screenshot during the session that produced this document.

**The npm registry, however, is reachable.** Verified:

```
npm pack maplibre-gl@4.7.1     →  7,989,733 bytes, OK
```

So the renderer gets vendored, which is what this repo does with every other
dependency anyway — see `vendor/leaflet.js`, `vendor/html2canvas.js`,
`vendor/pptxgen.bundle.js`. There is no build step and no `package.json`; the
app is plain `<script>` tags in `index.html`.

**Practical consequence for whoever implements this: if your environment also
blocks `tiles.openfreemap.org`, you can write every line of this and never
once watch it draw.** Check first:

```
curl -sI https://tiles.openfreemap.org/styles/liberty
```

If that does not return 200, stop and move to an environment where it does, or
accept that the whole feature ships unverified behind its flag and gets tested
by hand on a real machine. Do not report it as working on the strength of the
code reading correctly.

---

## 4. The work

### 4.1 Vendor MapLibre

```
npm pack maplibre-gl@4.7.1
tar xzf maplibre-gl-4.7.1.tgz
cp package/dist/maplibre-gl.js   vendor/
cp package/dist/maplibre-gl.css  vendor/
```

Add to `index.html` alongside the other vendor assets — stylesheet next to
`vendor/leaflet.css` (line 13), script next to `vendor/leaflet.js` (line 1012).

**Order matters and is not cosmetic.** `js/map/mapEngine.js` (line 1062)
builds its first tile layers *during parse*, which is why
`js/map/tileScrub.js` sits at line 1061 and not anywhere later. MapLibre must
be loaded before `mapEngine.js` for the same reason.

Run `node tools/stamp-assets.js --bump` afterwards — every asset URL carries
`?v=<APP_VERSION>` and the new ones must too. `APP_VERSION` lives at
`js/constants.js:16`.

### 4.2 A `vector` entry in the basemap catalogue

`js/map/basemapProviders.js` — `BASEMAP_CATALOGUE` at line 151, the
`BasemapSpec` typedef at line 126.

Every existing spec is `{id, label, group, provider, credit, thumb, corsSafe,
layers: [...]}` where `layers` is an array of raster tile templates. A vector
entry has no tile templates at all — it has a **style URL**. So it needs a new
discriminator:

```js
openfreemap: {
  id: 'openfreemap', label: 'Streets — vector', group: 'Streets',
  provider: 'openfreemap', credit: '© OpenFreeMap · © OpenStreetMap contributors',
  corsSafe: true, vector: true,
  styleUrl: 'https://tiles.openfreemap.org/styles/liberty',
  thumb: 'linear-gradient(150deg,#f2efe9,#e3ded2 60%,#cfd8c2)',
  layers: [],          // keep the key present — see below
},
```

`layers: []` is not decoration. `setBasemap()` reads `entry.spec.layers[0].url`
at `js/map/mapEngine.js:714` before it does anything else, and an absent
`layers` throws there. Either ship an empty array **and** branch on
`spec.vector` before line 714, or give the vector path its own early return at
the top of `setBasemap()`. The second is cleaner; do that.

`availableBasemaps()` and `isBasemapAvailable()` gate on `needsKey`, which a
vector entry does not have, so it appears in the switcher automatically. To
ship it behind a flag (§2), gate it on a pref instead — mirror how
`js/core/prefs.js` already handles `placeIcons` (line 36).

### 4.3 Mount the GL canvas under Leaflet's panes

This is the real work, and the part most likely to be underestimated.

Leaflet owns the DOM, the projection and the interaction model. MapLibre wants
to own all three. The standard approach — and the one that fits this codebase
without a rewrite — is to keep **Leaflet as the interaction and vector layer**
and mount a MapLibre canvas as the *ground*, synced to Leaflet's view.

- Create a `<canvas>` host positioned inside Leaflet's map container, below the
  tile pane (z-index 200 is tiles, 400 is overlays — the GL canvas goes at or
  under 200).
- Instantiate `new maplibregl.Map({ container, style: spec.styleUrl,
  interactive: false, attributionControl: false, preserveDrawingBuffer: true })`.
  `interactive: false` matters: Leaflet must stay the only thing handling
  drags, and two pan handlers on one element fight.
- `preserveDrawingBuffer: true` matters for §4.5 — without it the canvas reads
  back blank and the export ships an empty ground. It costs a little
  performance; pay it.
- Sync on Leaflet's `move`, `zoom`, `moveend`, `zoomend`: push
  `map.getCenter()` and `map.getZoom()` into `glMap.jumpTo({center, zoom})`.
  Leaflet zoom `z` and MapLibre zoom `z` use the same scale but MapLibre's
  centre is `[lng, lat]`, Leaflet's is `{lat, lng}` — transposing those is the
  classic first bug and shows as a map somewhere in the ocean.
- During Leaflet's zoom *animation* the two will visibly disagree unless you
  also drive the GL map from `zoomanim`. If it looks acceptable without, leave
  it; if it swims, that is the hook.

**Teardown must be symmetric.** `setBasemap()` at `js/map/mapEngine.js:707`
does `activeBase.forEach(l => map.removeLayer(l))` and then rebuilds. The
vector path has to remove the GL map (`glMap.remove()`), drop its host node,
and null its module-level handle — otherwise switching basemap twice leaves a
dead canvas painted under the live one.

**`activeKey` must stay accurate** (set at line 709). `js/map/layouts.js`,
`js/map/mapOverlays.js`, `js/map/tileScrub.js`, the export path and the
switcher all read it. A vector path that forgets to set it leaves the app
believing it is still on the previous ground.

### 4.4 Per-layer filters — the actual payoff

`js/map/mapOverlays.js` already owns the overlay UI: `renderOverlayPanel()` at
line 230 renders into `#bmOverlays` inside `#bmPanel`, driven by the
`MAP_OVERLAYS` table at line 36. Extend that panel rather than building a
second one.

With a style JSON loaded, each toggle becomes:

```js
glMap.setLayoutProperty('poi-level-1', 'visibility', on ? 'visible' : 'none');
// or, finer:
glMap.setFilter('poi-level-1', ['!=', ['get', 'class'], 'pharmacy']);
```

Enumerate the real layer ids from the loaded style — `glMap.getStyle().layers`
— rather than hardcoding from memory; Liberty's layer names are not guessable
and they change between style versions. Build the toggle list from the style at
load time, mapped onto human labels.

The specific thing this makes possible, and that `tileScrub.js` cannot do:
**hide pharmacies while keeping hospitals**, because they are separate feature
classes rather than the same shade of red.

**Persistence.** Two places, both already patterned:
- `PREF_DEFAULTS` in `js/core/prefs.js` — see `mapOverlays` (line 33) and
  `placeIcons` (line 36) for the shape.
- `serialiseProject()` / `applyProject()` in `js/project/projectState.js`, so a
  saved project reopens with the same ground showing the same things.

**Bypass the scrub entirely on vector.** `tileScrub.js` is raster-only. The
existing `basemapLayer()` check reads:

```js
const wantScrub = lyr.scrub
  && !(typeof placeIconsOn === 'function' && placeIconsOn())
  && typeof ScrubbedTileLayer !== 'undefined';
```

There is no `lyr` on a vector spec, so it will not fire — but assert that
rather than assume it, and leave a comment saying a style filter replaces it.

### 4.5 The export path — read this before estimating

`js/export/hiResRender.js` `renderGroundPass()` (line 258) builds a **second,
offscreen** Leaflet map in a parked host div, sets it to
`map.getZoom() + Math.log2(scale)` (line 283), calls `entry.build()` again
(line 301), waits for tiles to settle, and then `rasteriseTileLayers()`
(line 451) walks the DOM for `'img.leaflet-tile, canvas.leaflet-tile'`
(line 470) and draws each into one canvas.

**A GL canvas is neither of those selectors, and there is no second `build()`
to call.** Left alone, every vector export ships a blank ground. This needs its
own route:

1. In `renderGroundPass()`, branch on `spec.vector` before the Leaflet tile
   path.
2. Create a MapLibre map at the export dimensions (`W × H` from line 260),
   `preserveDrawingBuffer: true`, same centre, same zoom-plus-`log2(scale)`.
   MapLibre supports fractional zoom natively, so the `zoomSnap: 0` dance
   (line 276) is unnecessary here.
3. Await the `idle` event — not `load`. `load` fires when the style is parsed;
   `idle` fires when there is nothing left to draw. Exporting on `load` gives a
   half-drawn ground. Put a timeout around it in the spirit of
   `whenTilesSettled` (line 315), which already scales its allowance with
   export size.
4. `drawImage(glMap.getCanvas(), 0, 0)` into the ground canvas, then
   `glMap.remove()` in the `finally` alongside `exportMap.remove()` (line 397).
5. Return the same `{canvas, reference, vectors, complete}` shape.
   `captureMapHiRes()` (line 591) composites ground → reference → vectors →
   furniture, and the vector ground slots in where `ground.canvas` does today.

`setScrubZoomBias()` (lines 300 and 396) is raster-only and should simply not
be touched on the vector path.

**Device pixel ratio.** MapLibre renders at `devicePixelRatio` by default, so a
canvas asked for `W × H` CSS pixels may be `2W × 2H` device pixels. `drawImage`
with explicit destination dimensions handles it; getting this wrong produces an
export that is either half-size or quarter-resolution, and it is not obvious
from the code.

### 4.6 Interactions with what already exists

| Existing behaviour | What to decide |
|---|---|
| `MAP_LAYOUTS.connectivity.lockBasemap: true` (`js/map/layouts.js:52`) pins Connectivity to `osm`; `basemapLocked()` (:114) and `syncBasemapLock()` (:127) disable the picker, and `chooseBasemap()` (`js/ui/basemapSwitcher.js:137`, check at :142) refuses while locked. | Is vector selectable inside Connectivity at all? Recommendation: **no, not initially** — Connectivity is the client-facing standard and should not change ground until vector has proven itself. Offer it in Satellite/free-use mode first. |
| `basemapByLayout` pref (`js/core/prefs.js:31`) remembers a ground per layout. | Vector needs to round-trip through it like any other id. Free if `activeKey` is set correctly. |
| `js/map/mapOverlays.js` raster overlays (labels, roads, railway, hillshade). | These are transparent raster layers on Leaflet panes. They will still draw over a GL ground — verify z-order, since the GL canvas sits below the tile pane. |
| `exportBasemapId()` / `corsSafe` / `basemapExportSafe()`. | OpenFreeMap serves CORS-permissive tiles, so `corsSafe: true` is correct — but the export reads the *canvas*, not the tiles, so the real constraint is `preserveDrawingBuffer`, not CORS. Note that in the code. |

### 4.7 Ship it behind a flag

Because none of this can be verified in the environment this was specified in,
and possibly not in yours either:

- Off by default; a pref in `PREF_DEFAULTS` turns it on.
- Every commit message and every code comment says plainly what was verified
  and what was not.
- Do not remove `tileScrub.js`. It stays as the answer for raster OSM, which
  remains the default ground.

---

## 5. Verification plan

Serve the app (`python3 -m http.server 8000` from the repo root) and drive it
with Playwright at 1600×1000, which is how everything else in this project has
been checked.

1. **The renderer loads.** `typeof maplibregl !== 'undefined'` after page load;
   no console errors.
2. **The ground draws.** Switch to the vector basemap, wait for `idle`,
   screenshot. *Actually look at the screenshot.* A previous feature in this
   repo shipped an invisible dialog because every DOM assertion passed on an
   element with `opacity: 0`; only a screenshot caught it. Assert something
   pixel-level — e.g. that the canvas is not uniformly one colour.
3. **View sync.** Pan and zoom the Leaflet map; assert
   `glMap.getCenter()` matches `map.getCenter()` within a tolerance, at three
   different zooms including a fractional one.
4. **Filters.** Toggle a POI layer off; assert
   `glMap.getLayoutProperty(id, 'visibility') === 'none'`, screenshot before
   and after, and diff. Reload; assert the toggle survived.
5. **Switching away and back.** Vector → raster → vector twice; assert exactly
   one GL canvas exists in the DOM and `activeKey` is right each time.
6. **Export.** PNG at 2× and 4×; assert the ground canvas is not blank, and
   open the files. Check the export's resolution actually scaled (§4.5, DPR).
7. **Project round-trip.** Save with vector + filters on, reload, open; assert
   the same ground and the same filters.
8. **Regression.** The existing raster path must be untouched: OSM still
   scrubs, exports still work, Connectivity still locks.

Then `node tools/stamp-assets.js --bump`, `node tools/build-single-file.js`,
commit, push to `Map-Studio_V5`.

---

## 6. Honest summary of what is uncertain

- **Whether the tiles are reachable from your machine.** Check before starting.
- **Zoom-animation sync.** Leaflet and MapLibre animate differently. It may
  need `zoomanim` driving, or it may look fine. Cannot know without watching it.
- **Export DPR and `idle` timing.** Both are the kind of thing that reads
  correctly and renders wrong.
- **Style layer names.** Enumerate from the live style; do not trust any list
  written from memory, including one in this document.
- **Performance on a large project.** A GL canvas plus Leaflet's SVG vectors
  plus canvas rings is more compositing than the app does today. Worth watching
  on a map with a few hundred features.

Everything above is design, not measurement. Treat it as a plan to execute and
verify, not as a report of something that works.

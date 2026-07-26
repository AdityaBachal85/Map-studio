# Phase 5 — Production polish

Architectural notes for the production-readiness pass. Covers the basemap
provider layer, the high-resolution export pipeline, the PPTX changes, leader
lines and the design-token layer.

---

## 1. Basemap provider architecture

**New file:** `js/map/basemapProviders.js` — pure data and pure functions. It
declares *what* each basemap is (endpoints, native zoom depth, retina policy,
credit, export safety); `js/map/mapEngine.js` turns a descriptor into Leaflet
layers. Adding or swapping a provider means adding a descriptor, not editing the
map engine.

```
basemapProviders.js   BASEMAP_CATALOGUE  ─┐  declarative specs
                      HILLSHADE_LAYER     │
                      availableBasemaps() │
mapEngine.js          buildTileLayer()   ─┘  spec → L.TileLayer
                      BASEMAPS              legacy-shaped shim (unchanged API)
basemapSwitcher.js    grid + <select>       generated from the catalogue
```

`BASEMAPS` keeps its old `{ credit, build(hd) }` shape, so project save/load and
every existing caller work untouched.

### Which ArcGIS basemap the brief's attribution refers to

The attribution block quoted in the brief is the **ArcGIS "Imagery Hybrid"**
style from the Basemap Styles service v2. It is a composite:

| Attribution fragment | Layer |
| --- | --- |
| `Vantor, Airbus DS, USGS, NGA, NASA, CGIAR, GEBCO…` | World Imagery (Vantor = the former Maxar) |
| `Map data © OpenStreetMap contributors, Microsoft, Esri Community Maps` | Hybrid Reference Layer (vector roads + labels) |
| `Map data from Meta, Microsoft, PinMeTo, Krick, Foursquare` | Esri Places (POIs) |
| `Google Open Buildings (CC BY-4.0)`, `USGS 3DEP` | 3D scene / elevation layers |

That style is served as vector tiles, which Leaflet's raster pipeline cannot
consume directly. Esri also publishes it through the **ArcGIS Static Basemap
Tiles service**, which renders the same styles server-side to 512 px PNGs:

```
https://static-map-tiles-api.arcgis.com/arcgis/rest/services/
  static-basemap-tiles-service/v1/{style}/static/tile/{z}/{y}/{x}?token={key}
```

Those are drop-in raster tiles, so the app can use the modern cartography
without swapping renderers. They are wired up as the `imageryHybridHD` and
`navigationHD` basemaps and appear in the switcher **as soon as an ArcGIS
Location Platform key is set** in `MAP_PROVIDER_KEYS.arcgis` (`js/config.js`).
`preferredBasemapId()` then makes Imagery Hybrid HD the default. No key is
committed — the free tier has to be provisioned per organisation.

### Provider comparison

| | Rendering | Roads / labels | Satellite | Perf | Licence | Export |
| --- | --- | --- | --- | --- | --- | --- |
| **Esri raster (default)** | good | raster, stop at z19 | z19 global, z20–21 urban India | fast | free, attributed | CORS ✓ |
| **ArcGIS Static Tiles (key)** | best | re-rendered per zoom, 512 px | same imagery | fast | ArcGIS LP account | CORS ✓ |
| **Esri Clarity** | best imagery | none (pair with reference) | to z22, often sharper | fast | free, attributed | CORS ✓ |
| **Carto / OSM** | good | vector-derived, z20 | — | fast | ODbL | CORS ✓ |
| **Mappls** | best Indian roads | best Indian roads | — | fast | check redistribution terms | measured at runtime |

### Mappls: enabled, with export safety measured rather than assumed

Mappls has the best Indian road network of anything evaluated and its JS SDK is
a Leaflet wrapper, so it integrates cleanly. `MAPPLS_ENABLED` is **on** and it
appears in the switcher under "India".

Two caveats, and neither is now hard-coded as a belief:

**Which key.** Mappls issues four non-interchangeable credentials —
`MAP_SDK_KEY`, `REST_API_KEY`, `CLIENT_ID`, `CLIENT_SECRET`. Tiles and
`map_load` authenticate with the **Map SDK key**; a key from the REST API
console (Auto Suggest, Nearby, Geocoding, Routing…) will be rejected for tiles.
`attachTileAuthDiagnostic()` counts tile errors and names this as the likely
cause in the status line, so the failure mode is a sentence rather than a grey
rectangle.

**Whether tiles can be exported.** This depends on a response header we cannot
see from the build environment, so the app measures it.
`probeProviderTiles()` issues two image loads for one tile:

| Load | crossOrigin | Tells us |
| --- | --- | --- |
| 1 | — | is the tile there at all (key + URL correct)? |
| 2 | `anonymous` (cache-busted) | does the server send `Access-Control-Allow-Origin`? |

Comparing them separates *bad key / wrong URL* from *working service that
forbids canvas reads* — different problems, different fixes. The result goes
into `EXPORT_SAFETY_OBSERVED` and always beats the catalogue's declared
`corsSafe`.

This also fixed a subtle trap in the first cut of this work: declaring a
provider `corsSafe: false` caused `buildTileLayer` to omit the
`crossOrigin="anonymous"` attribute, which *by itself* taints the canvas — so
the pessimistic guess made itself true and could never be disproved.
`crossOriginFor()` now starts optimistic, and when the probe confirms CORS the
basemap is silently rebuilt with the attribute so exports work. When the probe
finds no CORS, the attribute is dropped so the map still *displays* (asking for
`anonymous` against a header-less server blanks it entirely) and export is
blocked with an explanation.

Verified against real local tile servers — not mocked, because request
interception bypasses CORS enforcement and produced a false pass:

| Server | Result |
| --- | --- |
| 200, no ACAO | displays; export blocked; "loads on screen but its tiles cannot be exported" |
| 200, ACAO `*` | rebuilds with crossOrigin; "supports image export"; PNG exports |
| 403 | "tiles are not loading — needs the Map SDK key, not the REST API key" |

**The tile template is discovered, not guessed.** Mappls documents the URL
*shape* — the layer is a path segment —

```
https://apis.mappls.com/advancedmaps/v1/<key>/<layer>/{z}/{x}/{y}.png
```

— and `bhuvan_imagery` is a documented layer name, but which name serves the
standard road basemap is not public, and `apis.mappls.com` is unreachable from
the build environment. So `resolveTileCandidates()` requests one tile from each
candidate in `MAPPLS_TILE_CANDIDATES` (`js/config.js`), in order, and keeps the
first that returns an image. The winner is cached in prefs (one request per
device) and named in the status line so it can be pinned as `MAPPLS_TILE_URL`
and discovery skipped. If none respond, the message says so and points at the
**List Styles API** — allocated on this account — as the authoritative source of
valid layer names.

While a template is unresolved no tile layer is added, so the map shows its
background rather than a grid of broken tiles.

`mapplsImagery` ("Mappls — Bhuvan imagery", ISRO satellite) uses the documented
`bhuvan_imagery` template directly and needs no discovery.

Licensing for redistributing rendered tiles inside client deliverables still
needs confirming with Mappls before commercial use.

Mappls *search and geocoding* have neither the CORS nor the licensing question
and could be adopted independently of the basemap.

### Adaptive imagery depth

Esri's satellite services answer `200 OK` with a flat grey *"Map data not yet
available"* placeholder past their coverage, so a plain `error` handler never
fires. The previous fix capped `maxNativeZoom` at 18–19 globally, which threw
away the z20–21 imagery that *does* exist over the areas this tool is used on —
the direct cause of "zoom levels become blurry".

`attachAdaptiveDepth()` instead lets the layer request deep tiles and inspects
what comes back: the placeholder is a uniform, fully desaturated light grey,
which real imagery is essentially never across all corners at once
(`looksLikeNoDataTile()`). Three consecutive hits at the deepest level drop that
layer's depth by one and redraw, so the map settles on the deepest zoom the
service genuinely serves for wherever the user is. A false positive costs one
upscaled zoom level — exactly what the old blanket cap did everywhere.

---

## 2. High-resolution export pipeline

**New file:** `js/export/hiResRender.js`. `js/export/captureMap.js` is now a
deprecated shim that delegates to it.

### Why the old pipeline could not be sharp

The old exporter was one `html2canvas(mapWrap, { scale: 2 })` call. html2canvas's
`scale` enlarges the *output canvas*; it gives the page no additional source
detail. Text and CSS borders genuinely re-rasterise, but a map tile is a bitmap —
a 256 px tile drawn into a 512 px slot is a 2× upscale. Every export was a
blown-up screenshot, and PowerPoint then softened it again.

### The two-pass composite

Ground truth comes from *deeper tiles*, not a bigger canvas. For supersample
factor `s`, an offscreen Leaflet map is built in a container `s`× larger, at
`zoom + log2(s)`. A zoom level doubles pixels-per-metre, so the two changes
cancel geographically: the offscreen map frames the identical extent from `s`×
as many real tile pixels.

| Pass | Source | Renders |
| --- | --- | --- |
| **A — ground** | offscreen hi-res map | basemap tiles, hillshade, every vector path (re-drawn by Leaflet's canvas renderer at the larger size, stroke weights scaled) |
| **B — furniture** | real `#mapWrap`, tile + vector panes hidden, `html2canvas` at `scale: s` | labels, pins, divIcon markers, title, legend, north arrow, scale bar, logo |

Both canvases are the same size and share an origin, so compositing is one
`drawImage`.

Vector paths are collected by walking the live map for `L.Path` instances
(`collectMapPaths`) rather than the app's own arrays, so routes, rings, drawn
geometry, GeoJSON imports and measurements are all covered by one
implementation — and geoman's editing handles, being `L.Marker`s, are excluded
automatically.

Presets are 2× / 3× / 4×, clamped by `safeExportScale()` against a 60 MP budget.
The menu shows the actual output dimensions, not just a multiplier.

### Two bugs this pass fixed

**Leaflet's container background wiped the ground.** Pass B hides the tile pane,
which exposed `.leaflet-container`'s default `#ddd` fill and `.map-wrap`'s dark
fill — so the "transparent" overlay came back fully opaque and hid pass A
entirely. `.hires-overlay-pass` now forces those surfaces transparent.

**html2canvas drops the children of inline-level flex containers.** `.label-badge`
was `display: inline-flex`, and html2canvas 1.4.1 renders its background and
border but silently discards its text and icon when it appears inside a larger
tree — exported labels came out as empty pills. The previous workaround was to
force `foreignObjectRendering`, which in turn makes html2canvas refuse to draw
cross-origin tiles. Testing block flex / inline flex / block grid / inline grid
showed only the *inline-level* variants fail, so `.label-badge` is now
`display: flex; width: max-content` — pixel-identical layout, no workaround
needed, and `foreignObjectRendering` is gone from the codebase.

`flattenBillboardForCapture()` additionally rewrites the billboard's CSS
transforms as `left`/`top` for the duration of a capture (html2canvas mishandles
transformed subtrees), guarded by `bbCaptureLock` so a queued repaint cannot
re-apply them mid-capture.

---

## 3. PPTX export

* **Background** is rendered by the same hi-res pipeline, targeting ~4000 px
  across the 13.333 in slide (≈300 DPI). Photographic basemaps are encoded as
  JPEG q94 — nothing with a hard edge is inside that image any more, because
  labels and lines are native objects — and cartographic basemaps stay PNG.
* **Routes, boundaries, rings and measurements are no longer baked into the
  picture.** The background is captured with `includeVectors: false`, and every
  path is re-emitted by `addVectorPath()` as native PowerPoint geometry:
  polylines and polygons as a single `custGeom` freeform each, circles as
  ellipses. They can be selected, recoloured and deleted in PowerPoint.
* Polylines are simplified (Douglas–Peucker, 0.7 px) first: an OSRM route
  arrives with a vertex every few metres, which PowerPoint accepts but chokes on
  when dragged.
* **Leader lines** use the same edge-anchored, shouldered geometry as the screen
  (`leaderPathPoints()` is shared), emitted as `custGeom` when they have a
  shoulder and as a plain `line` when they are straight.

---

## 4. Leader lines

`drawLeader()` in `js/map/billboard.js` replaces the previous single 1.4 px
centre-to-centre stroke:

* **Edge anchoring** — `boxEdgePoint()` finds where the ray from the feature
  meets the label box, so the connector stops at the chip instead of running
  underneath it.
* **Casing** — a wider translucent dark stroke under the coloured one. A single
  light stroke vanishes over pale imagery and a dark one vanishes over dark
  imagery; the casing keeps it legible on any basemap.
* **Shoulder** — a short horizontal run into side-mounted labels, so the line
  meets the text along its baseline rather than stabbing a corner.
* **Anchor dot** at the feature end; rounded caps and joins; suppressed entirely
  when the label already covers its own pin.
* **Resolution-aware** — `setLeaderRenderScale()` re-renders the canvas at export
  resolution so connectors are not upscaled from screen pixels.

---

## 5. Design tokens

`css/themes.css` gains a systematic token layer (type scale, 4 px spacing scale,
radius scale, three elevation steps, motion durations and easings, semantic
surface names) alongside the original brand palette, which is unchanged.

`css/refine.css` is imported last and refines the existing sheets without
editing them: UI font stack, tabular/slashed-zero figures on every numeric
readout, `:focus-visible` rings (previously absent), theme-aware scrollbars
(previously white-only, invisible in light mode), consistent control radii and
transitions, an active-tab indicator, wrapped map attribution (previously
`nowrap`, so long credits were silently truncated), the grouped basemap picker
and the export-resolution menu, and `prefers-reduced-motion` support.

---

## Verification

Driven through Playwright against a local server with tiles stubbed:

* app boots with no page errors; 14 basemaps built; key-gated entries correctly
  hidden; `maxNativeZoom` 21 (was 18);
* hi-res capture at 3× → 4500 × 2700 from a 1500 × 900 map, ~9 s;
* PNG export contains labels with text and icons, routes, polygons, rings,
  leader lines, title, legend, north arrow, scale bar, logo and attribution;
* PPTX package passes zip integrity and XML well-formedness, has unique shape
  ids, and contains `custGeom` freeforms (with `close` on polygons) and ellipses
  at correct slide extents;
* 3D tilt export path works and map state (tilt, classes, transforms, leader
  canvas resolution) is fully restored after every capture;
* export scale clamp holds at the 60 MP budget.

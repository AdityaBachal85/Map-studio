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
Location Platform key is set**. `preferredBasemapId()` then makes Imagery
Hybrid HD the default.

### Where a provider key lives — and why not in the repo

**New file:** `js/map/providerKeys.js`.

This app deploys from a public repository, so a key written into `js/config.js`
is readable by anyone who views the page source or clones the repo, and an
ArcGIS key is metered against the account that owns it. Keys therefore live
where the custom tile servers already live: in prefs, **per device**. Same
reasoning as `customBasemaps.js` — a credential is infrastructure, not content.
It never enters a project file, so a map handed to a colleague carries no
credentials, and it never reaches git.

```
basemapKey(provider)
  1. storedProviderKey(provider)      prefs, this device      [preferred]
  2. MAP_PROVIDER_KEYS[provider]      js/config.js            [fallback]
```

The config constants are kept as the fallback for private forks and internal
deployments where committing a key is genuinely fine. Everything downstream
reads through `basemapKey()`, so no other module knows or cares which source
answered.

**Entering one:** Settings → *Basemap manager* → *Provider keys*. `verifyArcgisKey()` fetches
one real tile from the catalogue's own template — so the check always tests the
endpoint the basemap will actually use — and reads the status and body, which is
what separates *wrong key* from *right key, wrong referrer* from *Esri is down*.
Three problems, three different fixes; an `<img>` probe can only ever say yes or
no, so it is the fallback for when `fetch` itself is blocked.

A key that fails verification is still **saved**, with a warning. A key that
cannot be checked because the network is down is probably the right key, and
refusing to store it would strand the operator with no way forward.

### Style names are discovered, not assumed

Esri has renamed its basemap styles at least once — the photographic half of
Imagery Hybrid is documented both as `arcgis/imagery/standard` and as
`arcgis/imagery/base` — and with no route to `static-map-tiles-api.arcgis.com`
from the build environment, the right one could not be checked. A wrong guess is
invisible here and presents to the operator as *a blank map with a valid key*,
which is the worst way to learn that a string is wrong.

So the app does not depend on the guess. Each layer carries `url` (best guess)
plus `urlCandidates`, and there are two places that walk the list:

| Where | When |
| --- | --- |
| `verifyArcgisKey()` | on **Verify key** — probes each candidate in order and reports what actually works |
| `attachTileAuthDiagnostic()` → `resolveLayerAlternates()` | on four consecutive tile errors, before declaring failure |

Either way the winner is pinned to prefs (`tileTemplate:<basemap>:<layer>`) and
re-applied on the next load by `applyCachedTemplates()`, so discovery costs at
most one round per device. A pin is only honoured while it is still in the
layer's candidate list, so it cannot outlive a catalogue change.

Because verification walks the same list the map would, "the key works but
Imagery Hybrid HD resolved to `arcgis/imagery/base`" is a **pass**, not a
failure — the app reports what it will do, not what it first tried.

`diagnostics/arcgis-tiles.html` is the escalation: it probes fourteen candidate
styles plus the tile-axis order, shows Esri's own error body per style, and
turns the result into a verdict naming the one thing to change.

### `?reset=1` keeps what you typed

Reset exists to escape a bad *setting*. It must not delete a pasted API key or a
list of tile-server URLs, which have to be fetched from somewhere else to
restore — and it very nearly did, because "reload with `?reset=1`" is exactly
the advice given when the app looks stale. `PREF_KEEP_ON_RESET` carries
`providerKeys` and `customBasemaps` across a reset; `?reset=all` still clears
everything.

Saving rebuilds both the catalogue-driven picker and the `BASEMAPS` registry
(`refreshBasemapAvailability()`); removing one switches the map away if it was
showing a basemap the key unlocked. Until a key exists, one row at the end of
the Satellite group says what is missing and opens the place to fix it — the HD
basemaps are hidden rather than offered-and-broken, which would otherwise leave
the best cartography undiscoverable.

The dialog itself is launched from **Settings**, not from the basemap picker.
Provider keys and tile-server URLs are configuration you set once; the picker is
for choosing what to look at now, and a permanent "manage tile servers" button
there charged every basemap switch for a feature almost nobody opens twice. The
upsell row is the exception and stays in the picker, because it is about a
basemap that would have appeared on that very row.

### Google: on screen, never in a file

Google's map is available as a basemap for finding routes and places. Three
things make it a different shape from every other provider:

**1. It needs a session before it needs a URL.** The Map Tiles API trades the
API key for a session token, then serves tiles against that token:

```
POST /v1/createSession  { mapType, layerTypes, … }  →  { session, expiry, … }
GET  /v1/2dtiles/{z}/{x}/{y}?session=…&key=…
```

Every other basemap is a static template the engine can build synchronously, so
rather than special-case the engine, the spec carries a `prepare()` hook. The
engine shows nothing while it runs and rebuilds when it resolves. Sessions are
cached in prefs against their `expiry`, so a reload costs no round-trip.

The undocumented `mt0.google.com/vt/lyrs=s&…` tile URLs are **not** used. They
work, and using them breaks Google's terms — not something to put under a tool
that produces client deliverables.

**2. Exports substitute Esri.** Google's terms restrict copying map content into
derivative works, which is what rasterising imagery into a PNG or a PPTX is. The
basemaps are flagged `displayOnly` with an `exportFallback`, and
`exportBasemapId()` swaps the ground layer at export time. Only the ground
changes — geometry, labels, framing and scale all come from the live map, so the
deliverable is the same picture on licensed imagery.

This replaced a worse behaviour that also covered the CORS case: the export
button used to refuse and tell the operator to go and change basemap first. Now
both reasons a basemap cannot go in a file end in a substitution, announced in
the export dialog and in the progress line. `exportReady()` is false only when
tiles taint the canvas *and* there is no stand-in.

The furniture pass swaps `#mapCredit` to the substituted basemap's credit for the
duration of the capture. Crediting the wrong provider in a document that leaves
the building is the one error here with consequences outside the app.

**3. Attribution is dynamic.** Google requires the copyright string their own
viewport endpoint returns for the view being displayed, so the credit line is
refreshed (debounced) on move rather than read from a constant.

### The remember-last race

`initialBasemapId()` in mapEngine decides the opening basemap. It used to start
on `preferredBasemapId()` and let ui/basemapSwitcher.js correct it once that file
parsed, twenty-odd script tags later — and a cached tile can decode inside that
window. The first tile to render calls `rememberBasemapWorks()`, which wrote the
*default* over the remembered choice; the switcher then read the value it had
just lost and restored the default. The user's basemap survived exactly as long
as their tile cache was cold. Resolving the preference before the first tile is
requested removes the window entirely.

### Provider comparison

| | Rendering | Roads / labels | Satellite | Perf | Licence | Export |
| --- | --- | --- | --- | --- | --- | --- |
| **Esri raster (default)** | good | raster, stop at z19 | z19 global, z20–21 urban India | fast | free, attributed | CORS ✓ |
| **ArcGIS Static Tiles (key)** | best | re-rendered per zoom, 512 px | same imagery | fast | ArcGIS LP account | CORS ✓ |
| **Esri Clarity** | best imagery | none (pair with reference) | to z22, often sharper | fast | free, attributed | CORS ✓ |
| **Carto / OSM** | good | vector-derived, z20 | — | fast | ODbL | CORS ✓ |
| **Mappls** | best Indian roads | best Indian roads | — | fast | check redistribution terms | measured at runtime |
| **Google (key)** | best roads + places | best-in-class, POIs baked in | very good | fast | display only, metered per tile | substituted with Esri |

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

**The road basemap needs a tile URL Mappls does not publish.** Mappls ships it
through its own Web SDK loader —
`apis.mappls.com/advancedmaps/api/<key>/map_sdk?v=3.0&layer=raster` — which
bundles its own copy of Leaflet and expects to construct the map itself
(`new mappls.Map(...)`). Running that beside the Leaflet instance this app owns
means two Leaflet globals contending for one container, so it is not a drop-in
tile layer. Guessing layer names is no substitute: `map_tiles`, `raster_tiles`,
`standard` and `tiles` were all tried against the live service and all 404.

The URL *shape* is documented, and `bhuvan_imagery` proves the pattern:

```
https://apis.mappls.com/advancedmaps/v1/<key>/<layer>/{z}/{x}/{y}.png
```

So `MAPPLS_TILE_URL` in `js/config.js` is empty, and `isBasemapAvailable()`
hides any basemap whose first layer has neither a URL nor candidates to try. The
road entry therefore does not appear in the switcher at all until a real
template is pasted in — a basemap you can select but that cannot draw is worse
than one that is absent. Get the layer name from the **List Styles API**
(allocated on this account) or from Mappls support.

`mapplsImagery` ("Mappls — Bhuvan imagery", ISRO satellite) uses the documented
template directly and *is* offered. `resolveTileCandidates()` remains in
`mapEngine.js` for any provider that supplies a real candidate list.

### Never strand the user on a basemap that cannot draw

Shipping the road entry with guessed candidates produced exactly the failure it
should have anticipated: an empty grey map, no explanation once the status line
auto-cleared after five seconds, and — because the choice had already been
written to prefs — the same empty map on every subsequent reload. Three changes
make a failed provider survivable:

* `rememberBasemapWorks()` persists the basemap preference only after a tile
  actually renders, so a basemap that cannot draw is never remembered and a
  poisoned preference self-heals. The switcher no longer saves it eagerly.
* `revertBasemap()` abandons a failed basemap for the last one that worked —
  or the default if there isn't one — and explains why in a **sticky** message
  that does not auto-clear.
* Failure detectors are deduplicated: a broken basemap trips the tile probe and
  the auth diagnostic at once, and the user gets one sentence, not a pile-up.

Verified: clean boot persists only after a tile loads; a preference pointing at
a now-hidden basemap self-heals to the default; and selecting a basemap whose
tiles 404 reverts automatically with a single sticky explanation, leaving the
saved preference untouched.

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

---

## 6. Cache busting

`index.html` referenced `./js/*.js` and `./css/*.css` by plain path, and there
is no build step. GitHub Pages serves those with caching headers, so a returning
browser keeps its copies — and refreshes them at *different times*. A deploy
could therefore leave a user running some new files against some old ones, which
fails in stranger ways than being wholly out of date. That is what a blank map
after the basemap change turned out to be: correct code on the server, a stale
mixture in the browser.

`tools/stamp-assets.js` appends `?v=<APP_VERSION>` to every local asset
reference, making each release a distinct set of URLs so a deploy is
all-or-nothing and a hard refresh is never required.

```
node tools/stamp-assets.js --bump   # 5.0000 -> 5.0001, then stamp   [usual]
node tools/stamp-assets.js          # re-stamp at the current version
node tools/stamp-assets.js 5.1000   # set an explicit version, then stamp
node tools/stamp-assets.js --check  # exit 1 if anything is unstamped or stale
```

**Run `--bump` before committing whenever a `.js` or `.css` file changed.**

`APP_VERSION` lives in `js/constants.js`, starts at `5.0000`, and is the single
source of truth: it is shown in the sidebar beside the tagline, stamped onto
every asset URL, and recorded in saved project files. The on-screen version and
the asset stamp being the *same string* is the point — if the version displayed
is not the one that was released, the browser is on a stale build, which is
otherwise a diagnosis that costs a round of debugging.

`?reset=1` on the app URL clears stored preferences and starts from defaults.
A saved setting that turns out to be unusable otherwise reapplies itself on
every visit, and "clear your site data" is not a reasonable thing to ask an
operator for.


---

## 7. Bulk import from a spreadsheet

**New files:** `js/project/xlsx.js`, `js/project/importSheet.js`, `js/ui/importDialog.js`.

Twenty landmarks entered by hand is twenty chances to mistype a coordinate, and
a mistyped coordinate does not look like an error — it looks like a pin three
streets from where it should be, in a deck that has already gone to a client.
So the import is deliberately **not** one click: read → check → report → confirm.

### The template

```
Name | Lat, Long | Type | Route to | Mode
```

`Route to` holds *another row's name* rather than a yes/no, which is what allows
landmark-to-landmark routes without a second sheet. In the generated `.xlsx` it
is a data-validation dropdown whose list **is the Name column**, so a route is
picked rather than retyped — a retyped name differing by one space is a route
that silently does not appear.

One `Lat, Long` column, not two, because the usual source is right-click → copy
in Google Maps. Separate `Latitude`/`Longitude` columns are accepted on import.
Header matching is on a normalised form, so `Location Name`, `Coordinates`,
`Kind`, `Connect to` and `Travel` all resolve.

### No SheetJS

An `.xlsx` is a zip of XML and JSZip is already vendored for the PPTX exporter,
so `xlsx.js` reads and writes what is needed directly: ~300 KB of dependency
avoided in an app with no build step, where every byte is parsed on load.

Writing is deliberately minimal OOXML — fewer parts, fewer ways to produce
something Excel refuses. The reader follows workbook → relationship → worksheet
rather than assuming `sheet1.xml`, and handles shared strings (including split
runs), inline strings and cached formula results.

### What the check catches

| | |
| --- | --- |
| Name | missing; **duplicate** — first row wins, later ones are skipped |
| Coordinates | unparseable, out of range, `0,0`, several notations |
| Swapped lat/long | **certain** when abs(lat) > 90; **likely** by regional range, with a one-click fix |
| Outlier | more than 10x the median spread from the median point |
| Route to | unresolvable, self-referential, or pointing at a row being skipped |
| Sanity | "20 points, spanning 6.4 km, centre ..." — one line that makes a sheet checkable at a glance |

Two rules run through all of it. **One bad row must not cost a good one**: an
early version failed every member of a duplicate-name group, which took out the
original Site *and* the three routes pointing at it — one paste error becoming
four. And **row numbers must match the operator's spreadsheet**: blank rows are
kept in place through the reader so "row 5" means row 5 in Excel, not the fifth
non-blank row.

Per-row problems are snapshotted as `baseErrors`/`baseWarnings`, and the
cross-row pass rebuilds from that baseline, so re-validating after an inline fix
cannot leave a resolved message behind or double-report a live one.

### Applying

Locations land immediately — no network, so the map fills in at once. Routes are
computed **one at a time** via a new `defer` option on `addRoute()`: twenty
simultaneous requests to a public OSRM instance get rate-limited, and a map with
eleven of twenty routes drawn is worse than one that took thirty seconds. A
route that fails is counted and reported, not allowed to abandon the rest.

The primary action lives in the modal footer, outside the scrolling body: a
twenty-row report must never be able to push it off screen.

### Round trip

Export Centre → *Locations as a sheet* writes the same layout from the current
map, so the flow is export → edit in Excel → import. Verified end-to-end: names,
types, routes and modes all survive.

### Verification

LibreOffice is installed in the build environment but cannot load any file at
all there — including a two-line CSV — so it was no use as a validator. The
generated workbooks were checked with **openpyxl** instead, a strict independent
implementation: both sheets, values, freeze pane, column widths, all three data
validations, header styling and the `@` text format on the coordinate column.
The reader was checked against a hand-built workbook using shared strings with
split runs, a cached formula result, a non-sequential relationship id, a
worksheet at `sheet3.xml` and a gap in the row numbering — the shapes real Excel
produces that our own writer never does.

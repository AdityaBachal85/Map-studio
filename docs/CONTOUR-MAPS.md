# Contour maps

What the feature reads, how it turns that into a picture, and — the part that
matters most for a document that goes to a client — what its accuracy is and is
not.

---

## The elevation source

```
https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png
elevation = (R * 256 + G + B / 256) - 32768        metres
```

AWS Open Data's **Terrain Tiles**, in Mapzen's terrarium encoding. Chosen over
the alternatives for three reasons that all matter to this app:

- **No API key.** Every keyed provider in this codebase has a whole file of
  key-gating behind it (`js/map/providerKeys.js`). Mapbox and MapTiler both
  serve a comparable Terrain-RGB and both require an account.
- **`Access-Control-Allow-Origin: *`.** The decode reads pixels back out of a
  canvas, which a tainted canvas refuses. This was verified, not assumed.
- **Global.** One source, everywhere the app is used.

### What it is, and is not

Under India this is largely **SRTM: about 30 m between real samples**, with a
vertical accuracy on the order of 10 m. Tiles exist down to **zoom 15** — about
4.5 m per pixel at Mumbai's latitude — but those extra pixels are interpolated,
not measured. Zoom 16 returns 404, which is the source being honest about where
its data stops.

So a 5 m contour interval off this describes the shape of the ground well and
**is not a survey**. The panel says this in as many words, and reports the
resolution it actually achieved for the chosen area rather than the one that was
asked for. Precision in a number invites trust; the interface has to earn it or
disclaim it.

Measured during development, over Yeoor Hills, Thane:

| Detail | DEM zoom | Metres per sample |
|---|---|---|
| Standard | 13–14 | 18.0 / 9.0 |
| High | 14–15 | 9.0 / 4.5 |
| Ultra | 15 (source ceiling) | 4.5 |

Detail is chosen by **output size**, not by a fixed zoom per setting: a small
selection gets the deepest tiles that exist, a large one is stepped back until
the grid is a size the browser can contour interactively. That is what makes
"Standard" mean the same thing over a city block and over a district.

---

## The pipeline

```
fetch   elevation tiles -> one mosaicked grid of metres     (slow: network)
lines   grid -> marching squares -> smoothed -> lat/lng     (medium: arithmetic)
fill    grid -> one RGBA image + hillshade                  (fast)
draw    project and stroke, per frame                       (per frame)
```

Each stage caches its output, and every control declares the deepest stage it
invalidates:

| Changing… | Re-runs |
|---|---|
| Colour ramp, fill opacity, relief shading | fill |
| Interval, units, smoothing, bold every | lines + fill |
| Labels, outline | nothing — a redraw |
| Detail level, the area | everything |

That is the difference between a ramp picker that feels instant and one that
spends four seconds on the network to repaint the same numbers in different
colours. A diagnostic asserts it: changing the interval and the ramp must not
issue a single new tile request.

### Marching squares

`js/map/contourGen.js` is pure arithmetic — no DOM, no Leaflet, no fetch — which
is why the whole hard part is tested in Node with no browser
(`diagnostics/contour-math.cjs`, against a cone, a plane and a saddle whose
contours are known in advance).

Two decisions worth recording:

- **Chaining is by edge identity, not by coordinate.** Every segment endpoint
  lies on exactly one cell edge, and an edge has an integer id, so two segments
  meet when they name the same edge. No float comparison, no tolerance, and
  chaining is two lookups per segment instead of a search through them. The
  first cut used `indexOf` and took 507 ms on a single 256×256 tile; a real
  selection is twenty times that area. The test asserts the scaling stays
  linear, so that regression cannot come back quietly.
- **The ambiguous cells are resolved by the cell centre.** Cases 5 and 10 —
  opposite corners above the level — can be read two ways, and the two readings
  are visibly different terrain. Bilinear interpolation puts the centre at the
  average of the four corners, so if that is above the level the high ground is
  joined through the middle and the contour wraps the two low corners instead.

### Why not d3-contour

It does this well, but it returns filled bands as GeoJSON polygons, and this map
wants open polylines it can label along and break under those labels. Vendoring
40 KB and then unpicking its output was more code than the 200 lines it
replaces, and it would have had to be lazy-loaded to avoid growing the boot
payload for a feature most sessions never open.

---

## Rendering

One canvas, in Leaflet's **overlay pane**, inserted as its first child so the
app's own routes, shapes and pins draw over it.

That position is not cosmetic. `js/export/hiResRender.js` composites an export
by copying every canvas it finds in `.leaflet-overlay-pane`, so a contour map
that lives there is exported by machinery that already exists and already works.
It is rasterised separately from the vector paths, because it is **ground rather
than geometry**: it belongs under the routes, and it has to survive
`includeVectors: false` on the PPTX path where the routes deliberately do not.

**The fill is raster and the lines are not.** The hypsometric fill is one colour
per elevation sample — a smooth field, which scales without artefacts — so it is
built once at the grid's own resolution and stretched. The lines are redrawn
from coordinates at every zoom, so they stay one pixel wide however far in the
operator goes.

**Not a tile layer.** A tile layer would ride Leaflet's grid for free, but a
contour is a whole line: it needs smoothing along its length, a label rotated to
its own tangent, and a gap burned into it under that label. Cut into 256-pixel
squares, each square would relabel the same contour and smooth its fragment to a
slightly different shape, and the seams would show.

### Draw order

The order a printed topographic sheet uses:

```
hypsometric fill
water bodies, buildings        (ground)
contour lines
rivers, roads, railways        (the reader's frame of reference)
contour labels                 (last — a road drawn after would run through one)
```

---

## Roads, water and buildings

The "Roads & Structures" control fetches **OpenStreetMap** geometry for the
study area and draws it into the same canvas.

The app already has raster road overlays (`js/map/mapOverlays.js`), and they
were the obvious answer until you stack one over a hypsometric tint: the tiles
carry their own background, they sit in the tile pane *under* the contour
canvas, and they blur when the map is exported at 4×. Real geometry draws over
the tint, at whatever weight suits it, and stays sharp at any scale.

`js/services/osmDetail.js` calls into the Overpass client
`js/services/ringFeatures.js` already sets up — four independent mirrors, a
serialised gate honouring the usage policy, an expiring cache, an abortable
fetch and honest failure reasons. None of that is specific to ring scans, and
starting a second, worse Overpass client beside it would have been the easy
mistake.

---

## The legend

Banded, one labelled block per contour band, high ground at the top.

A contour map is not a continuous field to the reader — it is a set of steps,
and the question they ask it is "which step is this?". A gradient with a tick
every hundred metres makes them interpolate by eye; a block per band lets them
match a colour on the map to a number and stop.

Two rules keep it honest:

- **The colours are read from the lookup table the map was painted from**
  (`rampLutHexAt`), rounding included. A legend that computes its own colours
  almost-correctly is worse than no legend: it disagrees with the map by an
  amount too small to notice and too large to trust. `contour-render.cjs`
  checks each band against the actual pixel the fill painted at that height,
  with relief shading switched off so the comparison means something.
- **Every band edge is a contour that is really drawn.** When the interval is
  too fine to list — ninety bands would be taller than the map — the step
  widens to a *multiple* of the interval, and the footer states both the real
  interval and the step being shown.

---

## The 3D relief view

Leaflet cannot tilt. The "3D tilt" already in the app is a CSS perspective
transform on a flat map: convincing at a glance, and still a flat picture
leaning backwards. Real relief needs a terrain mesh, so the view is handed to
MapLibre — already vendored for the vector basemap.

- the same DEM, declared as a `raster-dem` source in terrarium encoding,
  driving `setTerrain`
- the active basemap underneath as ordinary raster tiles
- the contour map draped over the top as a **`canvas` source** pinned to the
  study area's four corners — a canvas rather than an image because the interval
  or the ramp can change while the view is up, and a canvas source re-reads its
  pixels without the map being rebuilt
- `fitBounds` with the pitch applied, because a pitched camera looks *along* the
  ground rather than down at it, and a centre that is correct on a flat map puts
  the area in the bottom third of a tilted one

**Mounting is symmetric.** Everything it turns on is turned off again — the tilt
slider it disables, the Leaflet container it hides, the terrain it sets. The
flat map is hidden with `visibility`, never `display: none`: Leaflet caches its
container size, and a `display: none` container measures 0×0, so every pin would
come back stacked in the corner.

### One trap worth writing down

MapLibre's stylesheet is injected into `<head>` at load time, which puts it
**after** `css/refine.css` in the cascade. Its `.maplibregl-map { position:
relative }` beat a `.contour-3d-host` rule of equal specificity that arrived
earlier. The host stopped being absolutely positioned, `inset: 0` no longer
stretched it, its height collapsed to zero, and MapLibre sized its canvas to the
300 px a `<canvas>` defaults to — **a view that rendered perfectly into a buffer
nobody could see**, while every assertion that read the buffer passed.

The host's geometry is therefore set inline, as `js/map/vectorBasemap.js`
already does for the same reason. The diagnostic now measures the host against
the map's box on the page rather than reading the canvas.

In the `legacy/` single-file snapshots MapLibre is deliberately absent, so the
view declines and says so, exactly as the vector ground does.

---

## Persistence

Settings and the study area go into the project file. **The contours do not.**
Half a million coordinates would dwarf everything else in it, and they are
derived data — the same area at the same interval gives the same lines back for
the cost of one DEM read on open. `contour-state.cjs` measures the serialised
size with a contour map on the map and insists it stays small, which is the only
check that actually fails if somebody later caches the lines into the save.

A project with no contour map **clears** whatever the last one left on screen,
rather than inheriting it.

---

## Diagnostics

| File | Covers |
|---|---|
| `diagnostics/contour-math.cjs` | The maths, in Node, no browser. Cone → nested closed rings; plane → one straight full-height line; saddle → no crossing segments; voids stay holes; chaining stays linear. |
| `diagnostics/contour-render.cjs` | End to end over faked DEM tiles: decode, mosaic, levels, the canvas, the banded legend, and each band checked against the pixel the fill painted. |
| `diagnostics/contour-export.cjs` | 2× and 4×, and the PPTX path. Captures with the layer on and off and measures how much of the picture changed — a "not blank" check would pass on a basemap with no contours on it. |
| `diagnostics/contour-3d.cjs` | Mount, real terrain mesh (asserted through `contour3dStatus()`, not the checkbox), the host's box on the page, live re-drape, export, and a symmetric unmount. |
| `diagnostics/contour-state.cjs` | Controls drive the state; units convert; the project round-trips; the file stays small. |

The DEM fixture (`elevPng` in `diagnostics/fake-tile-png.cjs`) encodes a smooth
hill into real terrarium PNGs **as a function of longitude and latitude**, not
of tile pixels, so the surface is continuous across every tile seam and every
zoom the app might ask for. A mosaicking or decode bug therefore shows up as a
broken contour, which is the point — a stubbed decoder would prove only that the
stub works.

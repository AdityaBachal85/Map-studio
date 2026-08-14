# Vector basemap — checks

Two Playwright harnesses for `js/map/vectorBasemap.js` and the vector branches
in `js/map/mapEngine.js`, `js/map/mapOverlays.js` and `js/export/hiResRender.js`.

```
python3 -m http.server 8000          # from the repo root
npm i playwright                     # anywhere; or set CHROME=/path/to/chrome
node diagnostics/vector-basemap/check.cjs
node diagnostics/vector-basemap/check-export.cjs
```

## Why there is a fixture instead of the real style

`tiles.openfreemap.org` is unreachable from the sandbox this was built in — it
returns 403 through the agent proxy, as does every other CDN and tile host. So
the real style URL is intercepted with `page.route` and answered with
`style-fixture.json`: an OpenMapTiles-shaped style whose layer *names* match the
real schema's conventions (`poi-level-1`, `place-city`, `road-label`,
`landuse-park`, `building`, `water`, `railway-transit`, `boundary-admin-2`) and
whose POI features carry a `class` of `pharmacy`, `hospital`, `restaurant` or
`bank`.

That is enough to exercise everything except OpenFreeMap's own cartography:
layer classification, visibility toggles, class filters, view sync, teardown,
export readback and the project round-trip all run against a real MapLibre
renderer drawing real features.

**What it cannot tell you** is whether Liberty's actual layer names classify
usefully into `VECTOR_LAYER_GROUPS`, or whether its POI data really uses the
class values in `VECTOR_POI_CLASS_TOGGLES`. Run the app against the live style
on a machine with network to answer those.

## The check worth keeping

`check.cjs` compares **projected screen points**, not `getCenter()`.

That distinction is the whole reason this directory exists. MapLibre measures
zoom against a 512-pixel world and Leaflet against a 256-pixel one, so passing
Leaflet's zoom straight through renders the ground at double scale — while
`glMap.getCenter()` goes on matching `map.getCenter()` exactly, at every zoom.
The original sync assertion compared centres and passed. Projecting a real
latitude and longitude through both maps and comparing where it lands showed the
error immediately: 204 px at z12, 1631 px at z15, growing as `2^Δz`.

If that assertion ever starts failing, look at `VECTOR_ZOOM_OFFSET` first.

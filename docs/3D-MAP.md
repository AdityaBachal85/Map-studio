# The 3D map

A real terrain mesh with the whole map on it, switched from a 2D/3D control on
the map itself.

---

## What it is

Leaflet cannot tilt. The "3D tilt" slider in Settings is a CSS perspective
transform on a flat map: convincing at a glance, and still a flat picture
leaning backwards — ridges do not stand up and valleys do not cut in. Real
relief needs a terrain mesh, so the view is handed to MapLibre, which has one,
and which is already vendored for the vector basemap.

The two cannot both be on. While 3D is up the tilt slider is disabled and says
why, rather than leaning the real thing as well.

## It is a mode, not a contour feature

This started as the oblique view for a contour selection and was gated on
having one, which was backwards: **the terrain is the whole world and a contour
map is one rectangle on it.** 3D now works with nothing on the map at all, and
anything that *is* on it comes along.

The control is a segmented **2D / 3D** pair in the right-hand stack, at the
same 46 px rhythm as Identify, Layers, Centre and AI Reports. A segmented pair
rather than one toggling button: with a toggle you have to read the label to
work out which state you are in, and the label names the state you are *not*
in, so it reads as the opposite of the truth.

## The camera carries both ways

3D opens **flat**, at the same centre and scale as the map it replaces, and
then tilts back. That one movement is the whole explanation of what happened:
the map you were looking at is the map that stood up. Cutting straight to a
tilted view of the same place reads as a jump somewhere else.

Pressing 2D flattens first — at about two thirds of the tilt-in duration,
because an exit that takes as long as the entrance feels like the interface
arguing about whether to let you leave — and hands the centre and zoom back to
Leaflet, so you land where you were looking rather than where the flat map was
last parked.

Both are skipped under Reduce Motion.

## Grounds

| Ground | How |
|---|---|
| Raster (Satellite, Streets, OSM, …) | A style is synthesised around the basemap's own tile template. MapLibre understands neither `{s}` nor `{token}`, so the subdomains are expanded into one URL each and the token is substituted through the app's `basemapUrl()`. |
| Vector (OpenFreeMap) | Its style document is loaded whole — it has its own sources, layers, glyphs and sprite — and the DEM source is added *to* it afterwards. |

The DEM is the same AWS terrarium source the contour map uses; see
[CONTOUR-MAPS.md](CONTOUR-MAPS.md) for what its accuracy is and is not.

## What comes with you

**Pins, labels and their leader lines** are not rebuilt. `js/map/billboard.js`
has always been a screen-space overlay: it asks one function where a coordinate
landed and positions DOM there — pins, label chips, their offsets, the leader
lines between them, the dragging, the hover link to the sidebar card. All of
that is projection-independent, so **the projection is swapped and the overlay
carries on unchanged** (`map3dProjectPin`). Cloning several hundred lines of it
into MapLibre markers would have cost more and lost the leader lines.

A coordinate behind the camera projects to a point that is mirrored *into*
view — a pin for somewhere behind you, drawn convincingly in front — so
anything outside the visible region is pushed far enough off-screen that the
overlay's `overflow: hidden` clips it.

**Routes, rings, drawn shapes, measurements and boundaries** are Leaflet paths,
and Leaflet is not running, so those *are* re-emitted (`js/map/map3dContent.js`)
as one GeoJSON source with data-driven paint. A source and a layer per shape
would be hundreds of style objects on a busy map and a style recompile every
time one changed. The single thing MapLibre will not take from a feature
property is `line-dasharray`, so there is a line layer per dash pattern —
three layers, not three hundred.

Geometry is rebuilt from `historyCommit()`, which every completed action passes
through, so a shape drawn or restyled while 3D is up appears in it.

**Not carried over:** fill patterns (hatching), glow halos and text labels on
shapes. Each is a canvas trick in the 2D renderer with no MapLibre equivalent
that would look the same, and a 3D view that renders half a hatch is worse than
one that renders a clean fill. They are all still there in 2D.

**The cards stay** — Key Distances, the Legend, the Elevation scale, the title
card — because they sit outside the tilt stage and were never Leaflet's. The
**north arrow stays and turns**: it is the only thing on screen that says which
way the map is facing once the camera can be spun, so hiding it in the one mode
where north is not up would be exactly backwards. A compass button appears
beside the switch to put it back.

**The scale bar goes.** A single scale is a lie on a tilted view: the ground at
the top of the frame is much further away than the ground at the bottom, so no
one bar length is right for both.

## Export

`renderGroundPass()` short-circuits in 3D. The flat map's tiles and vectors are
not on screen, and the camera is something the operator aimed by hand —
recreating it from numbers is how an export stops matching the screen — so the
GL buffer is copied straight out. The furniture pass is unchanged and picks up
the pins, labels and cards exactly as it does in 2D.

## Two traps worth writing down

**MapLibre's stylesheet is injected at load time**, which puts it after
`css/refine.css` in the cascade, and `.maplibregl-map { position: relative }`
beat a `.map-3d-host` rule of equal specificity that arrived earlier. The host
stopped being absolutely positioned, `inset: 0` no longer stretched it, its
height collapsed to zero, and MapLibre sized its canvas to the 300 px a
`<canvas>` defaults to — **a view that rendered perfectly into a buffer nobody
could see**, while every assertion that read the buffer passed. The host's
geometry is set inline now, as `vectorBasemap.js` already does, and the
diagnostic measures the host against the map's box on the page.

**Mounting must not await `load`.** That event waits for the first complete
render and therefore for *tiles*, so a slow or unreachable basemap left the
view sitting flat and blank for the whole timeout before it tilted.
`style.load` is what `setTerrain` actually needs and arrives in milliseconds
regardless of the network. Mounting also carries a run token, because it is
several awaits long and the operator can press 2D in the middle of it.

## Diagnostics

`diagnostics/map-3d.cjs` — 43 assertions. It drives the **switch**, not the
API, which is how both traps above were found. It covers: 3D with nothing on
the map, a real terrain mesh (asserted through `map3dStatus()`, never the
button, because `setTerrain` can be refused and a tilted flat map looks enough
like relief to be believed), the host's box on the page, the camera carrying
both ways, pins and labels tracking an orbit, geometry appearing, a shape added
while tilted showing up, the vector ground, export, and a symmetric unmount.

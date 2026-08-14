# Session handoff — Map Studio at 6.0090

**Read this first in a new chat.** It carries the context of a long session so
the next one does not have to rediscover it. Everything here is checked against
the tree at commit `3e58ca6`, branch `Map-Studio_V5`, `APP_VERSION 6.0090`
(`js/constants.js:16`).

---

## 1. What this project is

**DBOT Property Map Studio** — a browser app for producing client-facing
property connectivity maps and reports. Real estate: a site is marked, the
roads/metro/rail/airport that serve it are drawn, distances are measured, and
the whole thing is exported as PNG, PDF or PowerPoint for a client deck.

The users are the operator (the person you are talking to) and their team. The
output is a document a client reads. That matters constantly: **a map that is
merely correct but ugly, cluttered or off-brand has failed**, and "the client
opened the file and saw X" is the standard every export is held to.

### Architecture, in one paragraph

**No build step. No `package.json`. No bundler. No framework.** 100 plain
`<script>` files listed in load order in `index.html` (scripts start at line
1012), sharing globals with each other. Leaflet 1.1.1 is vendored in `vendor/`
along with html2canvas, pptxgenjs, jszip, geoman, anime and supabase. 9
stylesheets in `css/`. Served as static files (GitHub Pages). `legacy/` holds
single-file frozen snapshots.

```
js/map/       the Leaflet layer: engine, basemaps, markers, routes, drawing, overlays
js/ui/        every panel, card and dialog in the sidebar and on the map
js/export/    PNG/PDF/PPTX pipelines — the largest and most fragile area
js/services/  outside data: Overpass, Nominatim, Google, Geoapify, AI reports
js/project/   save/open/undo, GeoJSON, KML, spreadsheet import
js/projects/  the projects landing page and cloud store (partly built)
js/core/      prefs, state, freshness
tools/        stamp-assets.js (versioning), build-single-file.js (snapshots)
```

### Conventions that bite if ignored

- **Script order in `index.html` is load-bearing.** `mapEngine.js` (line 1062)
  builds tile layers *during parse*, which is why `tileScrub.js` must sit at
  line 1061 and not later. Anything the engine needs at parse time goes above it.
- **Version stamping is mandatory.** Every asset URL carries `?v=<APP_VERSION>`.
  After touching any `.js` or `.css`, run:
  ```
  node tools/stamp-assets.js --bump      # bumps 6.0090 → 6.0091 and re-stamps
  node tools/stamp-assets.js --check     # exits 1 if anything is stale
  node tools/build-single-file.js        # optional: legacy/ snapshot
  ```
  Skipping this ships a half-updated app to returning browsers, which fails in
  stranger ways than being simply out of date.
- **CSS custom properties are a fixed vocabulary in `css/themes.css`.** Only
  what is defined there exists. An undefined property (`var(--card)`,
  `var(--shadow-2)`) resolves to nothing **silently** — this cost a round of
  "why is it transparent". Read `themes.css` before inventing a token; match an
  existing component (`#legendCard` is the reference for map cards: `#fff`,
  14 px radius, z-index 900).
- **`.frost` does not position anything.** Adding a floating button and giving
  it `.frost` alone lands it at top-left under the sidebar. `css/components.css`
  carries a comment about this exact bug happening twice before; it happened a
  third time this session. Give floating controls explicit positioning.
- **Comments in this codebase explain *why*, at length.** Match that. Several
  files open with multi-paragraph rationale; that is the house style and it is
  what stops decisions being re-litigated.

---

## 2. THE BLOCKER — nothing shipped is live

**23 versions of finished, tested work (6.0068 → 6.0090) are on
`Map-Studio_V5` and none of them are deployed.** The live site serves
**6.0067 from `main`**, last touched 2026-07-21, 200+ commits behind. It does
not even contain `js/map/tileScrub.js`.

This made several rounds of the session much harder than necessary: fixes were
shipped, the operator looked at the live site, saw no change, and reasonably
reported the bug as unfixed.

Remote branches:

```
origin/main                                    ← HEAD, and what the site serves
origin/Map-Studio_V5                           ← all the work
origin/claude/map-studio-v5-upgrade-ia7o90     ← this session's designated branch
origin/claude/map-studio-production-polish-fkb12j
origin/claude/session-mlp1ns
```

The operator said *"claude/map-studio-v5 is the main branch"*, but no branch by
that name exists on the remote and `git remote show origin` reports `main` as
HEAD.

**What the next session must do before anything else:** ask for the branch name
under **GitHub → Settings → Pages → Build and deployment → Branch**. Until that
is known, no merge and no PR. The system prompt forbids pushing to any other
branch or opening a PR without explicit permission, and that has been respected
throughout — it is a question for the operator, not a decision to make.

---

## 3. What was built, 6.0061 → 6.0090

Grouped by feature, with the files that own each. Commit log is readable
(`git log --oneline`) and every message explains its reasoning.

### 3.1 The connectivity colour standard — `js/map/connectivityStandard.js`

**The problem it solved:** route colours came from `PALETTE[routes.length % n]`
— a rotating palette keyed on how many routes happened to exist. The same road
was a different colour in every report.

Now a route or shape carries `cls`, and `CONNECTIVITY_CLASSES` (one table, one
file) decides colour, weight and dash. Change a colour there and every map
changes with it.

Colours are derived from the **DBOT logo decoded from `LOGO_B64`** — navy
`#002166`, blue `#0073C6`, green `#7ED236`, gold `#E2BD60` — **not** from the
app's theme tokens (`--navy #0A1E3C`, `--orange #FF7A1A`), which are the
interface's colours and appear nowhere in the logo. Two logo colours were too
bright to read as a 4 px line on light OSM and were darkened to the same hue.

Current classes include lines (site, expressway, ring, **major `#011A49`** —
set by the operator, replacing orange), airportRoad, metro, railway, water;
marks (airport, station, metroStation, hub); **power** (HT line, LT line,
tower, substation — coloured as a warning, because an HT line is a constraint
that says "you cannot build here", not an amenity); and **land cover**
(built-up, industrial, commercial, green, farmland, buildings) with per-class
fill opacity, deliberately muted so roads stay readable over them.

`connLegendRows()` generates the legend from the classes actually in use, so
the key cannot contradict the drawing. The picker still allows deviation and
the card says when a route has deviated — a visible choice, not an accident.
In the Connectivity layout the picker is **locked**, at the operator's request.

### 3.2 Layouts — `js/map/layouts.js`

Two: **Connectivity** (OSM ground, standard on, `lockBasemap: true`) and
**Satellite** (hybrid imagery, standard off, free basemap choice). The ground
is remembered *per layout* (`basemapByLayout` pref) because one `basemap` key
cannot express two layouts wanting different grounds. `basemapLocked()` /
`syncBasemapLock()` disable the picker; `chooseBasemap()` refuses while locked.

### 3.3 Ring scan — `js/services/ringFeatures.js` + `js/ui/ringScanPanel.js`

Draw a catchment ring, press **⊙ Scan**, and Overpass is queried for what is
inside it: metro, rail, water, airports, roads, power, land cover, buildings,
settlements. Results are listed in a dialog with counts and lengths, **all of
them** (an early "…and 40 more" truncation was rejected), and **nothing lands
on the map unasked** — you tick what to keep, and what lands is an ordinary
shape you can restyle, rename, hide or delete.

Four Overpass mirrors, a 1.2 s rate gate, a 7-day byte-evicted cache, per-class
radius ceilings.

**`joinRingFeatures()` is the important part.** OSM returns roads as fragments —
the operator's words: *"IT IS NOT WHOLE ROADE LIKE FROM START TO END ONE LINE
IT IS IN PECIES"*. The joiner chains ways end-to-end within `1e-5°`, **grouped
by class rather than by name**, because the unnamed connector between two named
stretches has to be able to join either. 8 raw ways became 4 rows in testing.

Also here: `chainRings()` (multipolygons with holes), `pointInRing()`
(ray casting), `polysAreaKm2()` (shoelace), and `isAreaTagged()` — a closed way
is only an area if its *tags* say so, otherwise a roundabout gets filled as a disc.

`powerLineName()` puts voltage in the name ("220 kV — MSETCL"). It deliberately
does **not** compute corridor width: that is statutory and varies by
jurisdiction, and guessing it on a property map would be worse than silence.

### 3.4 The red medical symbols — `js/map/tileScrub.js`

**Six attempts, two rejected solutions, and the most instructive thing in the
session.** The operator wanted OSM's red hospital/pharmacy crosses gone. Twice
this was "fixed" by switching to a clean-styled ground (Positron), and twice
rejected — emphatically: *"I DONT WANT DIFFRENT MAP … I WANT THE OPENSTREET
STREET MAP ONLY SAME MAP JUST WHITOUT THE RED SYMBOLS"*. That was right: the
beige buildings, yellow roads and green parks **are** the map they want, and no
public server offers OSM Carto with the POI layer off.

The answer is a `ScrubbedTileLayer extends L.TileLayer` whose `createTile`
draws each tile to a canvas, masks OSM Carto's healthcare red `#BF0000`, grows
two anti-alias rings so text does not leave grey ghost words, and **inpaints**
the holes by repeatedly averaging clean neighbours — so an icon on
building-beige leaves building-beige, not a white confetti hole.

**The near-miss worth remembering:** the first version used only *relative*
dominance (red much higher than green and blue). OSM Carto draws
under-construction highways as pink dashes around `(230,145,160)`, which
satisfies that test — so it silently deleted the **Thane–Borivali Twin Tunnel**
from a property map. The fix is absolute ceilings: healthcare has g,b under
~90; construction pink has both over 130. Verified: cross 432 px → 0, tunnel
744 px → 744.

**Zoom gate:** `PLACE_ICON_MIN_TILE_Z = 16`. Past a ~300 m scale the tiles are
left alone — a wall of crosses across a locality is clutter, the same crosses
when you have zoomed to one street are the answer to "what is next door". The
operator set the 300 m threshold after comparing against openstreetmap.org.

**Export bias:** `setScrubZoomBias()`. The export renders `log2(scale)` levels
deeper for pixel density, so tiles sailed over z16 and every export kept the
crosses the screen had just dropped. `hiResRender.js` sets the bias while it
builds its ground and clears it in a `finally`.

### 3.5 Map overlays and identify

- `js/map/mapOverlays.js` — transparent raster layers (labels, roads, railway,
  hillshade) over a plain ground, so you can show just roads, or no names.
  `setPlaceIcons()` rebuilds the *same* ground rather than swapping cartography.
- `js/services/mapIdentify.js` — click anything and see what OSM knows about it.
  `identifyScore()` picks the most specific feature (a named shop beats the
  building beats the landuse); whitelisted tags; radius grows as you zoom out;
  defers to every other armed tool.

### 3.6 The editable legend — `js/ui/colorKey.js`

A LEGEND card on the map, generated from the classes in use, with per-row label
and colour editing, hiding, and custom added rows — *"purple is industry and
red is the residential"*. `colorKeyUnclassedRows()` groups un-classed routes and
shapes by colour so older projects still get a legend. Drags from its whole
header (4 px movement threshold, so a click still edits the title). The Key
Distances card got the same treatment.

### 3.7 Pins, routes, icons

- `js/map/billboard.js` — Google-Maps-style teardrop pins: coloured body, white
  keyline, **white symbol** inside (the operator's call: *"we will keep logo
  white and chanfe marker color"*). Note `svgForKey`'s third argument is the
  **outline** colour, not fill — passing a colour there gives a wireframe glyph.
- `js/map/routes.js` — `nextRoutePair()`: **+ Add route** walks to the next
  location instead of repeating the same pair.
- `js/ui/propertyPanel.js` — `applyIconStyleToAll()`: set one location's icon
  style and push it to all of them.

### 3.8 Export fixes

`css/layout.css` `.map-wrap.pptx-capture` / `.capturing` hide everything that is
furniture rather than map: editing handles, vertex markers, edit pencils, `×`
buttons, grips, card footers. PPT legend/key cards were rebuilt to match the
on-screen cards using native `addTable`/`addText` with glyph swatches (●▬■)
rather than filled cells.

---

## 4. Known bugs and open work

**Bugs, diagnosed and not fixed:**
- **Undo does not cover location icon styling**, so "Apply this style to all" is
  not undoable. (This was tested, found false after being written up as working,
  and the claim removed rather than shipped.)
- **PPT legend cards have square corners** where the on-screen cards are rounded.

**Asked for, not built:**
- **OpenFreeMap vector basemap** — full spec at
  `docs/OPENFREEMAP-VECTOR-BASEMAP.md`. Destined for its own chat.
- **KML/KMZ export** (the operator asked about importing Google Earth markers).
- **Team collaboration** — a multi-session project, scoped as five phases:
  Supabase auth + schema + row-level security → projects landing page → cloud
  save/open with conflict detection → per-project sharing and live presence →
  migrating existing local work into accounts. **Phase 1 is the only sensible
  start**; sharing and presence are meaningless without accounts.
  `js/projects/` and `vendor/supabase.js` already exist as partial groundwork.
- A proper design pass over both map cards (the `ui-ux-pro-max` skill was named).
- More icons.

---

## 5. Environment constraints (verified, not assumed)

- **Every CDN and tile host is blocked** through the agent proxy — 403 on
  CONNECT for unpkg, `tiles.openfreemap.org`, `basemaps.cartocdn.com`, Esri,
  and the tile servers themselves. **No map tile rendered in any screenshot in
  the entire session.** Anything visual involving real tiles cannot be verified
  here; it has to be checked on a real machine.
- **The npm registry IS reachable** — `npm pack maplibre-gl@4.7.1` succeeded
  (7,989,733 bytes). That is the route for vendoring dependencies.
- **Overpass is blocked too.** Ring scan was verified against recorded response
  fixtures via Playwright `page.route`, never against the live API.
- The tile scrub is verified against **fabricated tiles** painted with the exact
  OSM Carto colours — correct as a unit test, not a substitute for looking at a
  real map.
- Testing pattern that works here: `python3 -m http.server 8000` from the repo
  root, driven by Playwright at 1600×1000, with `page.route` fixtures for
  anything external.

---

## 6. Mistakes made this session — do not repeat them

Written down because each one cost a round trip.

1. **A dialog shipped invisible.** `.modal-overlay` is `opacity: 0` until `.on`
   is added; only `hidden` was cleared. Every assertion passed, because
   `textContent` works fine on an invisible element. **A screenshot caught it.**
   → Assert something visual — computed opacity, a pixel — not just the DOM.
2. **Invented CSS tokens.** `var(--card)`, `var(--shadow-2)` — defined nowhere,
   fail silently. → Read `css/themes.css` first.
3. **Positioned a card with inline styles that beat the responsive rule**, so
   the legend went off-screen on short viewports. → Clear inline styles first,
   override only when it actually fits.
4. **Tested a fix on the live map and saw no change**, because Leaflet reuses
   cached tile canvases. → Test tile changes on *fresh* layers.
5. **`.frost` for a floating button** — third time in this codebase.
6. **`const` reassignment** in `setMapLayout` would have thrown at runtime;
   `node --check` does not catch it. → Run the code, not just the parser.
7. **Three persistence bugs of my own making**: `extractGeomCoords` did
   `ring = ring[0]`, discarding holes and all but the first polygon; `cls` was
   in neither the GeoJSON properties nor the undo snapshot; `MultiPolygon` was
   unmapped, so merged buildings vanished on load. → When adding a field to a
   runtime object, check *all four* of: GeoJSON out, GeoJSON in, undo snapshot,
   project serialise/apply.
8. **`applyProject` never rebuilt the legend**, so a reopened project showed the
   previous project's key. Routes trigger a rebuild via measurements; shapes
   do not.
9. **A colour picker that commits live while dragging** cannot have its callback
   rebuild the DOM — it destroys the popover's own anchor. Repaint just the mark.
10. **Twice answered "remove the red symbols" by changing the map.** The
    operator's constraint was explicit and had to be read literally.

---

## 7. How the operator works

Short, direct, often typed in caps when something is wrong, frequently with
screenshots. Emphasis and repetition mean the constraint is real and literal —
*"SAME MAP JUST WHITOUT THE RED SYMBOLS"* meant exactly that, not "something
similar without them". When they repeat a request, the previous answer missed
the point rather than being 90% right.

They check work by **looking at the live site**, which is why §2 matters so
much. They care about how the exported document looks to a client, and will
compare against reference screenshots (openstreetmap.org, Google Maps) to make
a point.

---

## 8. Starting the next chat

1. **Ask for the GitHub Pages branch** (§2). Nothing reaches the operator until
   that is answered.
2. Then pick one of: OpenFreeMap vector basemap
   (`docs/OPENFREEMAP-VECTOR-BASEMAP.md` — self-contained), team collaboration
   Phase 1 (Supabase auth + schema + RLS), or the two known bugs in §4.
3. Work on `Map-Studio_V5` unless told otherwise. Bump the version, stamp the
   assets, commit with a message that explains *why*, push with
   `git push -u origin Map-Studio_V5`.
4. Do not open a pull request unless asked.

**One standing note on honesty:** several things in this app cannot be verified
from a sandbox — tiles, Overpass, anything visual involving the network. Say so
plainly rather than describing design as if it were measurement. That has been
the practice throughout and it is worth keeping.

# Phase 3 — Feature Inventory (v4.9 → v5.0)

Complete capability checklist derived from reading the current single-file app
(`index.html`, v4.9, 3,561 lines). **This is the acceptance test for Phase 6** —
nothing here may be silently dropped during migration. Each row names the v4.9
source symbol(s) and the target module it migrates to.

> Source note: this inventory is built from the **v4.9** file in the repo. The
> build brief referenced an ~11k-line v4.94 that was never uploaded. If v4.94
> lands, this list is extended, not replaced — the subsystems below are stable.

Legend: ☐ = to migrate · all currently present in v4.9 unless marked _(absent)_.

---

## core/ — app state, events, storage, logging

| ☐ | Capability | v4.9 source | Target |
|---|---|---|---|
| ☐ | Global app state (`locations[]`, `routes[]`, active basemap, tilt, chip scale, flags) | module-level `let` vars | `core/state.js` |
| ☐ | Status/toast messages + spinner | `status()`, `setSpin()`, `#statusMsg`, `#sSpin` | `core/events.js` or `ui/notifications.js` |
| ☐ | `$()` DOM helper, event wiring | `$`, `addEventListener` blocks | `core/events.js`, `utils/dom.js` |
| ☐ | Structured logging (export skip reasons etc.) | ad-hoc `status()` | `core/logger.js` |
| ☐ | Undo/redo history | _(absent in v4.9)_ | `core/history.js` (stub; wire only if v4.94 has it) |
| ☐ | Autosave / localStorage persistence | _(absent in v4.9)_ | `project/autosave.js` (stub) |

## map/ — Leaflet engine & overlays

| ☐ | Capability | v4.9 source | Target |
|---|---|---|---|
| ☐ | Leaflet map init (no zoom/attribution ctrl, maxZoom 21, India center) | `L.map('map', …)` | `map/mapEngine.js` |
| ☐ | 13 basemaps (hybrid, sat, esristreet, osm, voyager, lightgray, darkgray, positron, dark, topo, natgeo, opentopo) | `BASEMAPS`, `setBasemap()`, `mk`, `TL`, `ESRI` | `map/mapEngine.js` + `config.js` |
| ☐ | HD / retina toggle | `#hdTgl`, `RZ()` | `map/mapEngine.js` |
| ☐ | Hillshade overlay toggle | `hillshade`, `#hillTgl` | `map/mapEngine.js` |
| ☐ | Map credit line + toggle | `#mapCredit`, `#creditTgl` | `map/mapEngine.js` |
| ☐ | Fit-all bounds | `fitAll()`, `#fitBtn` | `map/mapEngine.js` |
| ☐ | 3D tilt (CSS billboard) + perspective warp for capture | `applyTilt()`, `warpPerspective()`, `#tiltRange`, `#tiltStage`, `repaintBillboard`, `scheduleRepaint` | `map/mapEngine.js` |
| ☐ | Markers: create/render/update, pin element + label element | `addLocation`, `renderLocPin`, `makePinEl`, `makeLabelEl`, `buildLocCard`, `deleteLocation`, `locChanged` | `map/markers.js` |
| ☐ | Icon library (14 SVG icons, colour-tinted) | `ICON_LIBRARY`, `ICON_KEYS`, `svgForKey`, `iconFor`, `locLabelIconHtml` | `map/icons.js` |
| ☐ | Icon styling: size, frame (none/circle/rounded/square), bg, border, custom image upload, project-logo-as-icon | loc.iconSize/iconFrame/iconBg/iconBorder/iconImage/iconUseProjectLogo | `map/markers.js` + `map/icons.js` |
| ☐ | Marker types: site (★), badge (text), standard; `hideMarker` | loc.type, `badgeText` | `map/markers.js` |
| ☐ | Labels: show/hide, drag-reposition, pinned offset, custom bg, leader lines | `updateLocLabel`, `loc.labelOffset/labelPinned/labelBg`, `projectPin` | `map/labels.js` |
| ☐ | Distance rings + ring labels around a location | `updateRings`, `renderRingRows`, `renderRingRows`, `loc.ringLabels` | `map/markers.js` (rings) |
| ☐ | Routes: create/compute/draw, car/bike/foot profiles, OSRM + fallback | `addRoute`, `computeRoute`, `drawRoute`, `#addRtBtn`, profile URLs | `map/routes.js` + `services/routing.js` |
| ☐ | Route via-points (arm/place/drag/remove) | `armViaAdd`, `disarmVia`, `renderViaDots`, `armingViaFor` | `map/routes.js` |
| ☐ | Route alternatives (A→B only) | `computeRoute` alt handling | `map/routes.js` |
| ☐ | Route labels (auto/manual text, bg, anchor, drag) | `routeLabelText`, `routeAutoText`, `updateRtCardStats` | `map/labels.js` |
| ☐ | Route bookkeeping when markers move | `recomputeRoutesTouching`, `refreshRouteSelects` | `map/routes.js` |
| ☐ | Right-click route context menu | `showRouteContextMenu`, `#ctxMenu` | `ui/dialogs.js` |
| ☐ | Auto collision avoidance / offset overlapping markers | `autoAvoidCollisions`, `offsetCoords`, `offsetCoords` | `map/snapping.js` |
| ☐ | Click-to-add placement mode (+ Esc to cancel) | `setAdding`, `addingMode`, `#clickAddBtn`, keydown Esc | `map/mapEngine.js` + `ui/shortcuts.js` |
| ☐ | Distance math (haversine) | `haversineKm` | `utils/math.js` |

## ui/ — sidebar, toolbar, panels, dialogs

| ☐ | Capability | v4.9 source | Target |
|---|---|---|---|
| ☐ | Sidebar tabs (Map / Locations / Routes / Brand) + collapse | `#tabBtn*`, `#pane*`, `#sideToggle` | `ui/sidebar.js` |
| ☐ | Toolbar actions (add loc/route, click-add, fit, fullscreen, search) | `#addLocBtn`, `#addRtBtn`, `#fitBtn`, `#fsBtn`, `#searchBtn` | `ui/toolbar.js` |
| ☐ | Location & route cards (list, edit fields, empties) | `buildLocCard`, `buildRtCard`, `syncEmpties`, `#locList/#rtList/#locEmpty/#rtEmpty` | `ui/propertyPanel.js` |
| ☐ | Overlay toggles: brand, legend, title, north arrow, scale bar, credit, glass | `#brandTgl/#legendTgl/#titleTgl/#northTgl/#scaleTgl/#creditTgl/#glassTgl` | `ui/toolbar.js` |
| ☐ | Editable title card | `#titleCard`, `#titleTgl` | `ui/propertyPanel.js` |
| ☐ | Legend card: rows, title, draggable | `legendRows`, `rebuildLegend`, `legendDraggable`, `#legendCard/#legendTitle/#legendDrag` | `ui/propertyPanel.js` |
| ☐ | North arrow, scale bar, brand mark overlays | `#northArrow`, `#scaleTgl`, `#brandMark` | `ui/toolbar.js` |
| ☐ | Label size scale (chip %) | `applyChipScale`, `chipPct`, `chipFont`, `#chipRange/#chipVal` | `ui/propertyPanel.js` |
| ☐ | Status notifications + spinner | `status()`, `setSpin()` | `ui/notifications.js` |
| ☐ | Search box UI (dropdown, keyboard nav) | `renderResults`, `pickResult`, `#searchInput/#searchResults`, arrow/enter/esc | `ui/toolbar.js` + `services/geocoder.js` |
| ☐ | Keyboard shortcuts (Esc cancels add/via/ctx-menu; search nav) | keydown handlers | `ui/shortcuts.js` |
| ☐ | Brand panel: project logo upload/clear, brand title, site-uses-logo | `setProjectLogo`, `#projLogoInput/#uploadProjLogoBtn/#clearProjLogoBtn/#brandTitleInput/#siteUsesProjLogo/#brandPreview` | `ui/propertyPanel.js` + `project/*` |

## services/ — external APIs

| ☐ | Capability | v4.9 source | Target |
|---|---|---|---|
| ☐ | Forward geocoding (Nominatim search) | `doSearch`, `renderResults` | `services/geocoder.js` |
| ☐ | Reverse geocoding (Nominatim reverse) | reverse fetch | `services/geocoder.js` |
| ☐ | Routing (OSRM car/bike/foot + fallback host, alternatives, via) | profile URL table, `computeRoute` | `services/routing.js` |
| ☐ | Places (icon/type inference from geocode) | inline in `pickResult` | `services/places.js` |

## export/ — output engines (PPTX already rebuilt in Phase 1)

| ☐ | Capability | v4.9 source | Target |
|---|---|---|---|
| ✅ | **Editable PPTX export** | old `#pptxBtn` handler | `export/exportPPT.js` (+ ppt*) — **done, Phase 1** |
| ☐ | PNG export (html2canvas, scale 2, perspective warp) | `#pngBtn`, `captureMap`, `warpPerspective` | `export/exportPNG.js` |
| ☐ | Print / Save-as-PDF (window.print + @media print) | `#printBtn`, `beforeprint`/`afterprint`, print CSS | `export/exportPDF.js` |
| ☐ | Map capture helper (shared by PNG/PPTX) | `captureMap()` | `export/captureMap.js` (or `map/`) |

## project/ — save / open

| ☐ | Capability | v4.9 source | Target |
|---|---|---|---|
| ☐ | Save project → JSON download (v:4.9 schema) | `#saveBtn`; serializes title, legendTitle, view, basemap, tilt, hill, chipPct, hd, brand, north, projectLogo, siteUsesProjLogo, locations[], routes[] | `project/saveProject.js` |
| ☐ | Open project ← JSON (restore all state) | `#loadBtn`, `#loadInput` | `project/openProject.js` |

## utils/ — shared helpers

| ☐ | Capability | v4.9 source | Target |
|---|---|---|---|
| ☐ | Colour helpers (tint/lighten, contrast, channels, hex) | `lighten`, `chan`, `textOn`, `hex`, `esc` | `utils/colors.js`, `utils/helpers.js` |
| ☐ | Coordinate parse/format/offset | `parseCoord`, `fmtCoord`, `offsetCoords`, `routeName` | `utils/helpers.js` |
| ☐ | Geometry/math (haversine, projection) | `haversineKm`, `projectPin` | `utils/math.js` |
| ☐ | DOM builders / escaping | `mk`, `esc`, `showBox` | `utils/dom.js` |
| ☐ | Input validation | inline | `utils/validator.js` |

---

## Cross-cutting UI details to preserve (visual parity)

- Dark navy theme (`#0A1E3C`), orange accent (`#FF7A1A`), glass panels.
- Fullscreen mode, responsive sidebar collapse.
- Print stylesheet hides UI chrome; markers/labels stay.
- `.pin-ghost` / `.capturing` / `.pptx-capture` capture-only CSS states.
- CDN runtime deps to internalise via Vite: Leaflet, html2canvas, pptxgenjs
  (pptxgenjs now bundled from npm 4.0.1 by the new engine).

## Absent in v4.9 (do NOT invent unless v4.94 provides them)
- Undo/redo history · autosave/localStorage · polygons/area-draw · standalone
  distance-measure tool. Target files `core/history.js`, `project/autosave.js`,
  `map/polygons.js`, `map/distance.js` remain **stubs** unless the real source
  has them.

**Status:** Phase 3 complete. This checklist gates Phase 6 acceptance.

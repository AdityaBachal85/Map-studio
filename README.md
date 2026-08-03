# Map-studio

# 🗺️ DBOT Property Map Studio

> Professional Interactive Property Mapping Tool for Real Estate Research, Market Analysis & Presentation Generation

![Version](https://img.shields.io/badge/version-v6.0008-blue)
![Built With](https://img.shields.io/badge/Built%20With-Leaflet-orange)
![Status](https://img.shields.io/badge/status-Active-success)

---

## 📖 Overview

DBOT Property Map Studio is a professional browser-based mapping application developed for creating premium real estate location maps.

It enables users to create presentation-ready maps with custom markers, connectivity routes, legends, distance measurements, branding, and export capabilities without requiring GIS software.

Designed primarily for:

- 🏢 Real Estate Consultants
- 📊 Market Researchers
- 📍 Property Analysts
- 📑 Presentation Teams
- 🏗️ Developers

---

# ✨ Features

## 🆕 New in v6.0008 (latest)

### AI Reports — a research pipeline behind the map, not inside the browser

A new **AI Reports** panel, opened from the ✦ button in the map's control
stack (under Fullscreen and Layers): tag any location as a **Site ★** (the
existing Location/Site/Hwy-badge selector on every location card), pick it,
and generate a location-intelligence report — Executive Summary,
Connectivity, Government & Upcoming Infrastructure, and Recent News & Local
Safety — as a downloadable PDF and Word document, plus a follow-up chat for
questions about that report.

It lives on the map rather than in the sidebar tab bar for two reasons: a
sixth tab pushed every label in that bar to truncation, and a report is about
one specific place on the map, which makes a map control the more natural
home for it.

This is deliberately not "the app calls an AI API with a key baked into the
page" — the Gemini key that does the actual research and writing never
ships to the browser at all. A small backend (`server/`, a plain Node/Express
app deployed separately) runs a **multi-agent pipeline**: a
Research Planner decides what to research, four specialized agents
(Connectivity, Infrastructure, Government Projects, News) each research one
topic with Gemini's Google Search grounding, a Report Writer agent that
never searches — only synthesizes — turns their findings into the final
document, and an AI Chat Agent answers follow-ups from that evidence first,
only spending a fresh search when a question genuinely needs one. The
backend also owns the real, self-counted "credits used today" figure shown
in the panel (Gemini's API has no live-quota endpoint to ask, so this is
counted by the only thing spending against the key — see
`docs/AI-REPORTS-SETUP.md`), the daily/concurrency caps that keep usage
inside the free tier, and the 48-hour report expiry.

The client side of this ships in every deploy; the backend is a **separate,
manual setup** — Supabase (Postgres) + Render + a Gemini key, all free tiers
with no credit card — documented end to end in `docs/AI-REPORTS-SETUP.md`.
It's a plain Express app with no cloud-specific code, so any Postgres and any
Node host work equally well. Until it's deployed and
`AI_FUNCTIONS_BASE_URL` is set in `js/config.js`, the panel is present but
tells you plainly that it isn't configured yet, rather than failing
mysteriously.

Also in this release: **Nearby search radius now goes up to 20 km** (was
5 km). Five kilometres is fine for schools and shops, but too tight for the
things people actually check a site against — the nearest airport, a highway
junction, an IT park.

## 🆕 New in v5.0030

### Google Maps Platform — search, nearby and routing

Search, nearby discovery and routing now go to Google first, with the previous
providers untouched behind them as a fallback. Only the modern, CORS-enabled
APIs are used (`places.googleapis.com/v1/*`, `routes.googleapis.com`), because
the legacy `maps.googleapis.com/maps/api/*` endpoints send no
`Access-Control-Allow-Origin` header and cannot be called from a browser at all.

- **Search bar** — Google Autocomplete while you type, Text Search on Enter.
  Keystrokes share one session token, so a search that ends in a pick bills as
  a single session rather than per keystroke.
- **Nearby places** — ranked by prominence rather than raw distance. This is the
  difference between twenty playgroups within 500 m and the schools people
  actually ask about; verified at Airoli, where distance ranking never returned
  EuroSchool, DAV, VIBGYOR High or St Xavier's at all.
- **Schools vs colleges** — Google has no `college` type, and Indian listings do
  not respect the ones it has: a junior college is typed `school`, EuroSchool is
  an `educational_institution`, and a computer shop is typed `university`. Both
  chips ask for the broad parent type and let the *name* decide which list a
  place lands on.
- **Routing** — Google Routes with alternatives, falling back to OSRM. Indian
  route descriptions come back in English because `languageCode` is set
  explicitly; without it they arrived in Assamese.

### Nearby: put what you find on the map

- **Click any discovered place** for a popup with its name, address and distance,
  and one action — **+ Add to locations**. It becomes a real project pin
  carrying the category colour.
- **Search for anything** — a text box that is not limited to the twelve
  category chips. Type `real estate agents`, `cake shops`, `under construction
  projects` and the query becomes its own chip you can toggle or remove. Results
  outside the radius are dropped and counted, so the status line can tell you to
  widen the circle rather than leaving you wondering.

### Bulk import from Excel / CSV

- A **master template** (`Name`, `Lat/Long`, `Type`, `Route to`, `Mode`) with
  drop-downs, written and read without adding a spreadsheet library — the reader
  and writer are built on the already-vendored JSZip.
- Every row is validated before anything touches the map: coordinate format,
  swapped lat/long, duplicates, and routes pointing at names that do not exist.
  The review dialog reports problems by spreadsheet row number and asks whether
  to add to the current map or replace it.
- **Round-trips** — export the current map in the same format you import.

### Provider keys, in the app

- **Settings → Map providers & keys** — paste an ArcGIS or Google key, verify it
  live, and see exactly which features it unlocks. Keys are stored per device,
  never written into project files, and survive `?reset=1`.
- A key pasted against the wrong provider is detected and refused rather than
  silently breaking every request.

### Interface

- **Typography** — Geist and Geist Mono, self-hosted under `vendor/fonts/`
  (SIL OFL 1.1). Until now the stylesheet asked for Inter and no font was ever
  loaded, so everyone fell through to their OS default and the app looked
  different on every machine.
- **Tabs** — a sliding pill in the manner of Kokonut UI's Smooth Tab, on the
  real `spring(400, 30)` curve sampled into a CSS `linear()` ramp, with
  `role="tablist"`, arrow-key navigation and a roving tabindex.
- **Pane transitions** — the outgoing and incoming panes cross over instead of
  one blanking before the other arrives, and each tab remembers its own scroll
  position.
- All of it respects `prefers-reduced-motion` and the in-app **Glass / motion**
  preferences.

---

## 🆕 Earlier in v5

Recent additions, all fully integrated into the existing app (no redesign — the
original workflows, shortcuts and exports are unchanged):

- **Professional search** — Geoapify geocoding (cities, villages, roads,
  buildings, schools, hospitals, airports, malls, PIN codes, coordinates…) with
  proximity ranking, de-duplication and caching, and a **silent automatic
  fallback to Nominatim** if Geoapify is unavailable.
- **Modern search box** — a floating frosted pill with a magnifier button that
  expands/collapses (a compact search button on mobile), smooth animations and
  a circular submit button.
- **Professional drawing tools** — Marker, Polyline, Polygon, Rectangle, Circle
  and Circle-marker, each with create / edit / drag / resize / rotate / delete
  and app-level **undo/redo** (Ctrl+Z / Ctrl+Y), built on Leaflet-Geoman.
- **Live measurements** — distance, perimeter and area update live while you
  draw or edit, in m / km / m² / sq ft / acres / hectares / km².
- **Full shape styling** — per-shape name, description, notes, fill & border
  colour, border width, fill opacity, **line style (solid/dashed/dotted)**,
  corner style, an on-map name label and a glow halo, plus created/modified
  dates.
- **GeoJSON import/export** — round-trips every shape with its style and
  metadata; shapes also travel inside the regular `.json` project file.
- **Aerial (straight-line) distance** — click two points for straight-line
  distance + compass bearing; measurements persist, both endpoints are
  draggable to adjust, and each has a one-click delete.
- **Nearby places discovery** — from the **Nearby** tab, pick a centre + radius
  and toggle categories (schools, colleges, hospitals, pharmacies, stations,
  airports, malls/markets, petrol pumps, hotels, restaurants, banks/ATMs, parks)
  to drop labelled pins, via the Geoapify Places API. Categories load on demand
  and cache, to stay light on API credits.
- **Reorganized Settings** — the old "Map" tab is now a tidy **Settings** tab
  with collapsible sections (Basemap & imagery, 3D & terrain, Overlays, View,
  Export, Project).

> **API keys.** The app has no backend, so any key in `js/config.js` is visible
> in the page source. That is the normal arrangement for browser keys, and the
> restriction is what makes it safe: limit each key by HTTP referrer to your own
> domain, and set a quota cap. Leave a key empty to disable that provider — the
> app degrades to the next one in the chain rather than breaking.
>
> **Quotas are per day, not just per month.** Google's free monthly allowance is
> generous (on India pricing, 70,000 calls per Essentials SKU and 35,000 per Pro
> SKU), but a project also carries a *daily* cap set in the Cloud console under
> **APIs & Services → Places API (New) → Quotas**. Exhausting it looks exactly
> like the feature breaking, so the app now names the reason in the status line
> and falls back to Geoapify instead of going quiet.

---

## 🗺️ Interactive Maps

- OpenStreetMap integration
- Smooth zoom & pan
- Search any location
- Satellite-ready architecture
- Mobile responsive

---

## 📍 Smart Location Pins

- Custom icons
- Custom colors
- Adjustable size
- Glow effects
- Hidden anchor markers
- Draggable markers
- Billboard labels
- Premium Apple/Google Maps style badges

---

## 🛣️ Route Builder

Create professional connectivity routes with:

- Solid lines
- Dashed lines
- Curved routes
- Via Points
- Arrow directions
- Distance labels
- Highway labels
- Route customization

---

## 📏 Distance Rings

Generate multiple distance buffers around the project site.

Features include:

- Multiple rings
- Custom radius
- Editable colors
- Adjustable opacity
- Ring labels
- Visibility controls

---

## 📋 Professional Legend

Automatically generates:

- Key Distances table
- Color indicators
- Editable title
- Draggable legend
- Presentation-ready layout

---

## 🎨 Fully Customizable

Customize nearly everything:

- Marker icons
- Labels
- Fonts
- Colors
- Route styles
- Ring styles
- Project title
- Company branding
- Logo
- North arrow
- Scale bar

---

## 📤 Export Options

Generate presentation-ready outputs.

Supports:

- PNG Export
- High Resolution Image
- Print Layout
- PowerPoint Ready Maps

---

## 🔍 Search System

Built-in location search (Geoapify, with automatic Nominatim fallback):

- Live search with typed suggestions
- Proximity-ranked, de-duplicated results with category icons
- Paste `lat, lng` to drop a pin at exact coordinates
- Recent searches + keyboard navigation
- One-click add marker
- Fast navigation

---

## 📱 Responsive Design

Works on:

- Desktop
- Laptop
- Tablet
- Mobile Devices

---

# 🛠️ Built With

- HTML5, CSS3, plain JavaScript (no build step, no bundler)
- [Leaflet](https://leafletjs.com/), [Leaflet-Geoman](https://geoman.io/leaflet-geoman)
  (drawing/editing), [html2canvas](https://html2canvas.hertzen.com/),
  [pptxgenjs](https://gitbrent.github.io/PptxGenJS/), [JSZip](https://stuk.github.io/jszip/)
  — vendored directly under `vendor/`, loaded as plain `<script>` tags
- [Geist](https://vercel.com/font) and Geist Mono (SIL OFL 1.1), self-hosted
  under `vendor/fonts/` — one variable file per family, no third-party request
- OpenStreetMap / Esri / CARTO tiles; [Google Maps Platform](https://developers.google.com/maps)
  Places (New) + Routes for search, nearby and routing, with
  [Geoapify](https://www.geoapify.com/) geocoding + Places, Nominatim and OSRM
  behind it as fallbacks (all need internet at runtime)

---

# 🏗️ Architecture

**There is no build step.** `index.html` loads `css/*.css` and every file in
`js/**` directly as classic (non-module) `<script>` tags, in a fixed
dependency order already wired up in `index.html` — open the file and it
just runs, in a browser or on GitHub Pages alike.

```
Map-studio/
  index.html      — the whole app's markup + the ordered list of <script> tags
  vendor/fonts/   — Geist + Geist Mono variable woff2 + OFL licence
  vendor/         — third-party libraries, vendored as plain files (leaflet.js/.css,
                       leaflet-geoman.js/.css, html2canvas.js, pptxgen.bundle.js, jszip.js)
  css/
    main.css        — @import order (do not reorder — later rules override earlier ones)
    themes.css, style.css, map.css, sidebar.css, components.css, layout.css
  js/
    app.js          — runs last: wires everything together, prints the boot message
    constants.js, config.js   (config.js holds ROUTERS + the Geoapify API key)
    core/state.js    — locations[], routes[], brand{}, uiState{} — the single
                         source of truth every other file reads/writes
    map/            — mapEngine, billboard (pin/label overlay), snapping,
                        markers, routes, icons, aerialDistance (straight-line
                        measure), drawing (shape tools + undo/redo), nearby
                        (Nearby-places markers)
    ui/             — sidebar, toolbar, propertyPanel, geometryPanel (shape cards),
                        searchBox (collapse UI), dialogs, notifications
    services/       — geocoder (search box), geoapify (Geoapify-first geocoding +
                        Nominatim fallback), nearbyPlaces (Places API), places
                        (icon inference)
    export/         — the PPTX engine (exportPPT + pptShapes/pptImages/pptLabels/
                        pptTables/pptValidation/pptUtils) + pptxHandler,
                        captureMap, exportPNG, exportPDF
    project/        — saveProject, openProject, geojson (shape import/export)
    utils/          — dom, math (geodesic length/area), colors
  legacy/           — pristine single-file rollbacks of earlier versions
  docs/             — PHASE0-PPTX-DIAGNOSIS.md (the export-corruption root cause),
                        PHASE3-FEATURE-INVENTORY.md (feature checklist)
```

Every file in `js/` is a plain script — no `import`/`export`. `index.html`
loads them in the exact order each one needs its dependencies to already
exist; don't reorder those `<script>` tags.

---

# 🚀 Getting Started

**Locally:** just double-click `index.html`. It opens and works — no Node,
no npm, no terminal.

**To edit:** open any file in `js/` or `css/` in a text editor, save, then
refresh the page in your browser. Changes show up immediately.

## Deploying

Push to GitHub and set the repo's **Settings → Pages → Build and deployment
→ Source** to **"Deploy from a branch"**, pointed at whichever branch you're
using. GitHub serves the files as-is — no build, no GitHub Actions workflow
needed. Pushing an edit updates the live site on the next deploy (usually
under a minute).

The one thing no automated check can confirm is *"opens in desktop
PowerPoint 365 with zero repair prompts"* — that needs a human with real
PowerPoint. See `docs/PHASE0-PPTX-DIAGNOSIS.md` for how that was diagnosed.

---

# 💼 Ideal Use Cases

- Property Valuation
- Real Estate Reports
- Location Analysis
- Connectivity Maps
- Infrastructure Maps
- Market Research
- Client Presentations
- Investment Reports

---

# 🎯 Major Capabilities

✅ Property Mapping

✅ Connectivity Analysis

✅ Distance Calculation

✅ Editable Legends

✅ Premium Labels

✅ Route Builder

✅ Multiple Marker Styles

✅ Drawing Tools (polygons, boundaries, live area/perimeter)

✅ Aerial (Straight-Line) Distance

✅ Nearby Places Discovery

✅ GeoJSON Import / Export

✅ Export Ready

✅ Presentation Ready

✅ Responsive Interface

---

# 📸 Screenshots

Add screenshots here after uploading them.

Example:

```

screenshots/
├── Home.png
├── Route.png
├── Legend.png
├── Export.png

```

---

# 🚀 Planned Features

## 💾 Project Management

- Save & Load Projects
- Auto Save (Recovery System)
- Version History
- Recent Projects
- Project Templates
- Multiple Maps per Project
- Project Backup & Restore

---

## 👥 Team Collaboration

- Share Projects via Link
- Multi-User Collaboration
- Real-Time Editing
- Team Workspace
- Comments & Review Mode
- Role-Based Access (Viewer / Editor / Admin)
- Activity & Edit History

---

> ✅ Already shipped in v5: Aerial (straight-line) distance, site polygon
> drawing, plot boundary measurement, land-area calculation (m² / sq ft / acres
> / hectares / km²), and nearby school/hospital/metro discovery — see
> **New in v5** above.

- Road Network Distance
- Drive Time & Travel Time Analysis (isolines)
- Property Buffer Analysis
- Radius & Catchment Analysis
- Custom GIS Layers
- Terrain & Elevation View
- 3D Building Visualization
- Parcel / Survey Number Overlay

---

## 🏢 Real Estate Intelligence

- Nearby Residential Projects
- Comparable Property Analysis
- Competitor Project Mapping
- Retail & Commercial Catchment
- Future Infrastructure Tracking
- Market Growth Heatmaps
- Development Pipeline Visualization
- Population Density Layers
- Zoning & Land Use Layers
- Government Development Projects

---

## 🤖 AI Integration

- AI Property Report Generator
- AI Location Summary
- AI Connectivity Analysis
- AI Investment Score
- AI SWOT Analysis
- AI Market Insights
- AI Auto Label Placement
- AI Route Optimization
- AI Presentation Generator
- AI Image & Map Enhancement
- AI Site Recommendation Engine
- AI Chat Assistant for Maps

---

## 📊 Professional Reporting

- One-Click Valuation Maps
- Automatic Key Distance Tables
- PDF Report Export
- PowerPoint Presentation Generator
- Word Report Export
- Excel Data Export
- Custom Company Branding
- Batch Report Generation

---

## 🌐 Enterprise Features

- Cloud Project Storage
- Organization Dashboard
- User Management
- Audit Logs
- API Integration
- Google Maps Support
- Mapbox Support
- ArcGIS Support
- Offline Project Mode
- Mobile Companion App

---

# 🤝 Contributing

Contributions are welcome.

If you have suggestions, improvements, or feature requests, feel free to open an issue or submit a pull request.

---

# 👨‍💻 Developed By

**Aditya Bachal**

Research Analyst – Valuation

DBOT Realty Pvt. Ltd.

---

## ⭐ Support

If you found this project useful,

please consider giving it a ⭐ on GitHub.

It really helps!

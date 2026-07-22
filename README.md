# Map-studio

# 🗺️ DBOT Property Map Studio

> Professional Interactive Property Mapping Tool for Real Estate Research, Market Analysis & Presentation Generation

![Version](https://img.shields.io/badge/version-v5-blue)
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

Built-in location search with:

- Live search
- Result suggestions
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

- HTML5, CSS3, JavaScript (ES modules)
- [Leaflet](https://leafletjs.com/) — the interactive map
- [html2canvas](https://html2canvas.hertzen.com/) — flat-map rasterisation for PNG/PPTX export
- [pptxgenjs](https://gitbrent.github.io/PptxGenJS/) + [JSZip](https://stuk.github.io/jszip/) — the editable PowerPoint export engine
- [Vite](https://vitejs.dev/) — dev server & single-file production build
- [Playwright](https://playwright.dev/) — automated browser tests (app boot, PPTX export)
- OpenStreetMap / Esri / CARTO tiles, Nominatim geocoding, OSRM routing

---

# 🏗️ Architecture (v5)

The app is a modular ES-module project built with Vite. `index.html` is markup
only; every behavior lives in its own single-responsibility file under `js/`
and `css/`.

```
Map-studio/
  index.html            — markup only; loads css/main.css + js/app.js
  css/
    main.css             — import order (do not reorder — later rules override earlier ones)
    themes.css            — design tokens (:root custom properties)
    style.css             — base/reset styles
    map.css                — tilt stage, billboard overlay, pins, label badges
    sidebar.css             — sidebar shell, tabs, panels, form controls
    components.css           — toolbar, search, legend/title cards, north arrow
    layout.css                — Leaflet control restyle, print stylesheet, mobile
  js/
    app.js                — entry point: assembles every module, nothing else
    constants.js           — brand asset (logo), colour palette
    config.js               — external service endpoints (OSRM routing hosts)
    core/
      state.js               — locations[], routes[], brand{}, uiState{} — the
                                 single source of truth every other module reads/writes
    map/
      mapEngine.js            — Leaflet init, basemap catalogue, hillshade, 3D tilt, fitAll
      billboard.js             — DOM pin/label overlay, screen-space projection, repaint loop
      snapping.js               — label collision avoidance
      markers.js                 — location lifecycle (create/render/rings/labels/delete)
      routes.js                   — route lifecycle (OSRM routing + fallback, via-points)
      icons.js                     — the built-in SVG icon library
    ui/
      sidebar.js               — tab switching, collapse, cursor spotlight
      toolbar.js                — click-to-add, overlay toggles, chip scale, fullscreen
      propertyPanel.js           — location/route cards, legend, brand tab
      dialogs.js                  — route right-click context menu
      notifications.js             — the status toast line
    services/
      geocoder.js               — Nominatim forward/reverse geocoding + search UI
      places.js                  — icon inference from a geocode result
    export/
      exportPPT.js + pptShapes/pptImages/pptLabels/pptTables/pptValidation/pptUtils
                                 — the standalone, tested PPTX engine (see js/export/README.md)
      pptxHandler.js             — DOM → deck-spec adapter for the Export PPTX button
      captureMap.js               — shared html2canvas rasteriser (PNG + PPTX)
      exportPNG.js, exportPDF.js   — PNG and Print/Save-as-PDF handlers
    project/
      saveProject.js            — serialise state to a downloadable .json
      openProject.js             — restore a saved .json (view/basemap/tilt/brand/locations/routes)
    utils/
      dom.js, math.js, colors.js — small pure helpers (no DOM/state coupling)
  legacy/
    map-studio-v4.9.html    — pristine single-file rollback (pre-refactor)
    map-studio-v4.96.html    — pristine single-file rollback (the version the v5 rewrite is based on)
  test/
    app-boot.mjs             — Playwright: boots the built app, exercises every
                                 subsystem (tabs, add/delete location+route, search,
                                 click-to-add, tilt, PPTX export, project load)
    ppt-export/run.mjs        — builds 5 incremental PPTX decks and audits them
    ppt-export/browser-smoke.mjs — runs the *bundled* engine inside Chromium
  docs/
    PHASE0-PPTX-DIAGNOSIS.md   — root-cause writeup of the original export corruption
    PHASE3-FEATURE-INVENTORY.md — the v4.9→v5 migration checklist
```

Mutable values that cross module boundaries (`tiltDeg`, `chipPct`, the id
counter) are never exported as raw reassignable bindings — each has a setter
(`setTiltDeg()`, `setChipPct()`, `newId()`/`bumpId()`) so every write goes
through its owning module.

---

# 🚀 Getting Started

Requires [Node.js](https://nodejs.org/) 22+.

```bash
npm install        # install dependencies (pinned versions, no "latest")
npm run dev         # start the Vite dev server (hot reload) at http://localhost:5173
npm run build         # produce dist/index.html — one self-contained file with
                        # the export engine inlined, ready to open directly or
                        # deploy to any static host
npm run preview          # serve the production build locally to sanity-check it
```

## Running the tests

```bash
npm run test:ppt     # builds & audits 5 incremental PPTX decks (unique shape
                       # ids, valid XML, python-pptx load) — Node only, no browser
npm run test:smoke     # builds the app, then runs the bundled export engine
                         # inside real Chromium (Playwright)
node test/app-boot.mjs   # boots the built app in Chromium and exercises every
                           # subsystem end-to-end (requires `npm run build` first)
```

The one check no script can perform is *"opens in desktop PowerPoint 365 with
zero repair prompts"* — that requires a human with real PowerPoint. See
`docs/PHASE0-PPTX-DIAGNOSIS.md` for how that was diagnosed and verified.

## Deploying

`npm run build` outputs `dist/index.html`, a single self-contained file
(Leaflet CSS, the export engine, pptxgenjs, and JSZip are all inlined — only
map tiles, geocoding, and routing calls go over the network at runtime). Drop
it on any static host — GitHub Pages, Netlify, Vercel, or any static web
server — or push to `main` and let `.github/workflows/deploy.yml` build and
publish it to GitHub Pages automatically (set the repo's Pages source to
"GitHub Actions"). See the **Architecture** section above for the real
project structure — `js/` and `css/` are now the source of truth.

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

## 📍 Advanced Mapping

- Aerial (Straight-Line) Distance Calculation
- Road Network Distance
- Drive Time & Travel Time Analysis
- Site Polygon Drawing
- Plot Boundary Measurement
- Land Area Calculation (Sq.ft / Sq.m / Acres / Hectares)
- Property Buffer Analysis
- Radius & Catchment Analysis
- Custom GIS Layers
- Terrain & Elevation View
- Satellite & Hybrid Maps
- 3D Building Visualization
- Parcel / Survey Number Overlay

---

## 🏢 Real Estate Intelligence

- Nearby Residential Projects
- Comparable Property Analysis
- Competitor Project Mapping
- Infrastructure Mapping
- School, Hospital & Metro Analysis
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

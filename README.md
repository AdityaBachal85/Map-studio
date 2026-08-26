# Map-studio

# 🗺️ DBOT Property Map Studio

> Professional Interactive Property Mapping Tool for Real Estate Research, Market Analysis & Presentation Generation

![Version](https://img.shields.io/badge/version-v6.0170-blue)
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

## 🆕 New in v6.0151 (latest)

### The board shows each thing once

The map tile carried the map's own floating furniture — Key Distances, the
colour key, the title card — because they are children of `#mapWrap` and the
board moves that whole element into a card. So the same five places, distances
and times printed twice on one page: once in a box over a third of the map,
once in the Key access points card beside it, both from the same
`legendRows()`. Dashboard mode hides them now, as report mode already did.

The colour key was worse than duplicated: it read **"Road / line" five times**
over five different colours, because it named routes from a label that is empty
until somebody types one. It uses the same derivation the Key Distances card
does, so the two agree. With the on-map key gone the board gets a **Legend
card** of its own — live, like Key access points.

### Export the board as a document, in four formats

The PDF was one screenshot in a wrapper: a single page, always landscape, so a
portrait board was letterboxed onto a landscape sheet with **40% of the page
blank**. No text in it could be selected, searched or copied, and nothing on it
named the project.

All four writers now read one description of the board, so they cannot drift:

- **PDF** — real text drawn with the built-in Helvetica (no font embedding, no
  library). Pictorial cards are cropped from the render; everything else is
  text. The page turns to suit the board's own shape, paginates a tall board at
  a readable size cutting between cards rather than through one, and carries a
  header and page numbers.
- **PowerPoint** — one slide per page, cards as editable shapes, tables as
  **native PowerPoint tables**.
- **Word** — headings, paragraphs and tables, read out in board order: the
  version somebody edits.
- **PNG / JPEG** — unchanged, a picture of the board.

**The map is sharp now.** The board blitted the on-screen map and scaled it up;
it goes through `captureMapHiRes()`, the same renderer the map's own export
uses, which composes the ground from real tiles at a deeper zoom.

**Empty cards are counted, not hidden.** Nothing is dropped — the status line
says how many had no data and names them. The editor prompts inside them
(*"turn on Edit board to type them"*) never print: an instruction to a reader
who has no board reads as an unfinished document.

### AI reports switched off

All three buttons opened the same panel and the backend behind it is not
working, so they are hidden — in one block, deleted to turn it back on. Nothing
is removed, so boot is untouched.

---

## 🆕 Earlier in v6 (6.0147)

### Add a location by pasting DMS coordinates

The search bar's coordinate paste and a location card's coordinate field
used to accept only `19.37697, 73.16956`. They now also read
`19°22'37.1"N 73°10'10.4"E` — what a phone's GPS app or Google Earth
actually hands you — straight or curly minute/second marks and either
hemisphere-letter case included.

One rule makes this safe rather than merely convenient: text carrying a
degree mark is routed *exclusively* to the DMS parser and never touches the
old decimal path. `parseFloat` stops at the first character it cannot read
instead of failing, so a comma-joined DMS pair fed to the decimal path would
have silently truncated to degrees-only — a coordinate several kilometres
from the one pasted in, with no error raised. The DMS form also requires a
hemisphere letter on both halves, which is what removes every ambiguity
(which half is lat, which is lng, and the sign of each) in one move; text
with a degree mark but no hemisphere letters is refused rather than guessed
at, the same posture the bulk sheet importer already takes for the identical
reason.

### The blank satellite tiles, diagnosed

A report of the map going blank at deep zoom — Esri's "Map data not yet
available" placeholder, tiled edge to edge — turned out not to be a bug: the
app already has a mechanism (`attachAdaptiveDepth`) that steps the satellite
layer's zoom back when it detects that exact placeholder, and the console
confirmed it was doing so correctly. What it lacked was any way to say so
*on screen*. When the probe backs all the way down to its floor and a spot
genuinely has no deeper Esri coverage, it now says as much in the status
line instead of leaving only a `console.warn` nobody but a developer would
ever see.

## 🆕 Earlier in v6 (6.0146)

### An interactive dot field behind the sign-in card

A grid of dots across the whole window that bulges away from the pointer as it
moves, with a soft pool of light following it. Ported to plain JavaScript from
a React component — this app has no build step, and the mechanics are a canvas,
a `requestAnimationFrame` loop and a radial gradient, none of which needed React
to begin with.

Three things make it cheap enough to leave running on a page people sit and type
into: every dot goes into **one path and one fill**, so several thousand dots
cost a single draw call; it reacts to the pointer's **speed** rather than its
position, so a still cursor lets the whole field settle and the loop go quiet;
and it stops entirely when the tab is hidden. Under **Reduce Motion it is never
built at all**.

Its colours are this page's rather than the component's — brand orange running
to the map scene's blue across the diagonal, at roughly twice the size and alpha
the original uses, because a 1.5px dot at 35% alpha on a near-black page is
mostly antialiasing and reads as nothing.

---

## 🆕 Earlier in v6 (6.0142)

### The sign-in page, rebuilt as one dark split card

Form on the left, the photograph on the right, on a dark ground — with the
three pointer effects from the reference design: a soft glow that follows the
cursor across the form, a bright point that runs along a field's top and bottom
edges as you move over it, and a highlight that sweeps across a button once on
hover.

All of it is **decoration and only decoration** — built at runtime by
`js/auth/loginFx.js`, marked `aria-hidden`, inert to the pointer, and the form
works identically with every one of those elements deleted. A diagnostic asserts
that by ripping them out and using the form.

---

## 🆕 Earlier in v6 (6.0136)

### Several contour maps on one project

Drawing a second study area used to silently replace the first. Now each one is
its own contour map with its own area, interval, colours and detail — listed in
the Draw tab, selectable, hideable one at a time, and all drawn together.

**Clear names them.** Instead of one button that silently meant "all of them",
it opens a menu listing each map and what it holds, with *All contour maps* set
apart at the bottom. Every delete is reversible from the status line.

### A new project no longer inherits the old one

"New project" writes an empty document, and every field applied as
`if (project.has(x))` with no *else* was quietly keeping the previous project's
value. Reported as a brand new map still carrying the old one's title — and the
same bug sat under both legend card titles, the terrain shading, the project
logo and the imagery grading. **A field a project does not carry now means the
default**, not whatever happened to be there before.

---

## 🆕 Earlier in v6 (6.0131)

### A 2D / 3D switch on the map — the whole map, on real terrain

A segmented **2D / 3D** control sits in the right-hand stack. Press 3D and the
map you are looking at tilts back onto a real terrain mesh: hills stand up,
valleys cut in, and you can orbit around them. Press 2D and it flattens again,
leaving you where you were looking rather than where the flat map was last
parked.

It works with **every ground** — satellite, streets, OSM and the vector
basemap — and with nothing on the map at all. It is a way of looking at the
map, not a feature of the contour tool it started life in.

**Everything on the map comes with you.** Pins, their labels and the leader
lines between them; routes, rings, drawn shapes, measurements and boundaries;
the Key Distances card, the Legend, the Elevation scale and the title card. The
north arrow stays and *turns* with the camera, with a compass button beside the
switch to put it back. The scale bar is the one thing that goes: a single scale
is a lie on a tilted view, because the ground at the top of the frame is much
further away than the ground at the bottom.

Exports capture the tilted view exactly as aimed, with all the furniture on it.

See **[docs/3D-MAP.md](docs/3D-MAP.md)**.

### Clearing a contour map now clears the contours

"To shapes" made ordinary geometries that nothing could tell apart from lines
drawn by hand, so **Clear** left every converted contour behind with a sidebar
card each. They are tagged now, Clear removes them, hand-drawn shapes are
untouched, and Undo puts them back.

That surfaced an older bug of the same shape: undoing a delete was dropping the
shape's connectivity class, so it came back looking right and belonging to no
class — falling silently out of the colour key.

### The 3D contour drape is sharp

It was rendered at the elevation grid's resolution and then magnified by the
camera. The grid is the resolution of the *data*, not of the picture.

---

## 🆕 Earlier in v6 (6.0119)

### Contour maps — the shape of the ground, from real elevation data

Pick an area on the map and the app reads a digital elevation model for it,
traces contour lines at whatever interval you choose, tints the ground by
height, and puts a legend beside it. The whole thing then exports at 2×, 3× or
4× like everything else on the map, and can be tilted into a real 3D relief
view.

**The data.** Elevation comes from the AWS Open Data *Terrain Tiles* set in
Mapzen's terrarium encoding — free, no API key, CORS-open, global. Under India
that is largely SRTM: roughly **30 m between real samples**, with tiles down to
zoom 15 (about 4.5 m per pixel at Mumbai's latitude). The panel says so, and
says which resolution it actually achieved for the area you picked. A 5 m
contour interval off this is a good picture of the shape of the ground and is
not a survey, and nothing in the interface pretends otherwise.

**The controls**, all in the Draw tab:

| Control | What it does |
|---|---|
| **Area** | Rectangle, polygon or circle drawn on the map — or "Use current view". Reports its size in km². |
| **Every** | Contour interval, 1 m to 500 m, or 5 ft to 2000 ft. |
| **Colours** | Five hypsometric ramps: Rainbow, Terrain, Viridis, Greyscale and a DBOT brand ramp. |
| **Bold** | Index contours drawn heavier — every line, 2nd, 5th, 10th, or none. |
| **Labels** | Heights along the contours, on the bold ones or on all of them. |
| **Smoothing** | Rounds off the staircase a sampled grid leaves behind. |
| **Detail** | How finely the elevation is read, capped by what the source actually has. |
| **Roads** | Roads, water and buildings from **OpenStreetMap**, drawn over the tint as real geometry. |
| **Fill** | How strongly the elevation colours cover the basemap. |
| **Relief shading** | Hillshade computed from *this* DEM, so it agrees with the contours exactly. |
| **3D relief view** | A real terrain mesh with the contour map draped over it — drag to orbit, with a vertical exaggeration slider. |
| **To shapes** | Converts the contours into ordinary editable shapes: cards, styling, undo, GeoJSON export. |

**The legend is banded, and the bands are exact.** One labelled block per
contour band, high ground at the top. Every block's colour is read from the
same lookup table the map itself was painted from — the diagnostic checks each
band against the actual pixel the fill painted at that height — and every band
edge is a contour that is really drawn. When the interval is too fine to list,
the card widens its step to a *multiple* of the interval and says so, so the
card never describes a different map from the one beside it.

**Where the work happens.** `js/services/elevation.js` fetches and decodes the
DEM; `js/map/contourGen.js` is pure arithmetic — marching squares, Chaikin
smoothing, Douglas–Peucker, hillshade, hypsometric fill — and is tested in Node
with no browser at all; `js/map/contourLayer.js` draws it; `js/map/contour3d.js`
is the oblique view; `js/services/osmDetail.js` fetches the road detail through
the Overpass client `ringFeatures.js` already sets up.

---

## 🆕 Earlier in v6 (6.0091)

### A vector basemap — the ground can finally be told what not to draw

Every basemap in this app has been **raster**: the browser receives a picture,
not features. A picture cannot be asked to leave something out, which is why
removing OpenStreetMap's red hospital and pharmacy crosses needed
`js/map/tileScrub.js` — a pixel scrubber that masks the healthcare red out of
each tile and inpaints the hole from the surrounding colour.

**Streets — vector** renders [OpenFreeMap](https://openfreemap.org/)'s style in
the browser with [MapLibre GL](https://maplibre.org/), mounted as a canvas
*under* Leaflet's panes. Leaflet keeps the DOM, the projection, the interaction
model and every route, shape, marker and ring the app draws; MapLibre only
paints the ground and is told where to look.

Because the browser now holds the features and the styling, the basemap panel
grows a **Hide from this ground** section built from the layers the loaded style
actually has — places and POI symbols, place names, road names, roads,
buildings, land use, water, rail and transit, boundaries. Each toggle is a
filter applied instantly and exactly, with no pixels touched.

The one that matters most is a pair: **Hospitals & clinics** and **Pharmacies**
are *separate* switches. On raster OpenStreetMap they are the same shade of red,
so a scrubber removing one removes both; here they are different values of one
attribute. Hiding the chemists while the hospitals keep drawing is the thing
this whole feature was built for.

Settings survive a reload and travel inside a saved project, so a map reopens
showing exactly what it was composed with. Exports go through the same style:
the PNG/PDF/PPTX ground is rendered off its own GL canvas at the export's pixel
ratio, carrying whatever was switched off.

**Where to find it:** the basemap picker, under **Streets**, in the **Satellite**
layout. Connectivity stays pinned to raster OpenStreetMap so the client-facing
standard cannot change under anyone.

OpenFreeMap publishes no SLA — it is donation-funded and community-run — but the
engine already handles a ground that will not draw: it falls back to a working
basemap and says why, and a basemap is only remembered once it has actually
rendered, so an outage costs one status line rather than the next session.

**Known limitation, stated plainly:** this was built in a sandbox where
`tiles.openfreemap.org` is unreachable, so nobody has watched OpenFreeMap's own
cartography draw. The renderer, the mount, the view sync, the filters, the
exports and the project round-trip are all verified against a local style
fixture (`diagnostics/vector-basemap/`, 47 assertions). Whether OpenFreeMap's
real layer names group usefully, and whether its POI data uses the class values
assumed here, needs a machine with network. Both fail harmlessly — an unmatched
group is not offered, an unmatched filter hides nothing. See
`docs/OPENFREEMAP-VECTOR-BASEMAP.md`.

---

## 🆕 Earlier in v6 (6.0028 → 6.0090)

A run of work that landed between the AI Reports release below and the vector
ground above.

### One colour standard for connectivity maps

Route colours used to come from a rotating palette keyed on how many routes
happened to exist, so the same road was a different colour in every report.
`js/map/connectivityStandard.js` is now one table: a route or shape carries a
class, and the class decides colour, weight and dash. Change it there and every
map changes with it. The palette is derived from the DBOT logo. The legend is
generated from the classes actually in use, so the key cannot contradict the
drawing.

### Two layouts

**Connectivity** (OpenStreetMap ground, standard colours, basemap pinned) and
**Satellite** (imagery ground, free colour choice). The ground is remembered
*per layout*, because one setting cannot express two layouts that want
different grounds by design.

### Ring scan — ask the map what is inside a catchment

Draw a distance ring, press **⊙ Scan**, and OpenStreetMap is queried for what
falls inside it: metro, rail, water, airports, roads, power lines, land cover,
buildings and settlements. Results are listed with counts and lengths, and
**nothing lands on the map unasked** — you tick what to keep, and what lands is
an ordinary shape you can restyle, rename, hide or delete.

OSM returns roads in fragments rather than as whole named routes, so the scan
chains them end to end, grouped by class rather than by name — the unnamed
connector between two named stretches has to be able to join either.

### The red medical symbols, on raster OSM

`js/map/tileScrub.js` cleans OSM Carto's healthcare red out of the tile pixels
and inpaints the holes from surrounding colour, so an icon over a beige building
leaves beige rather than a white hole. Kept below a ~300 m scale, where a wall
of crosses across a locality is clutter; past that they come back on their own.
The export applies the same treatment at the same apparent scale.

### An editable legend

A LEGEND card on the map, generated from the classes in use, with per-row label
and colour editing, hiding, reordering and custom added rows. The Key Distances
card got the same treatment. Both drag from their whole header.

### Identify, overlays, pins

Click anything to see what OpenStreetMap knows about it, with the most specific
feature winning. Transparent overlay layers (place names, roads, railways,
hillshade) can be added over a plain ground. Location pins are Google-Maps-style
teardrops: coloured body, white keyline, white symbol — and one location's icon
style can be pushed to all of them.

---

## 🆕 New in v6.0027

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

### Deleting a location is no longer permanent

Removing a pin silently took every route running to or from it, each of which
cost a routing request and whatever manual work went into its colour, label
and via points. There was no confirmation and no way back — one misclick on
the × could undo an hour.

Now the delete offers **Undo** in the status line, and taking it puts the
location and all its routes back exactly as they were, geometry included, so
nothing is re-routed and nothing is re-numbered. Route cards have the same
undo on their own ×. An undo rather than an "are you sure?" is deliberate: a
confirmation interrupts every delete, including the ones you meant, and
people learn to dismiss it without reading.

### Eyedropper: match a colour to what's already on the map

Every colour control in the app opens the in-app picker, and its custom mode
now has an **eyedropper** — click it, then click anywhere on screen, and the
colour under the cursor becomes the pin, route, ring or label colour.

Picking a colour for a map is a judgement about what is already on the map:
this pin has to read against that road, that roof, that water. Matching that
by nudging RGB fields is guesswork. The picker hides itself while you sample,
so the part of the map it was covering is reachable too. Chromium-only for
now (the eyedropper is a browser API); the button simply isn't drawn in
browsers that don't have it.

**And it really is every colour now.** The rule that hid the browser's own
colour control behind the app's swatch only matched the pin and route
colours, so the label background, ring, icon border, icon fill, geometry and
measurement swatches were still live native controls sitting under the
styled button — covered by nothing but the two boxes lining up exactly, and
any layout that shifted one by a pixel put the operating system's colour
dialog back in front of you. All of them are now inert.

### Checkboxes match the app

`accent-color` only colours a checkbox once it is ticked; an unticked one was
still drawn by the operating system — a white box with a grey hairline —
which on the dark frosted sidebar read as a chip of system UI dropped into
the middle of the app. Every other control here is drawn by the app, so these
are too, in both light and dark.

### The colour picker is now usable without a mouse — and with a finger

A design pass over the picker turned up things that looked finished and
weren't:

- **The hue bar was pointer-only.** The square could reach every shade of one
  hue and nothing could change which hue that was, so the whole picker was
  unusable from the keyboard. Arrow keys now move it, Shift for bigger steps,
  Home/End for the ends of the wheel.
- **Focus went nowhere sensible.** The popover is appended to the end of the
  page, so opening it with the keyboard left focus on the swatch and the next
  Tab jumped past the entire document. It now opens focused on the preset you
  already have selected, moves to the square when you enter custom mode, and
  hands focus back to the swatch when you close it.
- **Nothing had a focus ring.** Swatches, presets and the hue bar all draw one
  now, offset so it isn't mistaken for part of the colour.
- **Presets announced as "hash E zero three one three one".** They're named —
  Red, Light blue, Dark grey — and the swatch on a card says what it's set to
  rather than being one of nine identical "colour" buttons.
- **The status line wasn't a live region**, so a screen reader never mentioned
  that a location had been deleted, let alone that Undo was sitting there for
  twelve seconds. It is one now.
- **Everything in the picker was mouse-sized on touch.** 27px preset cells 6px
  apart and a 13px hue bar are a coin-toss with a fingertip. On a touch device
  the popover widens to six ~44px columns, the hue bar doubles in height, and
  the fields grow to match — the desktop layout is untouched.

### The report is now a real document

The AI report went from four prose sections to a structured deliverable:
a **cover page**, a computed **Scorecard**, an Executive Summary broken into
overview / key findings / opportunities / risks, four researched sections, five
interpretation sections (SWOT, Risk, Investment, Timeline, Key Insights), a
**Travel Time Matrix**, sources, and an appendix carrying the measured inputs
so every figure above can be checked.

**The Scorecard is computed, never asked for.** Ask a model to "score
connectivity out of 100" and it returns a confident number with no basis — and
a number is the worst thing to invent, because numbers get quoted long after
the prose around them is forgotten. Every score here is arithmetic over
measured inputs and prints the working beside it:

| Metric | Score | Basis |
|---|---|---|
| Connectivity | 70 | airport 45 min off-peak / 66 at 9am · station 0.6 km · moderate peak congestion (+47%) |
| Infrastructure | 94 | within 5 km: 20 restaurants, 12 schools, 11 pharmacies, 9 stations |
| Market Demand | — | no free data source publishes Indian locality-level demand |
| Safety | — | no crime statistics exist per locality |

Metrics with no data source show an em dash and the reason. There is no
estimate mode.

**The Travel Time Matrix** is the other measured piece. Places finds the real
nearest airport, station and business district for *this* site, then Routes
measures the drive — with and without traffic, so the table reads "45 min
off-peak, 66 at 9am" rather than the free-flow figure a brochure would quote.
Getting the destinations right mattered: ranking by distance returned "unicare
car tarasport" as the major hospital, so prominence ranking is used everywhere
the nearest one isn't the one you'd actually use.

Interpretation sections are **labelled as such** in both PDF and Word.
"Here is what the sources say" and "here is what we make of it" are different
claims, and a reader deciding on a property shouldn't have to infer which is
which.

### Google requests: fewer of them, for the same result

Two places where one action was buying two answers from Google.

**Answers now survive a reload.** The caches that make a chip toggle or a
radius drag free only lived in the tab. Refreshing the page, or reopening a
project tomorrow, re-bought every category at full price — and the answers
had not changed, because the schools around a plot are the same schools they
were this morning. They are now mirrored to `localStorage` with a 7-day life
(inside Google's 30-day caching terms) and read back on boot. Measured: four
categories cost **4 requests cold, then 0 after a full reload**, and
narrowing the radius across that reload stays free too.

**The search buttons ignored predictions you had already paid for.** Pressing
Enter on a suggestion resolved it properly, but the arrow button and the
magnifier both threw the suggestions away and ran a fresh Text Search for the
same string — a second, separately billed request for a question already
answered. All three submit paths now behave the same way.

What was *already* efficient and stayed that way: typing is debounced to one
prediction request per pause, toggling a category off and back on costs
nothing, and shrinking the radius is served by narrowing the wider answer
already held rather than asking again.

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
  [pptxgenjs](https://gitbrent.github.io/PptxGenJS/), [JSZip](https://stuk.github.io/jszip/),
  [anime.js](https://animejs.com/), [supabase-js](https://supabase.com/)
  — vendored directly under `vendor/`, loaded as plain `<script>` tags
- [MapLibre GL JS](https://maplibre.org/) (BSD-3-Clause) for the optional vector
  ground — also vendored, but fetched on first use rather than on every page
  load, since it is 803 KB for a ground most sessions never select
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
  login.html      — sign-in. Names the person using this browser; see the note
                      below on what that does and does not mean.
  projects.html   — the projects list: everything saved on this device, with
                      new / open / rename / copy / download / delete
  vendor/fonts/   — Geist + Geist Mono variable woff2 + OFL licence
  vendor/         — third-party libraries, vendored as plain files (leaflet.js/.css,
                       leaflet-geoman.js/.css, html2canvas.js, pptxgen.bundle.js,
                       jszip.js, anime.min.js, supabase.js, maplibre-gl.js/.css)
  css/
    shell.css       — login.html + projects.html only (the pages outside the map)
    dashboard.css   — the board view
    themes.css, style.css, map.css, sidebar.css, components.css, layout.css,
      refine.css    — linked individually from index.html, in that order. Do not
                        reorder: later sheets override earlier ones and refine
                        must stay last. Linked directly rather than via an
                        @import list so the release's ?v= bump reaches every
                        sheet — an @import needs its own, and a stale one serves
                        cached CSS while the markup updates around it.
                      themes.css is the ONLY place CSS custom properties are
                        defined. An undefined one resolves to nothing, silently.
  js/
    app.js          — runs last: wires everything together, prints the boot message
    constants.js    — APP_VERSION lives here; tools/stamp-assets.js reads it
    config.js       — ROUTERS, provider API keys, Supabase URL + anon key
    auth/session.js  — who is using this browser. Degrades to a local profile
                         when Supabase is not configured; the rest of the app
                         cannot tell which mode is running.
    auth/loginFx.js  — login.html's pointer decoration, built at runtime so the
                         page's markup stays about authentication
    projects/       — projectStore (many named projects in IndexedDB, metadata
                        split from payload so the list stays fast), projectsPage
                        (drives projects.html), projectBridge (loads the opened
                        project into the studio and writes it back), cloudProjects
    core/           — state.js (locations[], routes[], brand{}, uiState{} — the
                        single source of truth), prefs.js (localStorage settings),
                        freshness.js
    map/            — mapEngine (Leaflet map, basemap switching, HD, tilt),
                        basemapProviders (the basemap catalogue — pure data),
                        connectivityStandard (class → colour/weight/dash),
                        layouts (Connectivity vs Satellite), tileScrub (the
                        medical-red pixel cleaner for raster OSM), vectorBasemap
                        (the MapLibre ground + its style filters), mapOverlays,
                        billboard (pin/label overlay), markers, routes, roadDraw,
                        drawing (shape tools + undo/redo), snapping, icons,
                        fillPatterns, textLabels, aerialDistance, markerCluster,
                        imageryEnhance, googleTiles, customBasemaps, providerKeys,
                        nearby, contourRamps + contourGen + contourLayer +
                        contourMap (the contour map: ramp table, pure maths,
                        renderer and state), map3d + map3dContent (the 3D map
                        mode and the map's own geometry inside it)
    ui/             — map3dControls (the 2D/3D switch and the compass),
                        sidebar, toolbar, propertyPanel, geometryPanel (shape cards),
                        colorKey (the editable LEGEND card), legendTable (Key
                        Distances), basemapSwitcher, ringScanPanel, layerManager,
                        settingsDialog, exportCenter, importDialog, iconPicker,
                        colorPresets, searchBox, dialogs, notifications, aiTab,
                        reportSheet, dash* (the board view), dotField (the
                        interactive dot background; login.html only)
    export/         — hiResRender (the sharp map), dashExportModel (what the
                        board IS, DOM-free — read by all four writers),
                        pdfWriter + dashPdf, dashPptx, dashDocx, exportPPT*
    services/       — elevation (the DEM behind the contour map), osmDetail
                        (roads/water/buildings over it, through the Overpass
                        client ringFeatures sets up),
                        geocoder (search box), geoapify, google (Places + Routes),
                        nearbyPlaces, boundaries, ringFeatures (the Overpass ring
                        scan + the way-joining that turns road fragments into
                        whole routes), mapIdentify, aiReports, placeCache, places
    export/         — the PPTX engine (exportPPT + pptShapes/pptImages/pptLabels/
                        pptTables/pptValidation/pptUtils) + pptxHandler,
                        hiResRender (the supersampled ground/vector/furniture
                        compositor behind PNG and PDF), captureMap, exportPNG,
                        exportPDF, dashExport
    project/        — saveProject, openProject, projectState (serialise/apply),
                        autosave, history (undo/redo), geojson, kml, importSheet,
                        importFiles, xlsx
    utils/          — dom, math (geodesic length/area), color, colors, animate
  tools/            — stamp-assets.js (version bump + ?v= stamping),
                        build-single-file.js (legacy/ snapshots)
  diagnostics/      — standalone probe pages and check harnesses, incl.
                        vector-basemap/ (Playwright checks for the MapLibre ground)
  legacy/           — pristine single-file rollbacks of earlier versions
  server/, sql/     — the optional accounts/cloud backend (Supabase schema + RLS)
  docs/             — OPENFREEMAP-VECTOR-BASEMAP.md (the vector ground: spec,
                        what shipped, and where the spec was wrong),
                        PHASE0-PPTX-DIAGNOSIS.md (the export-corruption root
                        cause), CONTOUR-MAPS.md (elevation source, the
                        contour pipeline, and what its accuracy is and is not),
                        3D-MAP.md (the terrain mode, what travels into it and
                        what does not),
                        ACCOUNTS-SETUP.md, AI-REPORTS-SETUP.md,
                        DEPLOY-NOTES.md, PHASE3-FEATURE-INVENTORY.md,
                        PHASE5-PRODUCTION-POLISH.md, SESSION-HANDOFF-6.0090.md
```

Every file in `js/` is a plain script — no `import`/`export`. `index.html`
loads them in the exact order each one needs its dependencies to already
exist; don't reorder those `<script>` tags. The order is load-bearing in at
least two places: `mapEngine.js` builds its first tile layers *during parse*, so
`tileScrub.js` and `vectorBasemap.js` must both be above it.

## Versioning — run this after every edit

Every asset URL carries `?v=<APP_VERSION>`, so a deploy is all-or-nothing rather
than leaving a returning browser running some new files against some old ones.
After touching any `.js` or `.css`:

```bash
node tools/stamp-assets.js --bump      # 6.0091 → 6.0092, then re-stamp
node tools/stamp-assets.js --check     # exits 1 if anything is stale
node tools/build-single-file.js        # optional: a legacy/ snapshot
```

Skipping this ships a half-updated app, which fails in stranger ways than being
simply out of date.

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

This repo deploys from **`Map-Studio_V6`**, not `main`.

> ⚠️ **Renaming that branch unpublishes the site.** Pages points at a branch by
> name, so a rename leaves it pointing at a branch that no longer exists and the
> site goes dark until you re-select the new name here and press Save. The
> commits are fine — only the Pages setting needs pointing again.

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

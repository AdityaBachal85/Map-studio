# PPTX Export Engine

A standalone, modular replacement for the v4.9 in-HTML PowerPoint exporter. It
produces `.pptx` files in which the map is a background image and **everything
else is a native, editable PowerPoint object** — leader lines, icon pins,
labels, badges, ring chips, the title card, the legend table, and the logo.

## Why it was rewritten

The v4.9 exporter produced files PowerPoint 365 refused to open (repair dialog),
even though the ZIP and every XML part were valid. Root cause (see
`../../docs/PHASE0-PPTX-DIAGNOSIS.md`): **pptxgenjs emits two shapes with the
same `<p:cNvPr id="2">`** on any slide that has both an image and a table — the
background map and the legend table always collide. Duplicate `cNvPr` ids are
schema-well-formed but rejected by PowerPoint. This is unfixed in the current
stable **pptxgenjs 4.0.1**, so the engine repairs it itself.

## Modules

| File | Responsibility |
|---|---|
| `exportPPT.js` | Orchestrator — turns a deck spec into a repaired `.pptx`. `buildDeck()` / `exportDeck()`. |
| `pptUtils.js` | Pure helpers: colour/contrast, letterbox fit, px→inch transforms, logger. |
| `pptValidation.js` | Per-object validators + `ensureUniqueShapeIds()` (the id-repair pass) + `auditShapeIds()`. |
| `pptShapes.js` | Native vector shapes: leader lines, icon frames, title underline. |
| `pptImages.js` | Background map, icon pins (frame + glyph), logo. |
| `pptLabels.js` | Editable text chips: location/route labels, badges, rings, title. |
| `pptTables.js` | The "KEY DISTANCES" legend as a native table. |

## The one deliberate exception to "no ZIP post-processing"

`ensureUniqueShapeIds()` reopens the finished package and renumbers each slide's
`cNvPr` ids to a unique sequence (the spTree group stays `id=1`). No other bytes
are touched. This is the minimal, targeted fix for the duplicate-id defect that
pptxgenjs offers no API to prevent. It is the *only* post-processing performed.

## Deck spec (input contract)

```js
{
  fileName: 'property-access-map.pptx',
  author: 'DBOT · Property Map Studio',
  geometry: { wrapW, wrapH, chipFont, slideW?, slideH? }, // slide defaults 13.333×7.5
  slide: {
    background: '0A1E3C',
    map:  { data: '<png data-url>' },                      // optional; letterboxed to fit
    leaders: [{ a:{x,y}, b:{x,y}, color }],                // px in map/wrap space
    pins:    [{ px:{x,y}, size, frame, bg, border, borderColor, iconData, isImage }],
    locationLabels: [{ px:{x,y}, text, site, bg }],
    routeLabels:    [{ px:{x,y}, text, bg }],
    badges:  [{ px:{x,y}, text, color }],
    rings:   [{ px:{x,y}, text, color }],
    title:   { visible, text },
    legend:  { visible, title, pxLeft, pxTop, pxWidth, rows:[{color,name,km,min}] },
    logo:    { visible, data, aspect }
  }
}
```

`frame` is one of `none | circle | rounded | square`. All px coordinates are in
the source map's pixel space; the engine applies the letterbox transform.

## Text measurement

Chip widths mirror the v4.9 canvas-measured sizing. Pass a `measurePx(text,
pxSize, bold)` callback via `exportDeck(spec, { measurePx })`; in the browser use
a `CanvasRenderingContext2D.measureText`-based function, otherwise an Arial
heuristic is used.

## Running the tests

```bash
npm install
npm run test:ppt      # builds test/ppt-export/fixtures/{1-text..5-full}.pptx
```

The harness builds the five incremental decks (text → shapes → images → tables →
full) and runs every headless check available: unique-id audit, JSZip
round-trip, and skipped-object log. **The final check — "opens in real
PowerPoint 365 with zero repair prompts" — must be done by a human**; the
fixtures exist so that test is one double-click away.

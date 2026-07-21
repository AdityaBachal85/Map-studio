# Phase 0 — PPTX Corruption Diagnosis

**Target:** DBOT Map Studio `index.html` (v4.9), PPTX export path (`#pptxBtn` handler, ~lines 3205–3422).
**Export library in use:** `pptxgenjs` **3.12.0** (loaded from CDN, `index.html:1761`).
**Symptom:** PowerPoint 365 desktop shows the *repair* dialog on open, even though the ZIP is
structurally valid and every XML part is well-formed.

---

## TL;DR — Primary defect

> **Two shapes on the slide are emitted with the same `<p:cNvPr id="2">`:**
> the **background map image** (`name="Image 0"`) and the **legend table** (`name="Table 0"`).

`cNvPr/@id` must be **unique within a slide's shape tree**. A duplicate is *not* a
well-formedness error, so `xmllint` and `python-pptx` both accept the file — but PowerPoint's
stricter loader rejects it and offers to "repair" the presentation. This is exactly the class of
bug described in the brief: passes every automated check, fails the one check that matters.

The collision is **deterministic** and fires on essentially every real export, because the DBOT
slide always contains both a background image *and* a legend table.

### Root cause (in the library)

`pptxgenjs` 3.12.0 assigns ids inconsistently:

| Object kind | id formula (`pptxgen.cjs.js`) | Value for the DBOT slide |
|---|---|---|
| Images / shapes / text | `idx + 2` (lines 5400, 5521, 5632) | background image is `idx=0` → **id = 2** |
| Table (graphicFrame) | `intTableNum * slide._slideNum + 1` (line **5170**) | first table, slide 1 → `1*1+1` = **id = 2** |

The table id formula ignores how many other shapes exist on the slide, so the first table on
slide 1 always claims `id=2` — the same id the first image already took.

---

## How this was reproduced (no browser / no map tiles needed)

The PPTX bytes are produced by `pptxgenjs`; the browser/Leaflet layer only decides *what* objects
get added. So the exact `addImage` / `addShape` / `addText` / `addTable` call sequence from the
export handler was replayed in Node against the **same pptxgenjs 3.12.0**, with representative data
plus the edge cases the brief calls out (special chars `& < >`, SVG-dataURL icons, axis-aligned
leader lines, the 4-column legend table).

```
diagnostics/pptx-repro/repro.cjs     # replays the app's exact pptxgenjs calls → repro-v49.pptx
diagnostics/pptx-repro/inspect.py   # unzips + walks slide1.xml for the defect classes below
```

Run:

```bash
cd diagnostics/pptx-repro
npm init -y && npm install pptxgenjs@3.12.0
node repro.cjs
mkdir -p unz && (cd unz && unzip -q ../repro-v49.pptx)
python3 inspect.py
```

Observed output (abridged):

```
=== p:cNvPr ids/names ===
  id=2    name=Image 0        <-- background map image
  ...
  id=2    name=Table 0        <-- legend table   *** COLLISION ***
TOTAL: 23  DUPLICATE ids: ['2']
```

---

## Full checklist from the brief

| # | Check | Result |
|---|---|---|
| 1 | Duplicate/missing `r:id` in `.rels` | **OK** — `slide1.xml.rels` is `rId1…rId11`, sequential, no gaps/dupes |
| 2 | Missing/duplicate `[Content_Types].xml` entries | **OK** — `png/jpeg/svg/...` defaults + all part overrides present, no dupes |
| 3 | **Duplicate shape `id` on a slide** | **DEFECT (primary)** — `id="2"` on both background image and legend table |
| 4 | Coords `NaN` / negative / EMU-overflow | No NaN/negative/overflow. **Two zero-extent line shapes** (see secondary finding) |
| 5 | Table `<a:gridCol>` widths sum to table width | **OK** — `146304+1222187+566928+502920 = 2438339 = graphicFrame cx` exactly |
| 6 | Unescaped `& < >` in text runs | **OK** — emitted as `&amp; &lt; &gt; &apos;` |
| 7 | Image parts missing / wrong content-type | **OK** — all media present & valid; SVG icons use the correct **PNG-fallback blip + `<asvg:svgBlip>` extension** |

### Secondary finding (defensive, not proven to trigger repair)

Perfectly horizontal or vertical leader lines are emitted as `line` shapes with a **zero-extent
axis** — `ext=(2031949, 0)` and `ext=(0, 1422364)`. PowerPoint generally tolerates axis-aligned
lines, and real leader lines are almost never pixel-perfectly aligned, so this is unlikely to be
the repair trigger on its own. It is still a latent risk and the rewritten engine's
`pptValidation.js` should reject or normalize any shape whose area is zero (give lines a 1px
minimum extent, or draw them as connectors).

---

## Implications for Phase 1 (the rewrite)

1. **Guarantee globally-unique `cNvPr` ids** across *all* object kinds on a slide — never trust the
   library to number tables and images from the same counter. Whatever engine is used, verify the
   emitted ids are unique before the deck is written (this is a `pptValidation.js` responsibility).
2. **Validate geometry before adding**: reject/normalize `NaN`, negative, zero-area, and
   out-of-EMU-bounds coordinates; ensure table `gridCol` widths sum to the frame width.
3. Confirm the current stable `pptxgenjs` version (do **not** assume 3.12.0) — this specific id bug
   must be re-verified as fixed, or worked around, on whatever version is pinned.
4. Keep everything native/editable (text, shapes, icons, table, title, legend) — the current export
   already does this correctly; only the id assignment is broken.

---

## Addendum — second repair vector found via the v4.96 source

After Phase 1, the user supplied the real current app (**v4.96**, adopted as the
source of truth). Its export code carries three hardening helpers absent from
v4.9 — `svgToPngDataUri`, `iconAsRaster`, `safeRadius` — one of which documents a
**second, independent PowerPoint-repair cause**:

> A roundRect `rectRadius` larger than half the shape's shorter side makes
> pptxgenjs emit `adj = rectRadius / min(w,h) × 100000 > 50000`. PowerPoint 365
> rejects `adj > 50000` (repair / "can't read content") even though python-pptx
> and LibreOffice accept it.

Verified against the new engine: small label pills with `rectRadius: 0.5`
produced adjustments up to **236848**. The engine now clamps every roundRect
via `pptUtils.safeRectRadius()` (≤ 0.49·min(w,h) → adj ≤ 49000), applied in
`pptLabels`, `pptShapes`, and `pptImages`. The v4.96 SVG-rasterisation helpers
are unnecessary in the new engine because pptxgenjs already embeds SVG icons
with a valid PNG-fallback blip + `<asvg:svgBlip>` (Phase 0, check #7).

**Two confirmed repair vectors, both now handled:** (1) duplicate `cNvPr` id →
`ensureUniqueShapeIds`; (2) roundRect adj > 50000 → `safeRectRadius`.

**Status:** Phase 0 complete.

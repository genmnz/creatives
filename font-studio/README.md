# Melad Font Studio

A browser font editor. Open a TTF, OTF, TTC, WOFF or WOFF2 (or start a new font), edit it, and
save a validated TTF, WOFF or WOFF2. Nothing is uploaded: fonts stay in your browser.

**Quickest way to use it:** open `melad-font-studio.html` (one self-contained file) in Chrome,
Edge, Firefox or Safari. No install, no server, works offline.

## What you can edit

| Area | What |
|---|---|
| Outlines | Move, add (double-click an outline), delete and nudge points; toggle on/off-curve; pen, rectangle and ellipse tools; reverse or correct contour direction; set the start point; round; flip, scale, rotate, slant and change weight (point-preserving), on a selection or the whole glyph |
| Composites | Drag components, edit offset and scale, add or remove components, decompose |
| Metrics | Advance width, left and right side bearings, centring; anchors move along with the outline when wanted |
| Every form of a character | The Forms tab follows the font's GSUB rules and also shapes the character with HarfBuzz as isolated, initial, medial and final, or inside any context you type, and lists every alternate, ligature and stylistic form. Click any form to edit that exact glyph |
| Anchors | Mark, base, ligature, mark-to-mark and cursive entry/exit anchors: drag them in the canvas or type values. An anchor shared with other glyphs gets its own copy, so edits stay on this glyph |
| Kerning and positioning | Pair kerning, class kerning and contextual adjustments that involve the glyph, edited in place (shared class values say how many pairs they affect) |
| Glyph set | Add glyphs, duplicate a glyph as an alternate, rename, change the characters that type a glyph |
| Font | All name records, vertical metrics (hhea, typo, win, x-height, cap height), weight and width class, embedding, style flags, vendor, revision, italic angle, underline |
| Batch | Scale, move, weight, advance and bearing changes, rounding, decomposing, direction fixes and hinting removal across selected glyphs, all glyphs, or a name pattern, carrying anchors and kerning along |
| Preview | Live text in the rebuilt font with size, line height, direction, feature toggles (ss01, ss02, jalt, liga…), colour presets, an 8-step shadow and a waterfall; the glyphs HarfBuzz used are listed and clickable |

Undo/redo covers every edit; work is autosaved in the browser and offered back on the next visit.

## How saving stays valid

The studio rebuilds only the tables it edits (glyf, loca, hmtx, hhea, maxp, head, OS/2, name, post,
cmap, and GPOS values in place) and copies every other table byte for byte, so GSUB/GPOS/GDEF
shaping keeps working. Before a file is offered, the saved font is re-opened by the studio,
loaded by the browser (which runs the OpenType Sanitizer used by Chrome and Firefox) and shaped
with HarfBuzz for every mapped character.

Limits: the studio saves TrueType outlines (CFF/PostScript fonts are converted on open); a variable
font is edited and saved as its default instance; GSUB rules are shown and navigated but not edited.

## Development

```sh
npm install
npm run dev                         # http://localhost:5173
npm run build                       # static site in dist/
npx vite build --mode single        # one self-contained file in dist-single/index.html
npm test -- /tmp/out ../melad-display/fonts/ttf/MeladDisplay-Black.ttf   # core round-trip tests
python3 tests/validate.py /tmp/out ../melad-display/fonts/ttf/MeladDisplay-Black.ttf   # fontTools + OTS + HarfBuzz
node tests/e2e.cjs /tmp/e2e         # Playwright, against `npx vite preview --port 4173`
```

`src/font/` is the font engine (no UI): `sfnt.ts` container and WOFF, `tables.ts` core tables,
`glyf.ts` glyph model, `otl.ts` GSUB graph and GPOS values, `font.ts` the editable project,
`ops.ts` outline operations, `cff.ts` CFF conversion. `src/ui/` is the React interface.

# alight-motion-ai

Lets an AI read, preview and write **Alight Motion** projects. You ask for a
design in plain words; the AI hands back an `.xml` (or a `.zip` with the XML
and its images) that you import into Alight Motion on your phone, then edit or
export there.

This is not Alight Motion for the web. The app stays the editor and renderer;
this toolkit gives a model the app's file format.

| Piece | What it is |
| --- | --- |
| [`spec/FORMAT.md`](spec/FORMAT.md) | The project XML format, each rule tagged by how sure it is |
| [`prompt/SYSTEM_PROMPT.md`](prompt/SYSTEM_PROMPT.md) | Paste into any AI's instructions; it can then write projects, with or without tools |
| `bin/amx.mjs` | CLI: build from a JSON design spec, edit, inspect, validate, render frames, HTML preview |
| `mcp/server.mjs` | MCP server with the same abilities, for Claude and other MCP clients |
| `catalog/catalog.json` | 282 effects (196 current) and 19 shape templates with exact parameter names, types, defaults and ranges |
| `examples/` | Design specs and the importable projects built from them |

No dependencies; Node 18 or newer. PNG frames need Chromium (found
automatically, or set `CHROME=/path/to/chrome`).

## How the format was worked out

The Alight Motion APK (v5.0.273) ships 13 projects that the app itself
exported, which it loads as its built-in presets. They are the ground truth:
the app's reader is known to accept them. They were combined with a community
decompile ([kuchingneko28/alight-motion-docs](https://github.com/kuchingneko28/alight-motion-docs))
and checked against each other. Two of the decompile's claims turned out wrong
and are corrected in the spec:

- Keyframe `t` is a fraction of the layer's duration (0 to 1), not seconds.
- Custom shapes are `<shape>` with an SVG `<path d>` of absolute M/L/C/Z.

Also learned from the app's exports: template shape `size` is half the width
and height, strokes are `<path-stroke>` with `<color>` and `<size>` children,
and an imported photo is a rectangle path with a media fill.

Running the app in an emulator was not possible in the build environment (no
hardware virtualization, and the APK and Android SDK hosts were blocked), so
the first real import is still to be done on a phone. Start with
`examples/out/01-text.xml`.

## Quick start

```sh
cd alight-motion-ai
node bin/amx.mjs build examples/specs/07-showcase.json -o my.xml --png --preview
node bin/amx.mjs inspect my.xml
node bin/amx.mjs effects glow
node bin/amx.mjs effect "Text Progress"
node bin/amx.mjs apply my.xml '[{"op":"set","layer":"Title","prop":"text","value":"HELLO"}]'
npm test
```

A design spec is JSON: canvas pixels, seconds, `#RRGGBB` colors, full
widths and heights. The builder converts to the app's units (milliseconds,
`#AARRGGBB`, half-extents, 0..1 keyframe times).

```json
{
  "scene": { "title": "Hello", "width": 1080, "height": 1920, "duration": 5, "background": "#101018" },
  "layers": [
    { "type": "image", "src": "photo.jpg", "fit": "cover" },
    { "type": "text", "text": "HELLO", "font": "Archivo Black", "size": 140,
      "animate": { "scale": [ { "at": 0, "v": 0 }, { "at": 0.6, "v": 1, "ease": "easeOut" } ] },
      "effects": [ { "effect": "com.alightcreative.glow", "params": { "radius": 60 } } ] },
    { "type": "path", "d": "M200 1300 C400 1250 680 1350 880 1300", "fill": "none",
      "stroke": { "color": "#F2B445", "width": 12 } }
  ]
}
```

## Using it from an AI

**MCP (Claude Desktop, Claude Code, other clients):**

```json
{ "mcpServers": { "alight-motion": { "command": "node", "args": ["/path/to/creatives/alight-motion-ai/mcp/server.mjs"] } } }
```

Claude Code: `claude mcp add alight-motion -- node /path/to/alight-motion-ai/mcp/server.mjs`

Tools: `am_guide`, `am_build`, `am_new`, `am_open`, `am_open_text`, `am_edit`,
`am_inspect`, `am_xml`, `am_render` (returns PNG frames the model can look at),
`am_export`, `am_effects`, `am_effect`, `am_shapes`.

**No tools:** paste `prompt/SYSTEM_PROMPT.md` into the AI's instructions and
ask for XML. The prompt has the rules, an example and an effect reference.

## Getting a project onto the phone

1. Send the `.xml` (or the `.zip` when there are images) to the phone.
2. In Alight Motion, import it (the app has an XML import and opens shared
   project files).
3. If the app reports missing media after a bare XML import, replace the
   placeholders with the images from the zip.

## Regenerating

- `python3 tools/extract-catalog.py <apktool dump>` rebuilds the catalog from a
  newer APK.
- `npm run prompt` rebuilds the prompt's reference tables from the catalog.
- `npm run examples` rebuilds every example.
- `AM_PRESETS=<apktool dump>/assets/effects/presets npm test` also checks the
  validator against the app's own exports.

## Known gaps

- The preview draws geometry, fills, gradients, images, text, strokes,
  parenting, nesting, keyframes, blur, Drawing Progress and Text Progress.
  Other effects show as labels only.
- `<drawing>` freehand strokes, `<border>`/`<shadow>`/`<glow>` decorations and
  the zip layout come from the decompile only; prefer path shapes and the Glow
  and Long Shadow effects until a phone import confirms them.

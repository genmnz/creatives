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
| `bin/amx.mjs` | CLI: build from a JSON design spec, edit, decompile, import SVG, inspect, validate, render frames, HTML preview |
| `mcp/server.mjs` | MCP server with the same abilities, for Claude and other MCP clients |
| `catalog/catalog.json` | 282 effects (196 current) and 19 shape templates with exact parameter names, types, defaults and ranges |
| `catalog/presets.json` | the app's own 208 presets (transitions, glitches, looks, 3D, text animations), extracted from the APK |
| `examples/` | Design specs and the importable projects built from them |

No dependencies; Node 18 or newer. PNG frames need Chromium (found
automatically, or set `CHROME=/path/to/chrome`).

## How the format was worked out

The Alight Motion APK (v5.0.273) ships 13 projects that the app itself
exported, which it loads as its built-in presets. They are the ground truth:
the app's reader is known to accept them. 28 more genuine exports come from
users who published their projects on GitHub (app versions 3.6 to 5.0.275,
Android and iOS, including two shared packages with their media). They were
combined with a community decompile
([kuchingneko28/alight-motion-docs](https://github.com/kuchingneko28/alight-motion-docs))
and checked against each other. Some of the decompile's claims turned out wrong
and are corrected in the spec:

- Keyframe `t` is a fraction of the layer's duration (0 to 1), not seconds.
- Custom shapes are `<shape>` with an SVG `<path d>` of absolute M/L/C/Z.
- Shadows and borders are written with keyable children, not attributes.
- Shared packages use `amproj:<name>` uris and a `manifest.txt`; media
  signatures are SHA-1.

What the toolkit does with the 41 real projects (`tools/fetch-corpus.sh`
collects them; `AM_CORPUS=<dir>/xml npm test` runs the checks):

- all 41 pass the validator;
- all 41 decompile to a design spec and rebuild to XML that renders
  identically (1,775 layers in readable form, 27 kept verbatim);
- the previewer draws every one of them.

The SVG importer was run on 3,921 real SVG files (the gilbarbara/logos and
Lucide icon sets): all import and validate, and side-by-side renders match.

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
node bin/amx.mjs decompile project.zip -o project.json   # read any project as a spec
node bin/amx.mjs import-svg logo.svg my.xml --in pop --stagger 0.1
node bin/amx.mjs transitions
node bin/amx.mjs presets glitch
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

Tools: `am_guide`, `am_build`, `am_new`, `am_open` (.xml or package .zip),
`am_open_text`, `am_edit`, `am_spec` (project as an editable spec),
`am_inspect`, `am_xml`, `am_render` (returns PNG frames the model can look at),
`am_export`, `am_effects`, `am_effect`, `am_shapes`, `am_transitions`,
`am_presets`.

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
  newer APK; `node tools/extract-presets.mjs <dump>/assets/effects/presets`
  rebuilds the preset library.
- `npm run prompt` rebuilds the prompt's reference tables from the catalog.
- `npm run examples` rebuilds every example.
- `AM_PRESETS=<apktool dump>/assets/effects/presets npm test` also checks the
  validator against the app's own exports.

## Known gaps

- Nothing has been imported into the app yet: the build machine could not run
  an Android emulator (no hardware virtualization; the SDK and APK hosts were
  blocked). Every rule is checked against the app's own files instead.
- The preview approximates about 40 common effects; the others show as labels.
  Transform-type effects (oscillate, swing, shake, spin, pulse), opacity
  effects (fade, blink), wipes, tiling, blurs, glows, shadows and color
  effects are drawn. Warps, displacement, 3D, particles and keying are not.
- Elastic, bounce and step easings are approximated in the preview.
- Cameras, audio and freehand drawings are read and kept, but the builder
  does not make cameras.

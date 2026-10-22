// Build site/index.html: the viewer with every example loaded, plus the
// format notes and setup instructions. Published as the project's results page.
import { readdirSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { ROOT, buildSpecFile, mediaHrefFor } from "../src/node.mjs";
import { viewerHtml, projectEntry } from "../src/preview.mjs";

const BRANCH = "https://github.com/genmnz/creatives/tree/claude/project-thread-j0y9uy/alight-motion-ai";
const dir = join(ROOT, "examples/specs");
const projects = readdirSync(dir).filter((f) => f.endsWith(".json")).sort().map((f) => {
  const scene = buildSpecFile(join(dir, f));
  return projectEntry(scene, mediaHrefFor(scene), scene.node.attrs.title.replace(/^\d+ /, ""));
});

const header = `
<header class="top">
  <span class="eyebrow">Alight Motion · project XML</span>
  <h1>An AI can now hand you Alight Motion projects</h1>
  <p class="lede">The format was worked out from 41 projects that Alight Motion itself exported: 13 that ship inside the app and 28 that users published. The toolkit turns a short design description into an <code>.xml</code> you import on your phone, reads any project back as an editable description, imports SVG art, and adds transitions and the app's own presets. Below are ten test projects, drawn by the toolkit's own previewer. Press Play.</p>
</header>`;

const tag = (k) => `<span class="conf conf-${k}">${{ app: "seen in app files", decomp: "from decompile", guess: "untested" }[k]}</span>`;
const rules = [
  ["app", "Layers are listed back to front", "<code>&lt;shape&gt;</code>, <code>&lt;text&gt;</code>, <code>&lt;drawing&gt;</code>, <code>&lt;embedScene&gt;</code>, <code>&lt;nullobj&gt;</code>, <code>&lt;audio&gt;</code> inside <code>&lt;scene&gt;</code>. Times are integer milliseconds."],
  ["app", "Keyframe <code>t</code> is a fraction of the layer", "<code>t=\"0.3\"</code> on a 4&nbsp;s layer means 1.2&nbsp;s in. The community docs say seconds. Proof: the pieces of a split clip put the same keyframe at the same moment only if <code>t</code> is a fraction."],
  ["app", "Easing sits on the keyframe it eases into", "<code>e=\"cubicBezier 0.42 0.0 0.58 1.0\"</code>; no <code>e</code> means linear. The app also writes <code>elastic</code>, <code>bounce</code>, <code>step</code>, <code>random</code> and <code>cyclic</code> easings."],
  ["app", "Template <code>size</code> is half the width and height", "A full-frame rectangle on a 1080 canvas is <code>size=\"540,540\"</code>."],
  ["app", "Custom shapes are SVG paths", "<code>&lt;path d=\"M … L … C … Z\"/&gt;</code> relative to the layer's position, absolute commands only. The toolkit converts any SVG path."],
  ["app", "Strokes are <code>&lt;path-stroke&gt;</code>", "With <code>&lt;color&gt;</code> and <code>&lt;size&gt;</code> children, so both can be animated."],
  ["app", "A photo is a rectangle with a media fill", "<code>fillType=\"media\" fillImage=\"amproj:photo.jpg\"</code>, declared once in a <code>&lt;media&gt;</code> entry."],
  ["app", "Shared packages", "A zip with <code>&lt;uuid&gt;.xml</code>, the media files, and <code>manifest.txt</code> lines <code>SHA1:file</code>. Checked against two real packages."],
  ["app", "Shadows and borders", "<code>&lt;shadow&gt;</code> and <code>&lt;border&gt;</code> with keyable <code>&lt;color&gt;</code>, <code>&lt;size&gt;</code>, <code>&lt;opacity&gt;</code>, <code>&lt;offset&gt;</code> children."],
  ["app", "Children are placed relative to their parent", "<code>parent=\"id\"</code>; a child with no location sits on the parent. Masks are a blend mode: <code>blending=\"mask\"</code>."],
  ["app", "Effects are referenced by full id", "<code>com.alightcreative.effects.gaussianblur</code> with <code>&lt;property&gt;</code> parameters. All 282 are in the catalog with exact names and ranges."],
  ["app", "The app's presets are labelled layers", "<code>Transition In: Right; t:start, c:WIR</code>. The <code>t:</code> tag says how a preset stretches to another length. All 208 are in the catalog."],
  ["guess", "Exact effect looks", "The preview approximates about 40 common effects. Warps, 3D, particles and keying only show in the app."],
];

const docs = `
<section class="doc" aria-labelledby="h-format">
  <div class="doc-head"><h2 id="h-format">What the file says</h2><p class="lede">The rules an AI needs, and how sure each one is. The full write-up is <a href="${BRANCH}/spec/FORMAT.md" target="_blank" rel="noopener">spec/FORMAT.md</a>.</p></div>
  <div class="rules">${rules.map(([k, h, b]) => `<div class="rule"><div class="rule-h"><h3>${h}</h3>${tag(k)}</div><p>${b}</p></div>`).join("")}</div>
</section>

<section class="doc" aria-labelledby="h-tested">
  <div class="doc-head"><h2 id="h-tested">Tested against real projects</h2><p class="lede">The project checks run in the test suite against the collected files; the SVG run is a one-off script over two public icon sets.</p></div>
  <div class="stats">
    <div class="stat"><b>41 / 41</b><span>real Alight Motion exports pass the validator</span></div>
    <div class="stat"><b>41 / 41</b><span>read back as an editable spec and rebuilt; every rebuilt project renders identically</span></div>
    <div class="stat"><b>3,921</b><span>real SVG files (logo and icon sets) imported as path layers, all valid</span></div>
    <div class="stat"><b>208</b><span>app presets extracted from the APK, usable by name</span></div>
  </div>
</section>

<section class="doc" aria-labelledby="h-use">
  <div class="doc-head"><h2 id="h-use">Give it to an AI</h2><p class="lede">Three ways in, from most to least capable.</p></div>
  <div class="ways">
    <div class="way">
      <h3>MCP server</h3>
      <p>For Claude Desktop, Claude Code or any MCP client. The model builds from a design spec, edits with operations, looks at rendered PNG frames, and exports the XML.</p>
      <pre><code>claude mcp add alight-motion -- \\
  node creatives/alight-motion-ai/mcp/server.mjs</code></pre>
      <p class="hint">Tools: am_guide, am_build, am_edit, am_spec, am_render, am_export, am_effects, am_transitions, am_presets, am_open …</p>
    </div>
    <div class="way">
      <h3>Command line</h3>
      <p>For an AI with a shell, or for you. No dependencies beyond Node.</p>
      <pre><code>node bin/amx.mjs build design.json --png
node bin/amx.mjs decompile project.zip
node bin/amx.mjs import-svg logo.svg my.xml
node bin/amx.mjs presets glitch</code></pre>
    </div>
    <div class="way">
      <h3>Prompt only</h3>
      <p>Paste <a href="${BRANCH}/prompt/SYSTEM_PROMPT.md" target="_blank" rel="noopener">SYSTEM_PROMPT.md</a> into any chat model's instructions and ask for XML. It holds the rules, a worked example and the 28 most useful effects with their parameters.</p>
    </div>
  </div>
</section>

<section class="doc" aria-labelledby="h-status">
  <div class="doc-head"><h2 id="h-status">What still needs your phone</h2></div>
  <div class="status">
    <p>Running Alight Motion in an emulator was not possible here: the build machine has no hardware virtualization, and the APK and Android SDK downloads were blocked. So there are no screenshots of the app itself. Everything above is checked against 41 files the app wrote, but nothing has been imported into the app yet.</p>
    <ol class="steps">
      <li>Import <code>examples/out/01-text.xml</code>. If it opens, the core format is confirmed.</li>
      <li>Import <code>02-images.zip</code>, then <code>02-images.xml</code> on its own. This settles how images travel.</li>
      <li>Import <code>08-transitions.xml</code> and compare it with the preview above. This checks transitions and the app preset.</li>
      <li>Import <code>10-layers.zip</code> for the mask, shadow, border and blend modes.</li>
    </ol>
    <p>Each sample's XML is one tap away in the viewer's XML tab. All files are on the <a href="${BRANCH}" target="_blank" rel="noopener">branch</a>, in <code>examples/out/</code>.</p>
  </div>
</section>`;

const extraCss = `
.doc { display: grid; gap: 18px; }
.doc-head { display: grid; gap: 6px; }
.rules { display: grid; grid-template-columns: repeat(auto-fill, minmax(min(100%, 340px), 1fr)); gap: 0 28px; }
.rule { padding: 14px 0; border-top: 1px solid var(--line); display: grid; gap: 6px; min-width: 0; }
.rule-h { display: grid; gap: 6px; justify-items: start; }
.rule p { color: var(--muted); font-size: 14px; }
.conf { font: 500 11px var(--mono); letter-spacing: .04em; text-transform: uppercase; white-space: nowrap; padding: 2px 8px; border-radius: 999px; border: 1px solid; }
.conf-app { color: var(--ok); border-color: color-mix(in srgb, var(--ok) 45%, transparent); }
.conf-decomp { color: var(--key); border-color: color-mix(in srgb, var(--key) 45%, transparent); }
.conf-guess { color: var(--muted); border-color: var(--line); }
.ways { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 300px), 1fr)); gap: 16px; }
.way { background: var(--panel); border: 1px solid var(--line); border-radius: 12px; padding: 16px; display: grid; gap: 10px; align-content: start; min-width: 0; }
.way pre { background: var(--code-bg); border: 1px solid var(--line); border-radius: 8px; padding: 10px 12px; margin: 0; overflow-x: auto; }
.status { display: grid; gap: 12px; }
.stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 220px), 1fr)); gap: 12px; }
.stat { background: var(--panel); border: 1px solid var(--line); border-radius: 12px; padding: 14px 16px; display: grid; gap: 4px; }
.stat b { font: 600 28px var(--display, inherit); color: var(--accent); }
.stat span { color: var(--muted); font-size: 14px; }
.steps { margin: 0; padding-left: 22px; display: grid; gap: 6px; max-width: 72ch; }
`;

const html = viewerHtml({ title: "Alight Motion XML Kit", projects, header, docs, extraCss });
mkdirSync(join(ROOT, "site"), { recursive: true });
writeFileSync(join(ROOT, "site/index.html"), html);
console.log("wrote site/index.html", (html.length / 1024).toFixed(0), "KB");

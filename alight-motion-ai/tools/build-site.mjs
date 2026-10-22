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
  <p class="lede">The format was worked out from 13 projects that Alight Motion itself exported, which ship inside the app. The toolkit turns a short design description into an <code>.xml</code> you import on your phone, and reads existing projects back. Below are the seven test projects, drawn by the toolkit's own previewer. Press Play.</p>
</header>`;

const tag = (k) => `<span class="conf conf-${k}">${{ app: "seen in app files", decomp: "from decompile", guess: "untested" }[k]}</span>`;
const rules = [
  ["app", "Layers are listed back to front", "<code>&lt;shape&gt;</code>, <code>&lt;text&gt;</code>, <code>&lt;drawing&gt;</code>, <code>&lt;embedScene&gt;</code>, <code>&lt;nullobj&gt;</code>, <code>&lt;audio&gt;</code> inside <code>&lt;scene&gt;</code>. Times are integer milliseconds."],
  ["app", "Keyframe <code>t</code> is a fraction of the layer", "<code>t=\"0.3\"</code> on a 4&nbsp;s layer means 1.2&nbsp;s in. The community docs say seconds; all 615 keyframes in the app's files are between −0.017 and 1.003."],
  ["app", "Easing sits on the keyframe it eases into", "<code>e=\"cubicBezier 0.42 0.0 0.58 1.0\"</code>; no <code>e</code> means linear."],
  ["app", "Template <code>size</code> is half the width and height", "A full-frame rectangle on a 1080 canvas is <code>size=\"540,540\"</code>."],
  ["app", "Custom shapes are SVG paths", "<code>&lt;path d=\"M … L … C … Z\"/&gt;</code> relative to the layer's position, absolute commands only. The toolkit converts any SVG path."],
  ["app", "Strokes are <code>&lt;path-stroke&gt;</code>", "With <code>&lt;color&gt;</code> and <code>&lt;size&gt;</code> children, so both can be animated."],
  ["app", "A photo is a rectangle with a media fill", "<code>fillType=\"media\" fillImage=\"am-internal:///&lt;sig&gt;.jpg\"</code>, declared once in a <code>&lt;media&gt;</code> entry."],
  ["app", "Effects are referenced by full id", "<code>com.alightcreative.effects.gaussianblur</code> with <code>&lt;property&gt;</code> parameters. All 282 are in the catalog with exact names and ranges."],
  ["decomp", "Nested scenes, parenting, freehand strokes", "<code>&lt;embedScene&gt;</code>, <code>parent=\"id\"</code>, <code>&lt;stroke points=\"x,y,p;…\"&gt;</code>."],
  ["guess", "Zip package layout", "XML plus media files named by their SHA-1, mirroring the app's “Share Zipped XML”. A bare XML import works with media marked missing."],
];

const docs = `
<section class="doc" aria-labelledby="h-format">
  <div class="doc-head"><h2 id="h-format">What the file says</h2><p class="lede">The rules an AI needs, and how sure each one is. The full write-up is <a href="${BRANCH}/spec/FORMAT.md" target="_blank" rel="noopener">spec/FORMAT.md</a>.</p></div>
  <div class="rules">${rules.map(([k, h, b]) => `<div class="rule"><div class="rule-h"><h3>${h}</h3>${tag(k)}</div><p>${b}</p></div>`).join("")}</div>
</section>

<section class="doc" aria-labelledby="h-use">
  <div class="doc-head"><h2 id="h-use">Give it to an AI</h2><p class="lede">Three ways in, from most to least capable.</p></div>
  <div class="ways">
    <div class="way">
      <h3>MCP server</h3>
      <p>For Claude Desktop, Claude Code or any MCP client. The model builds from a design spec, edits with operations, looks at rendered PNG frames, and exports the XML.</p>
      <pre><code>claude mcp add alight-motion -- \\
  node creatives/alight-motion-ai/mcp/server.mjs</code></pre>
      <p class="hint">Tools: am_guide, am_build, am_edit, am_render, am_export, am_effects, am_effect, am_open …</p>
    </div>
    <div class="way">
      <h3>Command line</h3>
      <p>For an AI with a shell, or for you. No dependencies beyond Node.</p>
      <pre><code>node bin/amx.mjs build design.json --png
node bin/amx.mjs inspect project.xml
node bin/amx.mjs effects glow</code></pre>
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
    <p>Running Alight Motion in an emulator was not possible here: the build machine has no hardware virtualization, and the APK and Android SDK downloads were blocked. Everything above is checked against the app's own files, but nothing has been imported into the app yet.</p>
    <ol class="steps">
      <li>Import <code>examples/out/01-text.xml</code>. If it opens, the core format is confirmed.</li>
      <li>Import <code>02-images.zip</code>, then <code>02-images.xml</code> on its own. This settles how images travel.</li>
      <li>Import <code>06-keyframes.xml</code> and check the star spins once over 4 seconds. This confirms keyframe timing.</li>
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
.steps { margin: 0; padding-left: 22px; display: grid; gap: 6px; max-width: 72ch; }
`;

const html = viewerHtml({ title: "Alight Motion XML Kit", projects, header, docs, extraCss });
mkdirSync(join(ROOT, "site"), { recursive: true });
writeFileSync(join(ROOT, "site/index.html"), html);
console.log("wrote site/index.html", (html.length / 1024).toFixed(0), "KB");

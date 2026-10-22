#!/usr/bin/env node
// MCP server (stdio, JSON-RPC 2.0, no dependencies) that lets an AI create,
// read, edit, preview and export Alight Motion XML projects.

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { tmpdir } from "node:os";
import { loadCatalog, newScene, openXml, writeProject, ROOT, renderOut, mediaInfoFromFile, mediaHrefFor, chrome, inlineSvgFiles } from "../src/node.mjs";
import { toSpec } from "../src/decompile.mjs";
import { TRANSITIONS, searchPresets } from "../src/presets.mjs";
import { buildFromSpec } from "../src/builder.mjs";
import { validate, outline } from "../src/validate.mjs";
import { renderSVG } from "../src/render.mjs";
import { searchEffects, findEffect, describeEffect, catalog } from "../src/catalog.mjs";
import { applyOps, OPS_HELP } from "../src/ops.mjs";
import { previewHtml } from "../src/preview.mjs";

loadCatalog();
const projects = new Map();
let counter = 0;
const keep = (scene) => { const id = `p${++counter}`; projects.set(id, scene); return id; };
const get = (id) => {
  const s = projects.get(id);
  if (!s) throw new Error(`no open project "${id}". Open ones: ${[...projects.keys()].join(", ") || "none"}`);
  return s;
};
const summary = (id, scene, extra = "") => {
  const r = validate(scene.node);
  const issues = r.issues.map((i) => `${i.level}: ${i.where}: ${i.msg}`).join("\n");
  return `project_id: ${id}\n${extra}${outline(scene.node)}\n\nchecks: ${r.ok ? "pass" : "FAIL"}${issues ? "\n" + issues : ""}`;
};

const LAYER_SPEC = `Layer spec fields (scene px, origin top-left; times in seconds):
  common: type (text|shape|image|path|svg|drawing|null|group), label, start, end, x, y, scale, rotation, opacity, pivot, blend, parent,
          effects: [{effect: <id or name>, params: {...}}], animate: {position|scale|rotation|opacity|fill|<shape param>: keyframes},
          in / out: entrance and exit (fade, slide-up/down/left/right, pop, zoom, grow, spin, bounce, elastic, blur,
                    wipe-right/left/up/down, typewriter, draw) or {type, duration, distance, ease},
          presets: ["<app preset name>"] (see am_presets)
  text: text, font (Google font name), weight, size, color, align (left|center|right), wrapWidth, stroke {color,width}
  shape: shape (rect|roundrect|circle|star|poly|triangle|arrow|line|wideline|plus|multifoil|pie|arc|moon|teardrop|quad|penta|callout|stamp),
         width, height (full size), radius, cornerRadius, points, sides, innerRadius, params {raw template params},
         fill (#RRGGBB | #AARRGGBB | "none" | {gradient:{type:linear|radial|sweep, from, to, start:[0..1,0..1], end}}),
         stroke {color, width, align}, image (file path: fills the shape with a picture)
  image: src (local file path), width/height (optional; default fits the canvas), fit (contain|cover|stretch)
  path: d (any SVG path, in scene coordinates), fill, stroke
  drawing: strokes [{points [[x,y,pressure]...], color, width}] (local coordinates; experimental)
  group: width, height, layers [...] (a nested scene)
  svg: src (local .svg file) or svg (SVG text), box {x, y, width, height}, stagger (s), itemIn (transition per piece):
       vector art as a group of path layers with fills, strokes and gradients
Keyframes: [{"at": seconds from layer start, "v": value, "ease": "linear|easeIn|easeOut|easeInOut|easeOutStrong|hold|[x1,y1,x2,y2]"}]`;

const TOOLS = [
  { name: "am_guide", description: "Read first. The Alight Motion XML format rules and how to design with these tools.", inputSchema: { type: "object", properties: {} } },
  {
    name: "am_build", description: `Create a whole project from a JSON design spec {scene:{title,width,height,duration,fps,background}, layers:[...]}. Relative image paths resolve against base_dir.\n${LAYER_SPEC}`,
    inputSchema: { type: "object", properties: { spec: { type: "object" }, base_dir: { type: "string" } }, required: ["spec"] },
  },
  {
    name: "am_new", description: "Start an empty project.",
    inputSchema: { type: "object", properties: { title: { type: "string" }, width: { type: "number" }, height: { type: "number" }, duration: { type: "number", description: "seconds" }, fps: { type: "number" }, background: { type: "string" } } },
  },
  { name: "am_open", description: "Open an existing Alight Motion project: .xml (images next to it are linked by file name) or a shared package .zip.", inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } },
  { name: "am_open_text", description: "Open a project from XML text.", inputSchema: { type: "object", properties: { xml: { type: "string" } }, required: ["xml"] } },
  {
    name: "am_edit", description: `Apply edit operations to an open project.\n${OPS_HELP}\n${LAYER_SPEC}`,
    inputSchema: { type: "object", properties: { project_id: { type: "string" }, ops: { type: "array", items: { type: "object" } }, base_dir: { type: "string", description: "folder that relative image/svg paths resolve against" } }, required: ["project_id", "ops"] },
  },
  { name: "am_spec", description: "The project as an editable design spec (seconds, pixels, full sizes, effect params by name). Edit it and pass it to am_build to rebuild; unknown parts are kept verbatim.", inputSchema: { type: "object", properties: { project_id: { type: "string" } }, required: ["project_id"] } },
  { name: "am_transitions", description: "Entrance/exit animations usable as in/out on any layer.", inputSchema: { type: "object", properties: {} } },
  { name: "am_presets", description: "Search Alight Motion's own animation and look presets (208, extracted from the app): transitions, glitches, color grades, 3D, text animations.", inputSchema: { type: "object", properties: { query: { type: "string" } } } },
  { name: "am_inspect", description: "Readable outline of a project: layers, timing, keyframes, effects, plus import checks.", inputSchema: { type: "object", properties: { project_id: { type: "string" } }, required: ["project_id"] } },
  { name: "am_xml", description: "The project's XML text.", inputSchema: { type: "object", properties: { project_id: { type: "string" } }, required: ["project_id"] } },
  {
    name: "am_render", description: "Render frames to look at your work. Returns PNG images (SVG text when no browser is available).",
    inputSchema: { type: "object", properties: { project_id: { type: "string" }, times: { type: "array", items: { type: "number" }, description: "seconds; default 3 frames across the timeline" }, width: { type: "number" } }, required: ["project_id"] },
  },
  {
    name: "am_export", description: "Write the project to <path>.xml, plus <path>.zip holding the XML and its media when it uses images. Also writes an HTML preview when preview=true.",
    inputSchema: { type: "object", properties: { project_id: { type: "string" }, path: { type: "string" }, preview: { type: "boolean" } }, required: ["project_id", "path"] },
  },
  { name: "am_effects", description: "Search Alight Motion's effects by words and/or category (blur, color, distort, procedural, 3d, transform, drawing, matte, opacity, repeat, text, other).", inputSchema: { type: "object", properties: { query: { type: "string" }, category: { type: "string" } } } },
  { name: "am_effect", description: "Parameters (names, types, defaults, ranges, choices) of one effect, by id or display name.", inputSchema: { type: "object", properties: { effect: { type: "string" } }, required: ["effect"] } },
  { name: "am_shapes", description: "Built-in shape templates and their parameters.", inputSchema: { type: "object", properties: {} } },
];

const text = (t) => ({ content: [{ type: "text", text: t }] });

async function call(name, a) {
  switch (name) {
    case "am_guide": return text(readFileSync(join(ROOT, "prompt/SYSTEM_PROMPT.md"), "utf8"));
    case "am_build": {
      const base = a.base_dir ?? process.cwd();
      inlineSvgFiles(a.spec.layers, base);
      const scene = buildFromSpec(a.spec, { mediaResolver: (src) => mediaInfoFromFile(src, base) });
      const id = keep(scene);
      return text(summary(id, scene));
    }
    case "am_new": { const s = newScene(a); return text(summary(keep(s), s)); }
    case "am_open": { const s = openXml(resolve(a.path)); return text(summary(keep(s), s)); }
    case "am_open_text": {
      const p = join(tmpdir(), `amx-${Date.now()}.xml`);
      writeFileSync(p, a.xml);
      const s = openXml(p);
      return text(summary(keep(s), s));
    }
    case "am_edit": {
      const s = get(a.project_id);
      for (const op of [a.ops].flat()) if (op?.op === "add") inlineSvgFiles([op.layer], a.base_dir ?? process.cwd());
      const log = applyOps(s, a.ops);
      return text(summary(a.project_id, s, log.join("\n") + "\n\n"));
    }
    case "am_inspect": return text(summary(a.project_id, get(a.project_id)));
    case "am_xml": return text(get(a.project_id).toXML());
    case "am_spec": return text(JSON.stringify(toSpec(get(a.project_id).node), null, 1));
    case "am_transitions": return text(Object.entries(TRANSITIONS).map(([k, v]) => `${k}: ${v.about}${v.only ? ` (${v.only.join("/")} only)` : ""}`).join("\n") + '\n\nLayer spec: "in": "pop", "out": {"type": "fade", "duration": 0.4}. Edit op: {"op":"transition","layer":"Title","in":"slide-up"}');
    case "am_presets": {
      const list = searchPresets(a.query ?? "", 60);
      return text(list.map((p) => `${p.name} | timing ${p.timing} | ${p.group} | effects: ${p.effects.map((e) => e.attrs.id.split(".").pop()).join(", ")}`).join("\n") + '\n\nApply: layer spec "presets": ["<name>"], or edit op {"op":"preset","layer":..,"preset":"<name>"}. Timing: start/end keep the preset\'s own duration at the layer start/end, stretch scales it to the layer, split does both halves.');
    }
    case "am_render": {
      const s = get(a.project_id);
      const times = a.times ?? [0.15, 0.5, 0.85].map((k) => +(s.duration * k).toFixed(2));
      if (!chrome()) return text(times.map((t) => `t=${t}s\n${renderSVG(s.node, t, { mediaHref: mediaHrefFor(s) })}`).join("\n\n"));
      const dir = join(tmpdir(), "amx-frames");
      mkdirSync(dir, { recursive: true });
      const content = [];
      for (const t of times) {
        const f = renderOut(s, t, join(dir, `${a.project_id}-${t}.png`), a.width ?? 480);
        content.push({ type: "text", text: `t=${t}s` }, { type: "image", data: readFileSync(f).toString("base64"), mimeType: "image/png" });
      }
      content.push({ type: "text", text: "Preview only: effects other than blur are not drawn." });
      return { content };
    }
    case "am_export": {
      const s = get(a.project_id);
      const out = resolve(a.path.endsWith(".xml") ? a.path : a.path + ".xml");
      mkdirSync(dirname(out), { recursive: true });
      const files = writeProject(s, out);
      if (a.preview) {
        const p = out.replace(/\.xml$/, ".preview.html");
        writeFileSync(p, previewHtml(s, mediaHrefFor(s)));
        files.push(p);
      }
      const r = validate(s.node);
      return text(`wrote:\n${files.join("\n")}\nchecks: ${r.ok ? "pass" : "FAIL"}\nImport: send the .xml (or the .zip when there are images) to the phone and open it with Alight Motion.`);
    }
    case "am_effects": {
      const list = searchEffects(a.query ?? "", { category: a.category, limit: 40 });
      return text(list.map((e) => `${e.id}  ${e.name} [${e.category}]${e.membersOnly ? " (members)" : ""}: ${(e.desc ?? "").slice(0, 110)}`).join("\n") || "no matches");
    }
    case "am_effect": {
      const e = findEffect(a.effect);
      if (!e) throw new Error(`no effect "${a.effect}"; search with am_effects`);
      return text(describeEffect(e));
    }
    case "am_shapes": return text(catalog().shapes.filter((x) => !x.deprecated).map((s) => `${s.ref}  ${s.name}: ${s.params.map((p) => `${p.id}=${p.default}`).join(", ")}`).join("\n") + '\n\nXML "size" is half-width,half-height; the build/edit tools take full width/height.');
    default: throw new Error(`unknown tool ${name}`);
  }
}

const send = (msg) => process.stdout.write(JSON.stringify(msg) + "\n");
const rl = createInterface({ input: process.stdin });
rl.on("line", async (line) => {
  if (!line.trim()) return;
  let msg;
  try { msg = JSON.parse(line); } catch { return send({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse error" } }); }
  const { id, method, params } = msg;
  if (id === undefined) return; // notification
  try {
    let result;
    if (method === "initialize") {
      result = {
        protocolVersion: params?.protocolVersion ?? "2025-06-18",
        capabilities: { tools: {} },
        serverInfo: { name: "alight-motion-ai", version: "0.1.0" },
        instructions: "Tools for Alight Motion projects. Call am_guide first, then am_build or am_new + am_edit, check with am_render, and finish with am_export.",
      };
    } else if (method === "tools/list") result = { tools: TOOLS };
    else if (method === "tools/call") {
      try { result = await call(params.name, params.arguments ?? {}); }
      catch (e) { result = { content: [{ type: "text", text: `error: ${e.message}` }], isError: true }; }
    } else if (method === "ping") result = {};
    else return send({ jsonrpc: "2.0", id, error: { code: -32601, message: `method not found: ${method}` } });
    send({ jsonrpc: "2.0", id, result });
  } catch (e) {
    send({ jsonrpc: "2.0", id, error: { code: -32603, message: e.message } });
  }
});

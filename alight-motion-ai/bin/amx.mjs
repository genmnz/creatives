#!/usr/bin/env node
// amx: read, preview, validate and write Alight Motion XML projects.

import { readFileSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { resolve, dirname, basename, extname, join } from "node:path";
import { loadCatalog, buildSpecFile, openXml, newScene, writeProject, ROOT, renderOut, mediaHrefFor } from "../src/node.mjs";
import { toSpec } from "../src/decompile.mjs";
import { TRANSITIONS, searchPresets } from "../src/presets.mjs";
import { validate, outline } from "../src/validate.mjs";
import { searchEffects, findEffect, describeEffect, catalog } from "../src/catalog.mjs";
import { normalizePath } from "../src/svgpath.mjs";
import { applyOps, OPS_HELP } from "../src/ops.mjs";
import { previewHtml } from "../src/preview.mjs";

const HELP = `amx: AI toolkit for Alight Motion XML projects

  amx build <spec.json> [-o out.xml] [--png] [--preview]
                                   design spec -> importable XML (+ .zip when it uses images)
  amx new <out.xml> [--width 1080 --height 1920 --duration 5 --fps 30 --bg #000000 --title T]
  amx apply <project.xml> <ops.json | 'inline json'> [-o out.xml]
                                   edit a project with operations (see: amx ops)
  amx inspect <project.xml|.zip>    readable outline: layers, timing, keyframes, effects
  amx decompile <project.xml|.zip> [-o spec.json]
                                   project -> editable design spec (seconds, pixels); rebuild with amx build
  amx import-svg <art.svg> <project.xml> [-o out.xml] [--box x,y,w,h] [--in draw] [--stagger 0.1]
                                   add vector art as a group of path layers (new project if missing)
  amx transitions                   in/out animations for "in"/"out" in specs and ops
  amx presets [words]               the app's own presets (from the APK) usable as "presets"
  amx validate <project.xml>...     check against the import format
  amx render <project.xml> [--t 1.5] [-o frame.svg|frame.png] [--width 540]
  amx preview <project.xml> [-o preview.html]   self-contained animated preview
  amx effects [words] [--category blur|color|distort|...]
  amx effect <id or name>           parameters of one effect
  amx shapes                        shape templates and their parameters
  amx path '<svg path d>'           normalize to the M/L/C/Z form the app writes
  amx ops                           list edit operations
  amx guide                         print the AI prompt pack`;

const args = process.argv.slice(2);
const cmd = args.shift();
const flag = (name, d) => {
  const i = args.indexOf(name);
  if (i === -1) return d;
  const v = args[i + 1];
  args.splice(i, 2);
  return v;
};
const bool = (name) => {
  const i = args.indexOf(name);
  if (i === -1) return false;
  args.splice(i, 1);
  return true;
};

function report(file, r) {
  console.log(`${file}: ${r.ok ? "OK" : "FAIL"}`);
  for (const i of r.issues) console.log(`  ${i.level === "error" ? "error" : "warn "} ${i.where}: ${i.msg}`);
}

loadCatalog();
try {
  switch (cmd) {
    case "build": {
      const spec = args.shift();
      const png = bool("--png"), prev = bool("--preview");
      const out = flag("-o", spec.replace(/\.json$/i, "") + ".xml");
      const scene = buildSpecFile(spec);
      const files = writeProject(scene, out);
      const r = validate(scene.node);
      report(out, r);
      if (png) {
        const times = [0.15, 0.5, 0.85].map((k) => +(scene.duration * k).toFixed(2));
        for (const [i, t] of times.entries()) files.push(renderOut(scene, t, out.replace(/\.xml$/i, `.f${i + 1}.png`), 540));
      }
      if (prev) {
        const p = out.replace(/\.xml$/i, ".preview.html");
        writeFileSync(p, previewHtml(scene, mediaHrefFor(scene)));
        files.push(p);
      }
      console.log("wrote", files.join(", "));
      break;
    }
    case "new": {
      const out = args.shift();
      const scene = newScene({
        title: flag("--title", basename(out, ".xml")), width: +flag("--width", 1080), height: +flag("--height", 1920),
        duration: +flag("--duration", 5), fps: flag("--fps", "30"), background: flag("--bg", "#000000"),
      });
      writeFileSync(out, scene.toXML());
      console.log("wrote", out);
      break;
    }
    case "apply": {
      const file = args.shift(), opsArg = args.shift();
      const out = flag("-o", file);
      const scene = openXml(file);
      const ops = JSON.parse(existsSync(opsArg) ? readFileSync(opsArg, "utf8") : opsArg);
      for (const l of applyOps(scene, ops)) console.log(l);
      const files = writeProject(scene, out);
      report(out, validate(scene.node));
      console.log("wrote", files.join(", "));
      break;
    }
    case "inspect": console.log(outline(openXml(args[0]).node)); break;
    case "decompile": {
      const file = args.shift();
      const out = flag("-o");
      const json = JSON.stringify(toSpec(openXml(file).node), null, 1);
      if (out) { writeFileSync(out, json); console.log("wrote", out); } else console.log(json);
      break;
    }
    case "import-svg": {
      const svg = args.shift(), file = args.shift();
      if (!svg || !file) throw new Error("usage: amx import-svg <art.svg> <project.xml> [-o out.xml]");
      const out = flag("-o", file);
      const box = flag("--box")?.split(",").map(Number);
      const layer = { type: "svg", svg: readFileSync(svg, "utf8"), label: basename(svg, extname(svg)) };
      if (box) layer.box = { x: box[0], y: box[1], width: box[2], height: box[3] };
      const itemIn = flag("--in"), stagger = flag("--stagger");
      if (itemIn) layer.itemIn = itemIn;
      if (stagger) layer.stagger = +stagger;
      const scene = existsSync(file) ? openXml(file) : newScene({ title: basename(file, ".xml"), width: 1080, height: 1080, duration: 5, background: "#FFFFFF" });
      const g = scene.add(layer);
      console.log(`added group "${g.attrs.label}" with ${g.children.find((c) => c.tag === "scene").children.filter((c) => c.tag).length} layers`);
      const files = writeProject(scene, out);
      report(out, validate(scene.node));
      console.log("wrote", files.join(", "));
      break;
    }
    case "transitions": {
      for (const [k, v] of Object.entries(TRANSITIONS)) console.log(`${k.padEnd(12)} ${v.about}${v.only ? ` (${v.only.join("/")} only)` : ""}`);
      console.log('\nUse in a layer spec: "in": "pop", "out": {"type": "fade", "duration": 0.4}');
      break;
    }
    case "presets": {
      const list = searchPresets(args.join(" "), args.length ? 60 : 300);
      for (const p of list) console.log(`${p.name.padEnd(34)} ${(p.code ?? "").padEnd(7)} t:${p.timing.padEnd(8)} ${p.group}  [${p.effects.map((e) => e.attrs.id.split(".").pop()).join(", ")}]`);
      console.log(`\n${list.length} preset(s). Use in a layer spec: "presets": ["Ghost Pop"]`);
      break;
    }
    case "validate": {
      let failed = false;
      for (const f of args) {
        const r = validate(readFileSync(f, "utf8"));
        report(f, r);
        failed ||= !r.ok;
      }
      process.exitCode = failed ? 1 : 0;
      break;
    }
    case "render": {
      const file = args.shift();
      const t = +flag("--t", 0), width = flag("--width");
      const out = flag("-o", file.replace(/\.xml$/i, `.${t}s.svg`));
      console.log("wrote", renderOut(openXml(file), t, out, width));
      break;
    }
    case "preview": {
      const file = args.shift();
      const out = flag("-o", file.replace(/\.xml$/i, ".preview.html"));
      const scene = openXml(file);
      writeFileSync(out, previewHtml(scene, mediaHrefFor(scene)));
      console.log("wrote", out);
      break;
    }
    case "effects": {
      const cat = flag("--category");
      const list = searchEffects(args.join(" "), { category: cat, limit: args.length ? 30 : 400 });
      for (const e of list) console.log(`${e.id.padEnd(52)} ${e.name}  [${e.category}]${e.membersOnly ? " (members)" : ""}`);
      console.log(`\n${list.length} effect(s). Details: amx effect <id>`);
      break;
    }
    case "effect": {
      const e = findEffect(args.join(" "));
      if (!e) throw new Error(`no effect "${args.join(" ")}"; try amx effects <words>`);
      console.log(describeEffect(e));
      break;
    }
    case "shapes": {
      for (const s of catalog().shapes.filter((x) => !x.deprecated)) {
        console.log(`${s.ref.padEnd(20)} ${s.name}: ${s.params.map((p) => `${p.id}=${p.default}`).join(", ")}`);
      }
      console.log('\nIn the XML, "size" is half-width,half-height. The builder takes full width/height.');
      break;
    }
    case "path": console.log(normalizePath(args.join(" "))); break;
    case "ops": console.log(OPS_HELP); break;
    case "guide": console.log(readFileSync(join(ROOT, "prompt/SYSTEM_PROMPT.md"), "utf8")); break;
    default: console.log(HELP);
  }
} catch (e) {
  console.error("error:", e.message);
  process.exitCode = 1;
}

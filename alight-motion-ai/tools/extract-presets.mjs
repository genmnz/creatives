// Build catalog/presets.json from the preset projects bundled in the APK
// (assets/effects/presets/*.xml in an apktool dump). Each labelled layer
// ("Name; t:timing, c:CODE") becomes a preset: its effect stack, with keyframe
// times relative to its own length, and the timing rule for other lengths.
//   node tools/extract-presets.mjs <apktool dump>/assets/effects/presets
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseXml, kids } from "../src/xml.mjs";
import { parsePresetLabel } from "../src/presets.mjs";
import { ROOT } from "../src/node.mjs";

const dir = process.argv[2];
if (!dir) { console.error("usage: node tools/extract-presets.mjs <presets dir>"); process.exit(1); }
const strip = (n) => (n.tag ? { tag: n.tag, attrs: n.attrs, children: n.children.filter((c) => c.tag).map(strip) } : n);
const out = [];
const seen = new Set();
for (const f of readdirSync(dir).filter((f) => f.endsWith(".xml")).sort()) {
  const scene = parseXml(readFileSync(join(dir, f), "utf8"));
  const group = f.replace(/\.xml$/, "").replace(/[-_ ]*presets?[-_ ]*/gi, " ").replace(/^v\d+\s*/i, "").replace(/^[-\s]+/, "").trim() || "presets";
  const walk = (sc) => {
    for (const l of sc.children.filter((c) => c.tag)) {
      if (l.tag === "embedScene") { const inner = kids(l, "scene")[0]; if (inner) walk(inner); }
      const meta = parsePresetLabel(l.attrs.label);
      const effects = kids(l, "effect");
      if (!meta || !effects.length) continue;
      const key = `${meta.name}|${meta.code}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({
        name: meta.name, code: meta.code, timing: meta.timing, group, layer: l.tag,
        duration: Number(l.attrs.endTime) - Number(l.attrs.startTime),
        effects: effects.map(strip),
      });
    }
  };
  walk(scene);
}
writeFileSync(join(ROOT, "catalog/presets.json"), JSON.stringify(out));
const by = {};
for (const p of out) by[p.timing] = (by[p.timing] ?? 0) + 1;
console.log(`${out.length} presets`, by);

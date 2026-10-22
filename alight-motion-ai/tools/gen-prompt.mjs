// Build prompt/SYSTEM_PROMPT.md: the hand-written guide plus quick-reference
// tables generated from the catalog, so parameter names are always exact.
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ROOT, loadCatalog } from "../src/node.mjs";
import { catalog, findEffect } from "../src/catalog.mjs";

loadCatalog();
const QUICK = [
  "gaussianblur", "Directional Blur", "Zoom Blur", "Soft Glow", "com.alightcreative.glow", "Light Glow", "Long Shadow",
  "Vignette", "Brightness / Contrast", "Color Tune", "Exposure / Gamma", "Noise", "Mosaic", "Pixelate", "Mirror",
  "Text Progress", "Count Up/Down", "Drawing Progress", "Fade In/Out", "Pulse Size", "Oscillate", "Auto-Shake", "Swing",
  "Raster Transform", "Radial Repeat", "Wave Warp", "Lens Flare", "Starfield",
];
const fmtParam = (p) => {
  let s = `${p.id}:${p.type}`;
  if (p.default !== undefined) s += `=${p.default}`;
  if (p.min !== undefined) s += ` [${p.min}..${p.max}]`;
  if (p.choices) s += ` {${p.choices.map(([v, l]) => `${v}:${l}`).join(", ")}}`;
  return s;
};
let out = readFileSync(join(ROOT, "prompt/SYSTEM_PROMPT.src.md"), "utf8");
out += "\n## Effect quick reference\n\nFull id, then parameters as `name:type=default [min..max]`. 'members' needs a subscription. Search the other " +
  `${catalog().effects.filter((e) => !e.deprecated).length - QUICK.length} with am_effects / amx effects.\n\n`;
for (const q of QUICK) {
  const e = findEffect(q);
  if (!e) throw new Error("missing " + q);
  out += `- **${e.name}** \`${e.id}\`${e.membersOnly ? " (members)" : ""}: ${e.params.map(fmtParam).join("; ")}\n`;
}
out += "\n## Shape templates\n\n`s` value, then parameters with defaults (XML `size` is half-width,half-height).\n\n";
for (const s of catalog().shapes.filter((x) => !x.deprecated)) out += `- \`${s.ref}\` ${s.name}: ${s.params.map((p) => `${p.id}=${p.default}`).join(", ")}\n`;
writeFileSync(join(ROOT, "prompt/SYSTEM_PROMPT.md"), out);
console.log("wrote prompt/SYSTEM_PROMPT.md", out.length, "chars");

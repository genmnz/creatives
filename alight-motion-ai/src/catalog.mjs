// Effect and shape-template catalog, extracted from the app's assets by
// tools/extract-catalog.py. Works in Node and in the browser: call
// setCatalog(json) once, or use loadCatalog() from node.mjs.

let CAT = { effects: [], shapes: [] };
let byId = new Map();

export function setCatalog(data) {
  CAT = data;
  byId = new Map(data.effects.map((e) => [e.id, e]));
}

export const catalog = () => CAT;

const norm = (s) => String(s ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");

/** Resolve an effect from a full id, an id tail ("gaussianblur") or a display name ("Gaussian Blur"). */
export function findEffect(q) {
  if (byId.has(q)) return byId.get(q);
  const n = norm(q);
  const live = CAT.effects.filter((e) => !e.deprecated);
  return (
    live.find((e) => norm(e.id.split(".").pop()) === n) ??
    live.find((e) => norm(e.name) === n) ??
    CAT.effects.find((e) => norm(e.id.split(".").pop()) === n || norm(e.name) === n) ??
    null
  );
}

export function searchEffects(query = "", { category, limit = 40, includeDeprecated = false } = {}) {
  const words = String(query).toLowerCase().split(/\s+/).filter(Boolean);
  return CAT.effects
    .filter((e) => includeDeprecated || !e.deprecated)
    .filter((e) => !category || e.category === category)
    .map((e) => {
      const hay = `${e.id} ${e.name} ${e.category} ${e.desc ?? ""}`.toLowerCase();
      const score = words.reduce((s, w) => s + (e.name.toLowerCase().includes(w) ? 3 : 0) + (hay.includes(w) ? 1 : 0), 0);
      return { e, score };
    })
    .filter((x) => !words.length || x.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((x) => x.e);
}

export function findShape(q) {
  const n = norm(String(q).replace(/^\./, ""));
  return (
    CAT.shapes.find((s) => norm(s.ref) === n || norm(s.id.split("shapes.").pop()) === n || norm(s.name) === n) ??
    (n === "rectangle" ? findShape("rect") : n === "ellipse" || n === "oval" ? findShape("circle") : n === "polygon" ? findShape("poly") : null)
  );
}

export function paramDefault(p) {
  if (p.default === undefined) return undefined;
  switch (p.type) {
    case "float": case "int": return Number(p.default);
    case "bool": return p.default === "true";
    case "color": return p.default;
    default: return String(p.default).split(",").map(Number);
  }
}

/** Short text description of an effect for prompts and CLI output. */
export function describeEffect(e) {
  const lines = [`${e.name}  (${e.id})`, `category: ${e.category}${e.membersOnly ? " · members only" : ""}${e.deprecated ? " · deprecated" : ""}`];
  if (e.desc) lines.push(e.desc);
  for (const p of e.params) {
    let s = `  - ${p.id}: ${p.type}`;
    if (p.default !== undefined) s += ` = ${p.default}`;
    if (p.min !== undefined || p.max !== undefined) s += ` [${p.min ?? ""}..${p.max ?? ""}]`;
    if (p.unit) s += ` (${p.unit})`;
    if (p.label && p.label !== p.id) s += `  "${p.label}"`;
    if (p.choices) s += `  choices: ${p.choices.map(([v, l]) => `${v}=${l}`).join(", ")}`;
    lines.push(s);
  }
  return lines.join("\n");
}

export const BLEND_MODES = [
  "normal", "multiply", "screen", "mask", "clipping-mask", "exclude", "diff", "exclusion",
  "lighten", "darken", "lighter-color", "darker-color", "color-burn", "linear-burn",
  "color-dodge", "linear-dodge", "overlay", "soft-light", "hard-light", "soft-overlay",
  "vivid-light", "linear-light", "pin-light", "hue", "saturation", "color", "luminance",
  "subtract", "divide",
];

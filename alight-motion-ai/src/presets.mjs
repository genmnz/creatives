// Transitions (in/out animations) and the app's own preset library.
//
// Transitions are built from effects, the way Alight Motion's bundled presets
// are: a Raster Transform, Wipe, Gaussian Blur, Text Progress or Drawing
// Progress effect with keyframes in the first or last part of the layer. Using
// effects leaves the layer's own transform keyframes untouched, so an
// entrance can be combined with any motion.
//
// App presets (catalog/presets.json) are the labelled layers inside the APK's
// preset projects ("Ghost Pop; t:start", "Transition In: Right; t:start, c:WIR").
// The t: tag says how the preset's keyframes map onto a layer of another length.

import { el, kids } from "./xml.mjs";

const RT = "com.alightcreative.effects.transform";

/**
 * Each transition describes the entrance: effect params going from the hidden
 * state (from) to the shown state (to). An exit plays it in reverse.
 * only: restrict to layer tags.
 */
export const TRANSITIONS = {
  fade: { about: "fade in from transparent", fx: [[RT, { alpha: [0, 1] }]] },
  "slide-up": { about: "rise from below while fading in", fx: [[RT, { offset: [[0, "D"], [0, 0]], alpha: [0, 1] }]] },
  "slide-down": { about: "drop from above while fading in", fx: [[RT, { offset: [[0, "-D"], [0, 0]], alpha: [0, 1] }]] },
  "slide-left": { about: "enter from the right, moving left", fx: [[RT, { offset: [["D", 0], [0, 0]], alpha: [0, 1] }]] },
  "slide-right": { about: "enter from the left, moving right", fx: [[RT, { offset: [["-D", 0], [0, 0]], alpha: [0, 1] }]] },
  pop: { about: "scale up from nothing with a small overshoot", ease: "backOut", fx: [[RT, { scale: [0, 1] }]] },
  zoom: { about: "settle from 2x while fading in", fx: [[RT, { scale: [2, 1], alpha: [0, 1] }]] },
  grow: { about: "grow from 30% while fading in", fx: [[RT, { scale: [0.3, 1], alpha: [0, 1] }]] },
  spin: { about: "spin a full turn while scaling up", fx: [[RT, { angle: [360, 0], scale: [0, 1] }]] },
  bounce: { about: "drop in from above and bounce", ease: "bounce", fx: [[RT, { offset: [[0, "-D"], [0, 0]] }]] },
  elastic: { about: "spring in from nothing", ease: "elastic", fx: [[RT, { scale: [0, 1] }]] },
  blur: { about: "come into focus while fading in", fx: [["com.alightcreative.effects.gaussianblur", { strength: [1.2, 0] }], [RT, { alpha: [0, 1] }]] },
  "wipe-right": { about: "wipe on from left to right", fx: [["com.alightcreative.effects.wipe2", { end: [-0.003, 1], angle: 0 }]] },
  "wipe-left": { about: "wipe on from right to left", fx: [["com.alightcreative.effects.wipe2", { end: [-0.003, 1], angle: 180 }]] },
  "wipe-down": { about: "wipe on from top to bottom", fx: [["com.alightcreative.effects.wipe2", { end: [-0.003, 1], angle: 90 }]] },
  "wipe-up": { about: "wipe on from bottom to top", fx: [["com.alightcreative.effects.wipe2", { end: [-0.003, 1], angle: 270 }]] },
  typewriter: { about: "type the text on letter by letter", only: ["text"], ease: "linear", fx: [["com.alightcreative.effects.textprogress", { end: [0, 1] }]] },
  draw: { about: "draw the outline on", only: ["shape", "drawing"], ease: "easeInOut", fx: [["com.alightcreative.effects.drawing.progress", { end: [0, 100] }]] },
};

const subst = (v, dist) => (v === "D" ? dist : v === "-D" ? -dist : v);

/**
 * Effect specs (builder format) for an entrance or exit.
 * which: "in" | "out"; layerSec: layer length; opts: {duration (s), distance (px), ease}.
 */
export function transitionEffects(name, which, layerSec, tag, opts = {}) {
  const tr = TRANSITIONS[name];
  if (!tr) throw new Error(`unknown transition "${name}" (use ${Object.keys(TRANSITIONS).join(", ")})`);
  if (tr.only && tag && !tr.only.includes(tag)) throw new Error(`transition "${name}" works on ${tr.only.join("/")} layers, not ${tag}`);
  const d = Math.min(Number(opts.duration ?? 0.6), layerSec / (opts.both ? 2 : 1));
  const dist = Number(opts.distance ?? 240);
  const inEase = opts.ease ?? tr.ease ?? "easeOutStrong";
  const outEase = opts.ease ?? (tr.ease === "linear" ? "linear" : tr.ease === "easeInOut" ? "easeInOut" : "easeIn");
  return tr.fx.map(([effect, params]) => {
    const out = {};
    for (const [k, v] of Object.entries(params)) {
      if (!Array.isArray(v) || v.length !== 2 || (k === "offset" && !Array.isArray(v[0]))) { out[k] = v; continue; }
      const from = Array.isArray(v[0]) ? v[0].map((x) => subst(x, dist)) : v[0];
      const to = Array.isArray(v[1]) ? v[1].map((x) => subst(x, dist)) : v[1];
      out[k] = which === "in"
        ? [{ at: 0, v: from }, { at: d, v: to, ease: inEase }]
        : [{ at: layerSec - d, v: to }, { at: layerSec, v: from, ease: outEase }];
    }
    return { effect, params: out };
  });
}

// ----- app presets -----

let PRESETS = [];
export function setPresets(list) { PRESETS = list ?? []; }
export const presets = () => PRESETS;

const norm = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

export function findPreset(q) {
  const n = norm(q);
  return PRESETS.find((p) => p.code && norm(p.code) === n) ?? PRESETS.find((p) => norm(p.name) === n) ??
    PRESETS.find((p) => norm(p.name).includes(n));
}

export function searchPresets(query = "", limit = 40) {
  const words = norm(query).split(" ").filter(Boolean);
  return PRESETS.filter((p) => words.every((w) => norm(`${p.name} ${p.group} ${p.timing} ${p.effects.map((e) => e.id).join(" ")}`).includes(w))).slice(0, limit);
}

/**
 * Remap a preset keyframe time (fraction of the preset layer) onto a layer of
 * another length, following the preset's timing tag.
 *   start   keep absolute time from the layer start
 *   end     keep absolute time from the layer end
 *   split   first half like start, second half like end
 *   extend  like start; constant effects that simply last the whole layer
 *   stretch scale with the layer (fractions unchanged)
 */
export function remapT(t, timing, presetMs, layerMs) {
  const k = presetMs / layerMs;
  switch (timing) {
    case "stretch": return t;
    case "end": return 1 - (1 - t) * k;
    case "split": return t <= 0.5 ? t * k : 1 - (1 - t) * k;
    default: return t * k;
  }
}

/** Clone a preset's effect nodes with keyframe times remapped for a layer of layerMs. */
export function presetEffectNodes(preset, layerMs, timing = preset.timing ?? "stretch") {
  const clone = (n) => {
    if (!n.tag) return { ...n };
    const attrs = { ...n.attrs };
    if (n.tag === "kf") attrs.t = remapT(Number(attrs.t), timing, preset.duration, layerMs).toFixed(6);
    return el(n.tag, attrs, n.children.map(clone));
  };
  return preset.effects.map(clone);
}

export const PRESET_TIMINGS = ["start", "end", "split", "extend", "stretch"];

/** Parse a preset layer label: "Name; t:start, c:CODE". */
export function parsePresetLabel(label) {
  const m = /^(.*?);\s*(.*)$/.exec(label ?? "");
  if (!m) return null;
  const tags = Object.fromEntries(m[2].split(",").map((x) => x.trim().split(":")).filter((x) => x.length === 2).map(([k, v]) => [k.trim(), v.trim()]));
  if (!tags.t && !tags.c) return null;
  return { name: m[1].trim(), timing: (tags.t ?? "stretch").toLowerCase(), code: tags.c ?? null };
}


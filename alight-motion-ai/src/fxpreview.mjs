// Approximations of Alight Motion effects for the previewer. Each effect turns
// into one of: an extra transform, an opacity factor, SVG filter primitives
// chained in effect order, a wipe mask, or tiling. They are close enough to
// see what a project does, not a pixel match. Anything not listed in FX is
// drawn without the effect and reported as unpreviewed.

import { kids } from "./xml.mjs";
import { readKeyable, valueAt, cssColor, parseColor } from "./anim.mjs";

const n3 = (x) => +Number(x).toFixed(3);
const RAD = Math.PI / 180;

// Periodic waves: sine or triangle (type 1), in -1..1.
function wave(x, type) {
  if (Number(type) === 1) { const f = x - Math.floor(x); return f < 0.5 ? 4 * f - 1 : 3 - 4 * f; }
  return Math.sin(2 * Math.PI * x);
}

// Smooth 1D value noise in -1..1, seeded.
function noise(x, seed) {
  const h = (i) => { const s = Math.sin((i + seed * 17.13) * 127.1) * 43758.5453; return (s - Math.floor(s)) * 2 - 1; };
  const i = Math.floor(x), f = x - i, k = f * f * (3 - 2 * f);
  return h(i) * (1 - k) + h(i + 1) * k;
}

const col = (v) => (Array.isArray(v) ? v : parseColor(v));
const bool = (v) => v === true || v === "true" || v === 1;
const rgba = (c, a = 1) => `rgba(${c.slice(0, 3).map(Math.round).join(",")},${n3((c[3] ?? 1) * a)})`;

/**
 * Each entry: (p, env) => partial plan. p(name, default) reads a parameter at the
 * current frame. env = { t: seconds into the layer, dur: layer seconds, prev: filter input }.
 * A plan can hold: move [dx, dy], rotate, scale [sx, sy], opacity, filter (primitives
 * string; must end in result=env.out), wipe {start, end, angle, feather}, tile {mirror}.
 */
const FX = {
  // ── motion ────────────────────────────────────────────────────────────────
  oscillate3(p, { t }) {
    const w = wave(p("freq", 2) * t + p("phase", 0), p("type", 0)), mag = p("mag", 25), a = p("angle", 45) * RAD;
    const dir = Number(p("direction", 0));
    if (dir === 1) return { scale: [1 + (w * mag) / 500, 1 + (w * mag) / 500] };
    if (dir === 2) { const ph = 2 * Math.PI * (p("freq", 2) * t + p("phase", 0)); return { move: [mag * Math.cos(ph), mag * Math.sin(ph)] }; }
    return { move: [w * mag * Math.cos(a), w * mag * Math.sin(a)] };
  },
  oscillate(p, env) { return FX.oscillate3(p, env); },
  swing2(p, { t }) {
    const w = (wave(p("freq", 2) * t + p("phase", 0), p("type", 0)) + 1) / 2;
    return { rotate: p("a1", -30) + (p("a2", 30) - p("a1", -30)) * w };
  },
  swing(p, env) { return FX.swing2(p, env); },
  shake2(p, { t }) {
    const x = p("freq", p("speed", 2)) * t + p("evolution", 0), seed = p("seed", 0), mag = p("mag", 50);
    return { move: [mag * noise(x, seed), mag * noise(x, seed + 7.7)] };
  },
  shake(p, env) { return FX.shake2(p, env); },
  spin(p, { t }) { return { rotate: p("rpm", 60) * 6 * t }; },
  pulsate2(p, { t }) {
    const w = (wave(p("freq", 2) * t + p("phase", 0), p("type", 0)) + 1) / 2;
    const s = p("minsize", 0.9) + (p("maxsize", 1.1) - p("minsize", 0.9)) * w;
    return { scale: [s, s] };
  },
  transform(p) {
    const off = p("offset", [0, 0]);
    return { move: [off[0] ?? 0, off[1] ?? 0], rotate: p("angle", 0), scale: [p("scale", 1), p("scale", 1)], opacity: p("alpha", 1) };
  },
  stretch2(p) { return { stretch: { scale: p("scale", 1), angle: p("angle", 0) } }; },
  flip3(p) {
    // A 3D flip seen head on: the layer narrows by cos(angle) across the flip axis.
    return { stretch: { scale: Math.cos(p("angle", 0) * RAD), angle: p("axis", 0) } };
  },
  // ── opacity ───────────────────────────────────────────────────────────────
  fade(p, { t, dur }) {
    const i = p("inTime", 0.5), o = p("outTime", 0.5);
    return { opacity: Math.max(0, Math.min(1, i > 0 ? t / i : 1, o > 0 ? (dur - t) / o : 1)) };
  },
  blink2(p, { t }) { return { opacity: Math.floor(2 * p("freq", 2) * t) % 2 ? 0 : 1 }; },
  pulseopacity2(p, { t }) {
    const w = (wave(p("freq", 2) * t + p("phase", 0), p("type", 0)) + 1) / 2;
    return { opacity: 1 - p("strength", 1) * w };
  },
  // ── masks ─────────────────────────────────────────────────────────────────
  wipe2(p) { return { wipe: { start: p("start", 0), end: p("end", 1), angle: p("angle", 0), feather: p("feather", 0) } }; },
  wipe(p) { return FX.wipe2(p); },
  tile(p) { return { tile: { mirror: bool(p("mirror", false)), scale: p("scale", 1) } }; },
  // ── blur ──────────────────────────────────────────────────────────────────
  gaussianblur(p, e) { return blur(p("strength", p("radius", 0.15)) * 40, 0, e); },
  boxblur(p, e) { return FX.gaussianblur(p, e); },
  fastblur(p, e) { return FX.gaussianblur(p, e); },
  lensblur2(p, e) { return blur(p("strength", p("radius", 0.15)) * 40, 0, e); },
  dblur(p, e) {
    const s = p("strength", 0.15) * 80, a = Math.abs(Math.cos(p("angle", 0) * RAD));
    return blur(s * a, s * Math.sqrt(1 - a * a), e);
  },
  zoomblur3(p, e) { return blur(p("strength", 0.15) * 20, 0, e); },
  // ── light ─────────────────────────────────────────────────────────────────
  glow(p, e) { return glow(col(p("color", "#FFFFFFAA")), p("radius", 100) / 3, p("alpha", 0.75), e); },
  softglow(p, e) { return glow([255, 255, 255, 1], p("radius", 40) / 3, 0.6, e); },
  lightglow(p, e) { return FX.softglow(p, e); },
  edgeglow(p, e) { return glow(col(p("color", "#FFFFFFFF")), p("radius", 20) / 3, 0.8, e); },
  "inner-glow"(p, e) { return glow(col(p("color", "#FFFFFFFF")), p("radius", 20) / 3, 0.6, e); },
  longshadow2(p, e) {
    const len = p("size", 0.15) * 1000, a = p("angle", 45) * RAD, c = col(p("color", "#FF000000"));
    const steps = 16, parts = [];
    for (let i = steps; i >= 1; i--) parts.push(`<feOffset in="${e.id}a" dx="${n3((Math.cos(a) * len * i) / steps)}" dy="${n3((Math.sin(a) * len * i) / steps)}" result="${e.id}s${i}"/>`);
    return {
      filter: `<feFlood flood-color="${rgba(c)}" flood-opacity="${n3(Math.min(1, p("alpha", 0.1) * 4))}"/><feComposite in2="${e.prev}" operator="in" result="${e.id}a"/>` +
        parts.join("") + `<feMerge result="${e.out}">${parts.map((_, i) => `<feMergeNode in="${e.id}s${steps - i}"/>`).join("")}<feMergeNode in="${e.prev}"/></feMerge>`,
    };
  },
  longshadow(p, e) { return FX.longshadow2(p, e); },
  shadow(p, e) { return dropShadow([0, 0, 0, 1], p("radius", 5), 0.6, [p("sdx", 5), p("sdy", 5)], e); },
  // ── color ─────────────────────────────────────────────────────────────────
  exposure(p, e) {
    const m = Math.pow(2, p("exposure", 0)), g = 1 / Math.max(0.01, p("gamma", 1)), o = p("offset", 0);
    const f = (ch) => `<feFunc${ch} type="gamma" amplitude="${n3(m)}" exponent="${n3(g)}" offset="${n3(o)}"/>`;
    return { filter: `<feComponentTransfer in="${e.prev}" result="${e.out}">${f("R")}${f("G")}${f("B")}</feComponentTransfer>` };
  },
  brightcont2(p, e) {
    const c = 1 + p("contrast", 0), b = p("brightness", 0);
    const f = (ch) => `<feFunc${ch} type="linear" slope="${n3(c)}" intercept="${n3(b + 0.5 * (1 - c))}"/>`;
    return { filter: `<feComponentTransfer in="${e.prev}" result="${e.out}">${f("R")}${f("G")}${f("B")}</feComponentTransfer>` };
  },
  satvib(p, e) { return { filter: `<feColorMatrix in="${e.prev}" type="saturate" values="${n3(Math.max(0, 1 + p("saturation", 0)))}" result="${e.out}"/>` }; },
  hueshift(p, e) { return { filter: `<feColorMatrix in="${e.prev}" type="hueRotate" values="${n3(p("hue", 0))}" result="${e.out}"/>` }; },
  invert(p, e) {
    const f = (ch, on) => `<feFunc${ch} type="table" tableValues="${on ? "1 0" : "0 1"}"/>`;
    return { filter: `<feComponentTransfer in="${e.prev}" result="${e.out}">${f("R", bool(p("invertRed", true)))}${f("G", bool(p("invertGreen", true)))}${f("B", bool(p("invertBlue", true)))}</feComponentTransfer>` };
  },
  solidcolor(p, e) {
    return { filter: `<feFlood flood-color="${rgba(col(p("color", "#FF2D1EF6")))}" flood-opacity="${n3(p("alpha", 1))}"/><feComposite in2="${e.prev}" operator="in" result="${e.out}"/>` };
  },
  rgbsep(p, e) {
    const d = p("strength", 0.15) * 60, a = p("angle", 0) * RAD, dx = n3(Math.cos(a) * d), dy = n3(Math.sin(a) * d);
    const only = (r, g, b) => `0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 1 0`.split(" ").map((v, i) => (i === 0 ? r : i === 6 ? g : i === 12 ? b : v)).join(" ");
    return {
      filter: `<feColorMatrix in="${e.prev}" type="matrix" values="${only(1, 0, 0)}" result="${e.id}r"/><feOffset in="${e.id}r" dx="${-dx}" dy="${-dy}" result="${e.id}ro"/>` +
        `<feColorMatrix in="${e.prev}" type="matrix" values="${only(0, 1, 0)}" result="${e.id}g"/>` +
        `<feColorMatrix in="${e.prev}" type="matrix" values="${only(0, 0, 1)}" result="${e.id}b"/><feOffset in="${e.id}b" dx="${dx}" dy="${dy}" result="${e.id}bo"/>` +
        `<feBlend in="${e.id}ro" in2="${e.id}g" mode="screen" result="${e.id}rg"/><feBlend in="${e.id}rg" in2="${e.id}bo" mode="screen" result="${e.out}"/>`,
    };
  },
};

function blur(sx, sy, e) {
  if (sx < 0.1 && sy < 0.1) return {};
  return { filter: `<feGaussianBlur in="${e.prev}" stdDeviation="${n3(sx)} ${n3(sy)}" result="${e.out}"/>` };
}

function glow(c, r, alpha, e) {
  return {
    filter: `<feGaussianBlur in="${e.prev}" stdDeviation="${n3(Math.max(0.5, r))}" result="${e.id}b"/>` +
      `<feFlood flood-color="${rgba(c)}" flood-opacity="${n3(Math.min(1, alpha * 1.5))}"/><feComposite in2="${e.id}b" operator="in" result="${e.id}c"/>` +
      `<feMerge result="${e.out}"><feMergeNode in="${e.id}c"/><feMergeNode in="${e.id}c"/><feMergeNode in="${e.prev}"/></feMerge>`,
  };
}

export function dropShadow(c, blurPx, opacity, [dx, dy], e) {
  return {
    filter: `<feGaussianBlur in="${e.prev}" stdDeviation="${n3(Math.max(0, blurPx))}" result="${e.id}b"/><feOffset in="${e.id}b" dx="${n3(dx)}" dy="${n3(dy)}" result="${e.id}o"/>` +
      `<feFlood flood-color="${rgba(c)}" flood-opacity="${n3(opacity)}"/><feComposite in2="${e.id}o" operator="in" result="${e.id}c"/>` +
      `<feMerge result="${e.out}"><feMergeNode in="${e.id}c"/><feMergeNode in="${e.prev}"/></feMerge>`,
  };
}

/** Names (id tails) of effects the previewer approximates. */
export const PREVIEWED = new Set(Object.keys(FX));

/**
 * Build a plan for all visible effects on a layer at layer fraction u.
 * Returns { move, rotate, scale, stretches, opacity, filter (full primitive chain or ""),
 * wipes, tile, skipped: [names not previewed] }.
 */
export function effectPlan(node, u, tSec, durSec, uid) {
  const plan = { move: [0, 0], rotate: 0, scale: [1, 1], stretches: [], opacity: 1, filter: "", wipes: [], tile: null, skipped: [] };
  let prev = "SourceGraphic", i = 0;
  for (const fx of kids(node, "effect")) {
    if (fx.attrs.hidden === "true") continue;
    const tail = fx.attrs.id.split(".").pop();
    const fn = FX[tail];
    if (!fn) { plan.skipped.push(tail); continue; }
    const p = (name, d) => {
      const pr = kids(fx, "property").find((x) => x.attrs.name === name);
      if (!pr) return d;
      const v = valueAt(readKeyable(pr), u, d);
      return typeof d === "number" && typeof v === "string" ? Number(v) : v;
    };
    const id = `${uid}e${i++}`, out = `${id}o`;
    const r = fn(p, { t: tSec, dur: durSec, prev, out, id }) ?? {};
    if (r.move) { plan.move[0] += r.move[0]; plan.move[1] += r.move[1]; }
    if (r.rotate) plan.rotate += r.rotate;
    if (r.scale) { plan.scale[0] *= r.scale[0]; plan.scale[1] *= r.scale[1]; }
    if (r.stretch) plan.stretches.push(r.stretch);
    if (r.opacity !== undefined) plan.opacity *= r.opacity;
    if (r.filter) { plan.filter += r.filter; prev = out; }
    if (r.wipe) plan.wipes.push(r.wipe);
    if (r.tile) plan.tile = r.tile;
  }
  plan.filterOut = prev;
  return plan;
}

/** Edge decorations written as children: <shadow>, <glow>. Values may be children or attributes. */
export function decorationFilter(node, u, uid, prev) {
  let filter = "", i = 0;
  for (const tag of ["shadow", "glow"]) {
    for (const d of kids(node, tag)) {
      if (d.attrs.enabled === "false") continue;
      const get = (name, def) => {
        const c = kids(d, name)[0];
        if (c) return valueAt(readKeyable(c), u, def);
        if (d.attrs[name] === undefined) return def;
        return name === "color" ? col(d.attrs[name]) : name === "offset" ? d.attrs[name].split(",").map(Number) : Number(d.attrs[name]);
      };
      const color = get("color", [0, 0, 0, 1]), size = Number(get("size", 12)), opacity = Number(get("opacity", 0.5));
      const id = `${uid}d${i++}`, out = `${id}o`;
      const e = { prev, out, id };
      const r = tag === "shadow"
        ? dropShadow(color, size / 2, opacity, get("offset", [0, 8]), e)
        : glow(color, size / 2, opacity, e);
      filter += r.filter;
      prev = out;
    }
  }
  return { filter, out: prev };
}


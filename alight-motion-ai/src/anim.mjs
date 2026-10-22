// Keyable values: parsing, formatting and interpolation.
//
// A keyable is written either as value="..." or as <kf t="" v="" e=""/> children.
// Keyframe t is a fraction of the layer's duration (0 = startTime, 1 = endTime),
// confirmed against first-party exports bundled in the APK. The e attribute on a
// keyframe is the easing of the segment that ends at that keyframe.

import { el, kids } from "./xml.mjs";

export const EASING = {
  linear: null,
  easeIn: "cubicBezier 0.42 0.0 1.0 1.0",
  easeOut: "cubicBezier 0.0 0.0 0.58 1.0",
  easeInOut: "cubicBezier 0.42 0.0 0.58 1.0",
  // Strong curves seen in Alight Motion's own presets.
  easeOutStrong: "cubicBezier 0.0 0.0 0.3377031 0.9916667",
  easeInOutStrong: "cubicBezier 0.56145656 0.0 0.4665546 0.9888888",
  hold: "cubicBezier 1.0 0.0 1.0 0.0",
  // Most common curves in modern app exports.
  snap: "cubicBezier 0.0 0.0 0.0 1.0",
  easeInHard: "cubicBezier 1.0 0.0 1.0 1.0",
  smooth: "cubicBezier 0.8 0.0 0.27 1.0",
  anticipate: "cubicBezier 0.25 -0.42 0.75 -0.44",
  // Overshoot (back) curves: y outside 0..1 is valid, the app writes such curves too.
  backOut: "cubicBezier 0.34 1.56 0.64 1.0",
  backIn: "cubicBezier 0.36 0.0 0.66 -0.56",
  // Non-bezier easings the app writes (parameters as seen in its exports).
  elastic: "elastic 0.5 1.0 0.0 1.0",
  elasticIn: "reverse elastic 0.5 1.0 0.0 1.0",
  bounce: "bounce 0.31921425 0.81",
};

/** Easing families found in app exports; anything else is passed through untouched. */
export const EASING_FORMS = /^(local )?(cubicBezier( -?[\d.eE-]+){4}|(reverse )?elastic( -?[\d.eE-]+){4}|bounce( -?[\d.eE-]+){2}|step( -?[\d.eE-]+){2}|elasticStep( -?[\d.eE-]+){2}|random( -?[\d.eE-]+){6}|cyclic( -?[\d.eE-]+){5})$/;

export function easingString(e) {
  if (e === undefined || e === null || e === "linear") return undefined;
  if (Array.isArray(e)) return `cubicBezier ${e.map((n) => (Number.isInteger(+n) ? (+n).toFixed(1) : String(+n))).join(" ")}`;
  if (typeof e === "string" && EASING_FORMS.test(e)) return e;
  if (typeof e === "string" && e in EASING) return EASING[e] ?? undefined;
  throw new Error(`unknown easing "${e}" (use ${Object.keys(EASING).join(", ")} or [x1,y1,x2,y2])`);
}

const f6 = (n) => {
  const v = Number(n);
  if (!Number.isFinite(v)) throw new Error(`not a number: ${n}`);
  return (Object.is(v, -0) ? 0 : v).toFixed(6);
};

/** Format a JS value for the wire, given an Alight Motion property type. */
export function formatValue(type, v) {
  switch (type) {
    case "color": return toColor(v);
    case "int": return String(Math.round(Number(v)));
    case "bool": return v === true || v === "true" || v === 1 ? "true" : "false";
    case "string": case "uri": return String(v);
    case "float": return f6(Array.isArray(v) ? v[0] : v);
    default: {
      const arr = typeof v === "string" ? v.split(",").map(Number) : Array.isArray(v) ? v : [v];
      return arr.map(f6).join(",");
    }
  }
}

/** Accepts #RGB, #RRGGBB, #AARRGGBB, [r,g,b(,a)] 0-255 or {r,g,b,a}. Returns #AARRGGBB. */
export function toColor(c) {
  if (Array.isArray(c)) {
    const [r, g, b, a = 255] = c.map((x) => Math.max(0, Math.min(255, Math.round(x))));
    return "#" + [a, r, g, b].map((x) => x.toString(16).padStart(2, "0")).join("").toUpperCase();
  }
  let s = String(c).trim();
  if (!s.startsWith("#")) s = "#" + s;
  const h = s.slice(1);
  if (/^[0-9a-f]{3}$/i.test(h)) return ("#FF" + h.split("").map((x) => x + x).join("")).toUpperCase();
  if (/^[0-9a-f]{6}$/i.test(h)) return ("#FF" + h).toUpperCase();
  if (/^[0-9a-f]{8}$/i.test(h)) return s.toUpperCase();
  throw new Error(`bad color "${c}" (use #RRGGBB or #AARRGGBB)`);
}

/** Parse "#AARRGGBB" into [r,g,b,a] with r,g,b in 0..255 and a in 0..1. */
export function parseColor(s) {
  const h = String(s).replace("#", "");
  if (h.length === 6) return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16), 1];
  return [parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16), parseInt(h.slice(6, 8), 16), parseInt(h.slice(0, 2), 16) / 255];
}

export const cssColor = (s) => {
  const [r, g, b, a] = parseColor(s);
  return `rgba(${r},${g},${b},${+a.toFixed(4)})`;
};

function parseRaw(v) {
  if (v === undefined) return undefined;
  if (v.startsWith("#")) return parseColor(v);
  if (v === "true" || v === "false") return v === "true";
  const parts = v.split(",").map(Number);
  return parts.length === 1 ? parts[0] : parts;
}

/** Read a keyable node into { value } or { keys: [{t, v, e}] } with parsed values. */
export function readKeyable(node) {
  if (!node) return undefined;
  const kfs = kids(node, "kf");
  if (kfs.length === 0) return { value: parseRaw(node.attrs.value), color: node.attrs.value?.startsWith("#") };
  const keys = kfs
    .map((k) => ({ t: Number(k.attrs.t), v: parseRaw(k.attrs.v), e: k.attrs.e }))
    .sort((a, b) => a.t - b.t);
  return { keys, color: kfs[0].attrs.v?.startsWith("#") };
}

/** Solve a CSS-style cubic bezier for y at x. */
export function cubicBezier(x1, y1, x2, y2, x) {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  const bx = (t) => 3 * x1 * t * (1 - t) ** 2 + 3 * x2 * t * t * (1 - t) + t ** 3;
  const by = (t) => 3 * y1 * t * (1 - t) ** 2 + 3 * y2 * t * t * (1 - t) + t ** 3;
  let lo = 0, hi = 1, t = x;
  for (let i = 0; i < 40; i++) {
    const v = bx(t);
    if (Math.abs(v - x) < 1e-6) break;
    if (v < x) lo = t; else hi = t;
    t = (lo + hi) / 2;
  }
  return by(t);
}

// Preview approximations of the app's easing families (bezier is exact).
function ease(e, x) {
  if (!e) return x;
  const parts = e.replace(/^local /, "").split(/\s+/);
  const kind = parts[0] === "reverse" ? "reverse " + parts[1] : parts[0];
  const n = parts.slice(kind.includes(" ") ? 2 : 1).map(Number);
  switch (kind) {
    case "cubicBezier": return cubicBezier(n[0], n[1], n[2], n[3], x);
    case "elastic": case "elasticStep": {
      // decaying overshoot that settles on the target
      const p = 0.3 + 0.4 * (n[0] ?? 0.5);
      return x >= 1 ? 1 : 1 - Math.pow(2, -10 * x) * Math.cos((x * 2 * Math.PI) / p);
    }
    case "reverse elastic": {
      const p = 0.3 + 0.4 * (n[0] ?? 0.5), y = 1 - x;
      return x <= 0 ? 0 : Math.pow(2, -10 * y) * Math.cos((y * 2 * Math.PI) / p);
    }
    case "bounce": {
      let t = x, v;
      if (t < 1 / 2.75) v = 7.5625 * t * t;
      else if (t < 2 / 2.75) v = 7.5625 * (t -= 1.5 / 2.75) * t + 0.75;
      else if (t < 2.5 / 2.75) v = 7.5625 * (t -= 2.25 / 2.75) * t + 0.9375;
      else v = 7.5625 * (t -= 2.625 / 2.75) * t + 0.984375;
      return v;
    }
    case "step": return x < (n[0] ?? 0.5) ? 0 : 1;
    default: return x; // random, cyclic: shown as linear
  }
}

function lerp(a, b, k) {
  if (typeof a === "boolean") return k < 1 ? a : b;
  if (Array.isArray(a)) return a.map((x, i) => x + ((b[i] ?? x) - x) * k);
  return a + (b - a) * k;
}

/** Value of a keyable at normalized layer time u (0..1). */
export function valueAt(k, u, fallback) {
  if (!k) return fallback;
  if (!k.keys) return k.value ?? fallback;
  const ks = k.keys;
  if (u <= ks[0].t) return ks[0].v;
  for (let i = 1; i < ks.length; i++) {
    if (u <= ks[i].t) {
      const a = ks[i - 1], b = ks[i];
      const span = b.t - a.t || 1;
      return lerp(a.v, b.v, ease(b.e, (u - a.t) / span));
    }
  }
  return ks[ks.length - 1].v;
}

/**
 * Build a keyable node.
 * value: a static value, or an array of keyframes {t (0..1), v, ease}.
 */
export function keyableNode(tag, type, value, extraAttrs = {}) {
  if (Array.isArray(value) && value.length && typeof value[0] === "object" && !Array.isArray(value[0]) && "v" in value[0]) {
    const kfs = [...value].sort((a, b) => a.t - b.t).map((k) =>
      el("kf", { t: f6(k.t), v: formatValue(type, k.v), e: easingString(k.ease ?? k.e) }));
    return el(tag, extraAttrs, kfs);
  }
  return el(tag, { ...extraAttrs, value: formatValue(type, value) });
}

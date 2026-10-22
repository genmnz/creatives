// SVG file -> Alight Motion layer specs. Every drawable element becomes a
// custom-path shape layer (the app's own form for imported vector art), with
// its transform baked into the path, its fill and stroke, and a gradient fill
// approximated by the first and last stops. <text> becomes a text layer.

import { parseXml, kids, textOf } from "./xml.mjs";
import { parsePath, formatPath, mapPath, pathBounds } from "./svgpath.mjs";

const NAMED = {
  black: "000000", white: "ffffff", red: "ff0000", green: "008000", blue: "0000ff", yellow: "ffff00", cyan: "00ffff", aqua: "00ffff",
  magenta: "ff00ff", fuchsia: "ff00ff", gray: "808080", grey: "808080", silver: "c0c0c0", maroon: "800000", olive: "808000",
  lime: "00ff00", teal: "008080", navy: "000080", purple: "800080", orange: "ffa500", pink: "ffc0cb", brown: "a52a2a",
  gold: "ffd700", indigo: "4b0082", violet: "ee82ee", coral: "ff7f50", salmon: "fa8072", tomato: "ff6347", crimson: "dc143c",
  darkgray: "a9a9a9", darkgrey: "a9a9a9", lightgray: "d3d3d3", lightgrey: "d3d3d3", whitesmoke: "f5f5f5", beige: "f5f5dc",
  skyblue: "87ceeb", steelblue: "4682b4", royalblue: "4169e1", hotpink: "ff69b4", turquoise: "40e0d0", khaki: "f0e68c",
};

/** CSS color -> [r, g, b, a] or null for none. */
export function parseCssColor(s, current = [0, 0, 0, 1]) {
  if (s === undefined || s === null) return undefined;
  s = String(s).trim().toLowerCase();
  if (s === "none" || s === "transparent") return null;
  if (s === "currentcolor") return current;
  if (NAMED[s]) s = "#" + NAMED[s];
  let m;
  if ((m = /^#([0-9a-f]{3,8})$/.exec(s))) {
    let h = m[1];
    if (h.length === 3 || h.length === 4) h = [...h].map((c) => c + c).join("");
    return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16), h.length === 8 ? parseInt(h.slice(6, 8), 16) / 255 : 1];
  }
  if ((m = /^rgba?\(([^)]*)\)$/.exec(s))) {
    const p = m[1].split(/[\s,/]+/).filter(Boolean).map((v, i) => (v.endsWith("%") ? (parseFloat(v) * (i < 3 ? 255 : 1)) / 100 : parseFloat(v)));
    return [p[0], p[1], p[2], p[3] ?? 1];
  }
  return undefined;
}

const hex2 = (n) => Math.round(Math.max(0, Math.min(255, n))).toString(16).padStart(2, "0").toUpperCase();
const amColor = (c, alpha = 1) => `#${hex2((c[3] ?? 1) * alpha * 255)}${hex2(c[0])}${hex2(c[1])}${hex2(c[2])}`;

// 2D affine matrices as [a, b, c, d, e, f] (SVG order).
const mul = (m, n) => [
  m[0] * n[0] + m[2] * n[1], m[1] * n[0] + m[3] * n[1],
  m[0] * n[2] + m[2] * n[3], m[1] * n[2] + m[3] * n[3],
  m[0] * n[4] + m[2] * n[5] + m[4], m[1] * n[4] + m[3] * n[5] + m[5],
];
const I = [1, 0, 0, 1, 0, 0];

export function parseTransform(s) {
  let m = I;
  const re = /(matrix|translate|scale|rotate|skewX|skewY)\s*\(([^)]*)\)/g;
  let x;
  while ((x = re.exec(s ?? ""))) {
    const a = x[2].split(/[\s,]+/).filter(Boolean).map(Number);
    let t = I;
    switch (x[1]) {
      case "matrix": t = a; break;
      case "translate": t = [1, 0, 0, 1, a[0], a[1] ?? 0]; break;
      case "scale": t = [a[0], 0, 0, a[1] ?? a[0], 0, 0]; break;
      case "rotate": {
        const r = (a[0] * Math.PI) / 180, c = Math.cos(r), sn = Math.sin(r);
        t = [c, sn, -sn, c, 0, 0];
        if (a.length === 3) t = mul(mul([1, 0, 0, 1, a[1], a[2]], t), [1, 0, 0, 1, -a[1], -a[2]]);
        break;
      }
      case "skewX": t = [1, 0, Math.tan((a[0] * Math.PI) / 180), 1, 0, 0]; break;
      case "skewY": t = [1, Math.tan((a[0] * Math.PI) / 180), 0, 1, 0, 0]; break;
    }
    m = mul(m, t);
  }
  return m;
}

const len = (v, ref = 0) => {
  if (v === undefined || v === null || v === "") return undefined;
  const s = String(v).trim();
  if (s.endsWith("%")) return (parseFloat(s) / 100) * ref;
  return parseFloat(s);
};

function shapeD(n) {
  const a = n.attrs;
  switch (n.tag) {
    case "path": return a.d;
    case "rect": {
      const x = len(a.x) ?? 0, y = len(a.y) ?? 0, w = len(a.width) ?? 0, h = len(a.height) ?? 0;
      if (!(w > 0 && h > 0)) return null;
      let rx = len(a.rx), ry = len(a.ry);
      rx = Math.min(rx ?? ry ?? 0, w / 2); ry = Math.min(ry ?? rx ?? 0, h / 2);
      if (!rx || !ry) return `M${x} ${y}H${x + w}V${y + h}H${x}Z`;
      return `M${x + rx} ${y}H${x + w - rx}A${rx} ${ry} 0 0 1 ${x + w} ${y + ry}V${y + h - ry}A${rx} ${ry} 0 0 1 ${x + w - rx} ${y + h}H${x + rx}A${rx} ${ry} 0 0 1 ${x} ${y + h - ry}V${y + ry}A${rx} ${ry} 0 0 1 ${x + rx} ${y}Z`;
    }
    case "circle": case "ellipse": {
      const cx = len(a.cx) ?? 0, cy = len(a.cy) ?? 0;
      const rx = n.tag === "circle" ? len(a.r) : len(a.rx) ?? len(a.ry), ry = n.tag === "circle" ? len(a.r) : len(a.ry) ?? len(a.rx);
      if (!(rx > 0 && ry > 0)) return null;
      return `M${cx - rx} ${cy}A${rx} ${ry} 0 1 0 ${cx + rx} ${cy}A${rx} ${ry} 0 1 0 ${cx - rx} ${cy}Z`;
    }
    case "line": return `M${len(a.x1) ?? 0} ${len(a.y1) ?? 0}L${len(a.x2) ?? 0} ${len(a.y2) ?? 0}`;
    case "polyline": case "polygon": {
      const p = (a.points ?? "").trim().split(/[\s,]+/).filter(Boolean).map(Number);
      if (p.length < 4) return null;
      let d = `M${p[0]} ${p[1]}`;
      for (let i = 2; i + 1 < p.length; i += 2) d += `L${p[i]} ${p[i + 1]}`;
      return n.tag === "polygon" ? d + "Z" : d;
    }
  }
  return null;
}

const INHERITED = ["fill", "stroke", "stroke-width", "fill-opacity", "stroke-opacity", "color", "font-size", "font-family", "font-weight", "text-anchor", "visibility", "stroke-linecap", "stroke-linejoin"];

function parseStyle(s) {
  const o = {};
  for (const part of String(s ?? "").split(";")) {
    const i = part.indexOf(":");
    if (i > 0) o[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return o;
}

/** Simple <style> rules: .class, #id and tag selectors (comma lists allowed). */
function parseCss(text) {
  const rules = [];
  const re = /([^{}]+)\{([^}]*)\}/g;
  let m;
  while ((m = re.exec(text.replace(/\/\*[\s\S]*?\*\//g, "")))) {
    for (const sel of m[1].split(",")) rules.push({ sel: sel.trim(), decl: parseStyle(m[2]) });
  }
  return rules;
}

/**
 * Convert SVG text into layer specs placed on a canvas.
 * opts: { width, height } canvas; fit: "contain" box {x, y, w, h} in canvas px
 *       (default: centered, 80% of the canvas); label prefix.
 */
export function svgToLayers(svgText, opts = {}) {
  const root = parseXml(svgText);
  if (root.tag !== "svg") throw new Error(`root element is <${root.tag}>, expected <svg>`);
  const ids = new Map();
  const index = (n) => { if (n.attrs?.id) ids.set(n.attrs.id, n); n.children?.forEach((c) => c.tag && index(c)); };
  index(root);
  const css = [];
  const collectCss = (n) => { for (const c of n.children ?? []) if (c.tag === "style") css.push(...parseCss(textOf(c))); else if (c.tag) collectCss(c); };
  collectCss(root);

  // viewBox -> canvas box
  const vb = (root.attrs.viewBox ?? "").split(/[\s,]+/).map(Number);
  const W0 = len(root.attrs.width), H0 = len(root.attrs.height);
  const [vx, vy, vw, vh] = vb.length === 4 && vb.every(Number.isFinite) ? vb : [0, 0, W0 || 100, H0 || 100];
  const cw = opts.width ?? 1080, ch = opts.height ?? 1920;
  const box = opts.box ?? { w: cw * 0.8, h: ch * 0.8, x: cw * 0.1, y: ch * 0.1 };
  const k = Math.min(box.w / vw, box.h / vh);
  const base = [k, 0, 0, k, box.x + (box.w - vw * k) / 2 - vx * k, box.y + (box.h - vh * k) / 2 - vy * k];

  const layers = [];
  const skipped = {};
  let count = 0;

  const styleOf = (n, inherited) => {
    const s = { ...inherited };
    for (const r of css) {
      const sel = r.sel;
      const hit = sel.startsWith(".") ? (n.attrs.class ?? "").split(/\s+/).includes(sel.slice(1))
        : sel.startsWith("#") ? n.attrs.id === sel.slice(1) : sel === n.tag;
      if (hit) Object.assign(s, r.decl);
    }
    for (const p of [...INHERITED, "opacity", "display"]) if (n.attrs[p] !== undefined) s[p] = n.attrs[p];
    Object.assign(s, parseStyle(n.attrs.style));
    return s;
  };

  const paint = (value, s, segsAbs, opacity) => {
    if (value === undefined) return undefined;
    const ref = /^url\(\s*#([^)\s]+)\s*\)/.exec(value);
    if (ref) {
      const g = ids.get(ref[1]);
      if (!g) return undefined;
      let stops = kids(g, "stop");
      for (let h = g, guard = 0; !stops.length && guard < 8; guard++) {
        const href = (h.attrs.href ?? h.attrs["xlink:href"] ?? "").replace(/^#/, "");
        h = ids.get(href);
        if (!h) break;
        stops = kids(h, "stop");
      }
      if (!stops.length) return undefined;
      const stopColor = (st) => {
        const ss = { ...st.attrs, ...parseStyle(st.attrs.style) };
        const c = parseCssColor(ss["stop-color"] ?? "black") ?? [0, 0, 0, 0];
        return amColor(c, Number(ss["stop-opacity"] ?? 1) * opacity);
      };
      const user = g.attrs.gradientUnits === "userSpaceOnUse";
      const b = pathBounds(segsAbs.raw);
      const rel = (x, y) => (user ? [(x - b.minX) / (b.w || 1), (y - b.minY) / (b.h || 1)] : [x, y]);
      let start, end;
      if (g.tag === "radialGradient") {
        const cx = len(g.attrs.cx, 1) ?? 0.5, cy = len(g.attrs.cy, 1) ?? 0.5, r = len(g.attrs.r, 1) ?? 0.5;
        start = rel(cx, cy); end = rel(cx + r, cy);
      } else {
        start = rel(len(g.attrs.x1, 1) ?? 0, len(g.attrs.y1, 1) ?? 0);
        end = rel(len(g.attrs.x2, 1) ?? 1, len(g.attrs.y2, 1) ?? 0);
      }
      return { gradient: { type: g.tag === "radialGradient" ? "radial" : "linear", from: stopColor(stops[0]), to: stopColor(stops[stops.length - 1]), start, end } };
    }
    const c = parseCssColor(value, parseCssColor(s.color) ?? [0, 0, 0, 1]);
    if (c === null) return null;
    if (c === undefined) return undefined;
    return amColor(c, opacity);
  };

  const emitPath = (n, d, m, s) => {
    let segs;
    try { segs = parsePath(d); } catch { skipped[n.tag] = (skipped[n.tag] ?? 0) + 1; return; }
    if (!segs.length) return;
    const raw = segs;
    segs = mapPath(segs, (x, y) => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]]);
    const op = Number(s.opacity ?? 1);
    const fillOpacity = Number(s["fill-opacity"] ?? 1) * op, strokeOpacity = Number(s["stroke-opacity"] ?? 1) * op;
    const fill = paint(s.fill ?? "black", s, { raw }, fillOpacity);
    const stroke = paint(s.stroke ?? "none", s, { raw }, strokeOpacity);
    const scale = Math.sqrt(Math.abs(m[0] * m[3] - m[1] * m[2]));
    const spec = { type: "path", d: formatPath(segs), label: `${opts.label ?? "SVG"} ${n.attrs.id ?? n.tag} ${++count}` };
    if (fill === null || fill === undefined) spec.fill = "none";
    else if (typeof fill === "object") spec.gradient = fill.gradient;
    else spec.color = fill;
    if (stroke && typeof stroke === "string") {
      spec.stroke = { color: stroke, width: +(len(s["stroke-width"]) ?? 1) * scale };
      if (s["stroke-linecap"] && s["stroke-linecap"] !== "butt") spec.stroke.cap = s["stroke-linecap"];
    } else if (stroke && typeof stroke === "object") {
      spec.stroke = { color: stroke.gradient.from, width: +(len(s["stroke-width"]) ?? 1) * scale };
    }
    if (spec.fill === "none" && !spec.stroke) return; // invisible
    layers.push(spec);
  };

  const walk = (n, m, inherited) => {
    if (!n.tag) return;
    if (["defs", "clipPath", "mask", "symbol", "style", "title", "desc", "metadata", "linearGradient", "radialGradient", "pattern", "filter", "marker"].includes(n.tag)) return;
    const s = styleOf(n, inherited);
    if (s.display === "none" || s.visibility === "hidden") return;
    const mm = mul(m, parseTransform(n.attrs.transform));
    const childInherit = Object.fromEntries(INHERITED.filter((p) => s[p] !== undefined).map((p) => [p, s[p]]));
    // Group opacity is not inherited in SVG, but multiplying it into children is the closest flat equivalent.
    if (n.tag === "g" || n.tag === "svg" || n.tag === "a") {
      const gOp = Number(s.opacity ?? 1);
      for (const c of n.children) walk(c, mm, gOp !== 1 ? { ...childInherit, opacity: String(gOp * Number(c.attrs?.opacity ?? 1)) } : childInherit);
      return;
    }
    if (n.tag === "use") {
      const ref = ids.get((n.attrs.href ?? n.attrs["xlink:href"] ?? "").replace(/^#/, ""));
      if (!ref) return;
      const t = mul(mm, [1, 0, 0, 1, len(n.attrs.x) ?? 0, len(n.attrs.y) ?? 0]);
      if (ref.tag === "symbol") for (const c of ref.children) walk(c, t, childInherit);
      else walk(ref, t, childInherit);
      return;
    }
    if (n.tag === "text") {
      const content = textOf(n).replace(/\s+/g, " ").trim();
      if (!content) return;
      const x = len(n.attrs.x) ?? 0, y = len(n.attrs.y) ?? 0, size = (len(s["font-size"]) ?? 16) * Math.sqrt(Math.abs(mm[0] * mm[3] - mm[1] * mm[2]));
      const fill = paint(s.fill ?? "black", s, { raw: [{ c: "M", p: [x, y] }] }, Number(s.opacity ?? 1));
      const anchor = s["text-anchor"] === "middle" ? "center" : s["text-anchor"] === "end" ? "right" : "left";
      const px = mm[0] * x + mm[2] * y + mm[4], py = mm[1] * x + mm[3] * y + mm[5] - size * 0.35;
      const family = (s["font-family"] ?? "Roboto").split(",")[0].replace(/['"]/g, "").trim();
      const wrap = Math.max(size * content.length * 0.7, 100);
      const offset = anchor === "left" ? wrap / 2 : anchor === "right" ? -wrap / 2 : 0;
      layers.push({ type: "text", text: content, size: +size.toFixed(2), font: family, weight: Number(s["font-weight"] === "bold" ? 700 : s["font-weight"] ?? 400) || 400, align: anchor, wrapWidth: Math.round(wrap), x: +(px + offset).toFixed(2), y: +py.toFixed(2), color: typeof fill === "string" ? fill : "#FF000000", label: `${opts.label ?? "SVG"} text ${++count}` });
      return;
    }
    const d = shapeD(n);
    if (d) emitPath(n, d, mm, s);
    else if (!["path", "rect", "circle", "ellipse", "line", "polyline", "polygon"].includes(n.tag)) skipped[n.tag] = (skipped[n.tag] ?? 0) + 1;
  };

  walk(root, base, {});
  return { layers, skipped, scale: k };
}

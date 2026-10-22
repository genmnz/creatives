// Render one frame of a scene to SVG. A preview, not a pixel match: geometry,
// fills, gradients, strokes, images, text, transforms, parenting, nesting and
// keyframes are drawn; of the effects only blur is approximated.

import { kid, kids, textOf } from "./xml.mjs";
import { readKeyable, valueAt, cssColor, parseColor } from "./anim.mjs";
import { templatePath } from "./shapes.mjs";
import { findShape, paramDefault } from "./catalog.mjs";
import { parsePath, pathBounds } from "./svgpath.mjs";
import { escapeAttr, escapeText } from "./xml.mjs";

const ELEMENTS = new Set(["shape", "text", "drawing", "embedScene", "audio", "camera", "nullobj"]);
const CSS_BLEND = {
  multiply: "multiply", screen: "screen", overlay: "overlay", darken: "darken", lighten: "lighten",
  "color-dodge": "color-dodge", "color-burn": "color-burn", "hard-light": "hard-light", "soft-light": "soft-light",
  diff: "difference", difference: "difference", exclusion: "exclusion", hue: "hue", saturation: "saturation",
  color: "color", luminance: "luminosity", "linear-dodge": "plus-lighter",
};

const n3 = (x) => +Number(x).toFixed(3);

export function fontFamily(desc) {
  const m = /name=([^&]+)/.exec(desc ?? "");
  const weight = /weight=(\d+)/.exec(desc ?? "")?.[1] ?? "400";
  return { family: m ? decodeURIComponent(m[1]) : "Roboto", weight };
}

function layerU(node, tMs) {
  const s = Number(node.attrs.startTime), e = Number(node.attrs.endTime);
  return Math.min(1, Math.max(0, (tMs - s) / Math.max(1, e - s)));
}

function transformOf(node, u) {
  const tr = kid(node, "transform");
  const get = (tag, d) => valueAt(readKeyable(kid(tr, tag)), u, d);
  const loc = get("location", [0, 0, 0]);
  const pivot = get("pivot", [0, 0]);
  const scale = get("scale", [1, 1]);
  const skew = get("skew", [0, 0]);
  const rot = get("rotation", 0);
  const opacity = get("opacity", 1);
  let t = `translate(${n3(loc[0])} ${n3(loc[1])})`;
  if (rot) t += ` rotate(${n3(rot)})`;
  if (skew[0]) t += ` skewX(${n3(skew[0])})`;
  if (skew[1]) t += ` skewY(${n3(skew[1])})`;
  if (scale[0] !== 1 || scale[1] !== 1) t += ` scale(${n3(scale[0])} ${n3(scale[1])})`;
  if (pivot[0] || pivot[1]) t += ` translate(${n3(-pivot[0])} ${n3(-pivot[1])})`;
  return { t, opacity };
}

function shapeParams(node, u) {
  const tpl = findShape(node.attrs.s);
  const params = {};
  for (const p of tpl?.params ?? []) params[p.id] = paramDefault(p);
  for (const p of kids(node, "property")) params[p.attrs.name] = valueAt(readKeyable(p), u, params[p.attrs.name]);
  return params;
}

export function renderSVG(sceneNode, tSec, opts = {}) {
  const ctx = { defs: [], uid: 0, mediaHref: opts.mediaHref ?? (() => null), media: new Map() };
  for (const m of kids(sceneNode, "media")) ctx.media.set(m.attrs.uri, m.attrs);
  const W = Number(sceneNode.attrs.width), H = Number(sceneNode.attrs.height);
  const body = renderScene(sceneNode, tSec * 1000, ctx, true);
  const size = opts.width ? ` width="${opts.width}" height="${Math.round((opts.width * H) / W)}"` : "";
  return `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 ${W} ${H}"${size}>` +
    `<defs>${ctx.defs.join("")}</defs>${body}</svg>`;
}

function renderScene(scene, tMs, ctx, isRoot) {
  const W = Number(scene.attrs.width), H = Number(scene.attrs.height);
  const bg = scene.attrs.bgcolor ?? "#FF000000";
  let out = "";
  const [, , , a] = parseColor(bg);
  if (a > 0) out += `<rect width="${W}" height="${H}" fill="${cssColor(bg)}"/>`;
  else if (isRoot) {
    const id = `chk${ctx.uid++}`;
    ctx.defs.push(`<pattern id="${id}" width="40" height="40" patternUnits="userSpaceOnUse"><rect width="40" height="40" fill="#cfcfcf"/><rect width="20" height="20" fill="#f2f2f2"/><rect x="20" y="20" width="20" height="20" fill="#f2f2f2"/></pattern>`);
    out += `<rect width="${W}" height="${H}" fill="url(#${id})"/>`;
  }
  const els = scene.children.filter((c) => c.tag && ELEMENTS.has(c.tag));
  const byId = new Map(els.map((e) => [e.attrs.id, e]));
  for (const node of els) {
    if (node.attrs.hidden === "true") continue;
    const s = Number(node.attrs.startTime), e = Number(node.attrs.endTime);
    if (tMs < s || tMs >= e) continue;
    let g = renderElement(node, tMs, ctx);
    if (!g) continue;
    // Parent chain: wrap in each ancestor's transform (not its opacity).
    let p = byId.get(node.attrs.parent), guard = 0;
    while (p && guard++ < 32) {
      g = `<g transform="${transformOf(p, layerU(p, tMs)).t}">${g}</g>`;
      p = byId.get(p.attrs.parent);
    }
    out += g;
  }
  return out;
}

function fillFor(node, u, ctx, d) {
  const ft = node.attrs.fillType ?? "color";
  if (ft === "none") return { fill: "none" };
  if (ft === "gradient") {
    const g = kid(node, "gradient");
    const id = `g${ctx.uid++}`;
    const sc = cssColor(g?.attrs.startColor ?? "#FF000000"), ec = cssColor(g?.attrs.endColor ?? "#FFFFFFFF");
    const [x1, y1] = (g?.attrs.start ?? "0,0").split(",").map(Number);
    const [x2, y2] = (g?.attrs.end ?? "1,1").split(",").map(Number);
    const stops = `<stop offset="0" stop-color="${sc}"/><stop offset="1" stop-color="${ec}"/>`;
    if (g?.attrs.type === "radial") {
      ctx.defs.push(`<radialGradient id="${id}" cx="${x1}" cy="${y1}" r="${n3(Math.hypot(x2 - x1, y2 - y1))}">${stops}</radialGradient>`);
    } else {
      ctx.defs.push(`<linearGradient id="${id}" x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}">${stops}</linearGradient>`);
    }
    return { fill: `url(#${id})` };
  }
  if (ft === "media" && (node.attrs.fillImage || node.attrs.fillVideo)) {
    const uri = node.attrs.fillImage ?? node.attrs.fillVideo;
    const href = ctx.mediaHref(uri, ctx.media.get(uri));
    const b = pathBounds(parsePath(d));
    const clip = `c${ctx.uid++}`;
    ctx.defs.push(`<clipPath id="${clip}"><path d="${escapeAttr(d)}"/></clipPath>`);
    const par = node.attrs.mediaFillMode === "stretch" ? "none" : node.attrs.mediaFillMode === "fit" ? "xMidYMid meet" : "xMidYMid slice";
    const img = href
      ? `<image href="${escapeAttr(href)}" x="${n3(b.minX)}" y="${n3(b.minY)}" width="${n3(b.w)}" height="${n3(b.h)}" preserveAspectRatio="${par}"/>`
      : `<rect x="${n3(b.minX)}" y="${n3(b.minY)}" width="${n3(b.w)}" height="${n3(b.h)}" fill="#6b7280"/><text x="0" y="0" text-anchor="middle" font-size="${n3(Math.max(14, b.h / 14))}" fill="#e5e7eb" font-family="sans-serif">${escapeText(ctx.media.get(uri)?.title ?? "missing media")}</text>`;
    return { media: `<g clip-path="url(#${clip})">${img}</g>`, fill: "none" };
  }
  const fc = valueAt(readKeyable(kid(node, "fillColor")), u, [255, 255, 255, 1]);
  return { fill: Array.isArray(fc) ? `rgba(${fc.slice(0, 3).map(Math.round).join(",")},${n3(fc[3])})` : "#fff" };
}

function strokeFor(node, u) {
  const ps = kid(node, "path-stroke") ?? kid(node, "border");
  if (!ps || ps.attrs.enabled === "false") return "";
  const c = valueAt(readKeyable(kid(ps, "color")), u, null) ?? (ps.attrs.color ? parseColor(ps.attrs.color) : [255, 255, 255, 1]);
  const w = valueAt(readKeyable(kid(ps, "size")), u, null) ?? Number(ps.attrs.size ?? 4);
  return ` stroke="rgba(${c.slice(0, 3).map(Math.round).join(",")},${n3(c[3])})" stroke-width="${n3(w)}" stroke-linejoin="round" stroke-linecap="round"`;
}

function effectsFilter(node, u, ctx) {
  let out = "";
  for (const fx of kids(node, "effect")) {
    if (fx.attrs.hidden === "true") continue;
    const id = fx.attrs.id;
    const prop = (name, d) => {
      const p = kids(fx, "property").find((x) => x.attrs.name === name);
      return p ? valueAt(readKeyable(p), u, d) : d;
    };
    if (/gaussianblur|boxblur|\.blur$|fastblur/.test(id)) {
      const s = Number(prop("strength", prop("radius", 0.15))) * 40;
      if (s > 0.1) out += `<feGaussianBlur stdDeviation="${n3(s)}"/>`;
    }
  }
  if (!out) return "";
  const fid = `f${ctx.uid++}`;
  ctx.defs.push(`<filter id="${fid}" x="-50%" y="-50%" width="200%" height="200%">${out}</filter>`);
  return ` filter="url(#${fid})"`;
}

function fxParam(node, idTail, name, u, d) {
  const fx = kids(node, "effect").find((f) => f.attrs.hidden !== "true" && f.attrs.id.endsWith(idTail));
  if (!fx) return undefined;
  const p = kids(fx, "property").find((x) => x.attrs.name === name);
  return p ? valueAt(readKeyable(p), u, d) : d;
}

function wrapLines(text, size, wrap) {
  const avg = size * 0.55, max = Math.max(1, Math.floor(wrap / avg));
  const lines = [];
  for (const para of text.split("\n")) {
    let line = "";
    for (const w of para.split(/\s+/)) {
      if (line && (line + " " + w).length > max) { lines.push(line); line = w; } else line = line ? line + " " + w : w;
    }
    lines.push(line);
  }
  return lines;
}

function renderElement(node, tMs, ctx) {
  const u = layerU(node, tMs);
  const { t, opacity } = transformOf(node, u);
  const blend = CSS_BLEND[node.attrs.blending];
  const style = blend ? ` style="mix-blend-mode:${blend}"` : "";
  const filter = effectsFilter(node, u, ctx);
  const fxList = kids(node, "effect").map((f) => f.attrs.id.split(".").pop()).join(" ");
  const meta = ` data-id="${escapeAttr(node.attrs.id)}" data-label="${escapeAttr(node.attrs.label ?? "")}"${fxList ? ` data-fx="${escapeAttr(fxList)}"` : ""}`;
  let inner = "";
  switch (node.tag) {
    case "shape": {
      const d = kid(node, "path")?.attrs.d ?? (node.attrs.s ? templatePath(node.attrs.s, shapeParams(node, u)) : null);
      if (!d) return "";
      const f = fillFor(node, u, ctx, d);
      // Drawing Progress trims the outline: draw it with a dash over a 0..100 path length.
      const ds = fxParam(node, "drawing.progress", "start", u, 0), de = fxParam(node, "drawing.progress", "end", u, 100);
      const dash = ds === undefined ? "" : ` pathLength="100" stroke-dasharray="0 ${n3(ds)} ${n3(Math.max(0, de - ds))} 200"`;
      inner = (f.media ?? "") + `<path d="${escapeAttr(d)}" fill="${f.fill}"${strokeFor(node, u)}${dash}/>`;
      break;
    }
    case "text": {
      const size = Number(node.attrs.size ?? 18);
      const wrap = Number(node.attrs.wrapWidth ?? 512);
      const { family, weight } = fontFamily(node.attrs.font);
      let content = textOf(kid(node, "content"));
      const ts = fxParam(node, "textprogress", "start", u, 0), te = fxParam(node, "textprogress", "end", u, 1);
      if (ts !== undefined) content = content.slice(Math.round(ts * content.length), Math.round(te * content.length));
      const lines = wrapLines(content, size, wrap);
      const lh = size * 1.2;
      const align = node.attrs.align ?? "left";
      const anchor = align === "center" ? "middle" : align === "right" ? "end" : "start";
      const x = align === "center" ? 0 : align === "right" ? wrap / 2 : -wrap / 2;
      const y0 = -((lines.length - 1) * lh) / 2;
      const f = fillFor(node, u, ctx, `M ${-wrap / 2} ${-size} L ${wrap / 2} ${size}`);
      inner = `<text text-anchor="${anchor}" dominant-baseline="central" font-family="'${escapeAttr(family)}', sans-serif" font-weight="${weight}" font-size="${n3(size)}" fill="${f.fill}"${strokeFor(node, u)} paint-order="stroke">` +
        lines.map((l, i) => `<tspan x="${n3(x)}" y="${n3(y0 + i * lh)}">${escapeText(l)}</tspan>`).join("") + "</text>";
      break;
    }
    case "drawing": {
      for (const s of kids(node, "stroke")) {
        const pts = (s.attrs.points ?? "").split(";").filter(Boolean).map((p) => p.split(",").map(Number));
        if (!pts.length) continue;
        inner += `<path d="M ${pts.map((p) => `${n3(p[0])} ${n3(p[1])}`).join(" L ")}" fill="none" stroke="${cssColor(s.attrs.color ?? "#FFFFFFFF")}" stroke-width="${n3(s.attrs.width ?? 4)}" stroke-linecap="round" stroke-linejoin="round"/>`;
      }
      const d = kid(node, "path")?.attrs.d;
      if (d) inner += `<path d="${escapeAttr(d)}" fill="none"${strokeFor(node, u) || ' stroke="#fff" stroke-width="4"'}/>`;
      break;
    }
    case "embedScene": {
      const sc = kid(node, "scene");
      if (!sc) return "";
      const w = Number(sc.attrs.width), h = Number(sc.attrs.height);
      const clip = `c${ctx.uid++}`;
      ctx.defs.push(`<clipPath id="${clip}"><rect width="${w}" height="${h}"/></clipPath>`);
      inner = `<g transform="translate(${-w / 2} ${-h / 2})" clip-path="url(#${clip})">${renderScene(sc, tMs - Number(node.attrs.startTime), ctx, false)}</g>`;
      break;
    }
    default:
      return "";
  }
  const op = opacity < 1 ? ` opacity="${n3(Math.max(0, opacity))}"` : "";
  return `<g${meta} transform="${t}"${op}${style}${filter}>${inner}</g>`;
}

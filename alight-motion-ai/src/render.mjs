// Render one frame of a scene to SVG. A preview, not a pixel match: geometry,
// fills, gradients, strokes, borders, shadows, images, text, transforms,
// parenting, nesting, blending, masks and keyframes are drawn; the common
// effects are approximated in fxpreview.mjs.

import { kid, kids, textOf } from "./xml.mjs";
import { readKeyable, valueAt, cssColor, parseColor } from "./anim.mjs";
import { templatePath } from "./shapes.mjs";
import { findShape, paramDefault } from "./catalog.mjs";
import { parsePath, pathBounds } from "./svgpath.mjs";
import { escapeAttr, escapeText } from "./xml.mjs";
import { effectPlan, decorationFilter } from "./fxpreview.mjs";

const ELEMENTS = new Set(["shape", "text", "drawing", "embedScene", "audio", "camera", "nullobj"]);
const CSS_BLEND = {
  multiply: "multiply", screen: "screen", overlay: "overlay", darken: "darken", lighten: "lighten",
  "color-dodge": "color-dodge", "color-burn": "color-burn", "hard-light": "hard-light", "soft-light": "soft-light",
  diff: "difference", difference: "difference", exclusion: "exclusion", hue: "hue", saturation: "saturation",
  color: "color", luminance: "luminosity", "linear-dodge": "plus-lighter",
  // Alight Motion modes without a CSS twin get the closest one.
  exclude: "exclusion", subtract: "difference", "soft-overlay": "soft-light", "linear-burn": "color-burn",
  "lighter-color": "lighten", "darker-color": "darken", "vivid-light": "hard-light", "linear-light": "hard-light",
  "pin-light": "hard-light", divide: "color-dodge",
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

function transformOf(node, u, fx) {
  const tr = kid(node, "transform");
  const get = (tag, d) => valueAt(readKeyable(kid(tr, tag)), u, d);
  const loc = get("location", [0, 0, 0]);
  const pivot = get("pivot", [0, 0]);
  const scale = get("scale", [1, 1]);
  const skew = get("skew", [0, 0]);
  const rot = get("rotation", 0) + (fx?.rotate ?? 0);
  const opacity = get("opacity", 1) * (fx?.opacity ?? 1);
  const sx = scale[0] * (fx?.scale[0] ?? 1), sy = scale[1] * (fx?.scale[1] ?? 1);
  let t = `translate(${n3(loc[0] + (fx?.move[0] ?? 0))} ${n3(loc[1] + (fx?.move[1] ?? 0))})`;
  if (rot) t += ` rotate(${n3(rot)})`;
  for (const st of fx?.stretches ?? []) if (st.scale !== 1) t += ` rotate(${n3(st.angle)}) scale(${n3(st.scale)} 1) rotate(${n3(-st.angle)})`;
  if (skew[0]) t += ` skewX(${n3(skew[0])})`;
  if (skew[1]) t += ` skewY(${n3(skew[1])})`;
  if (sx !== 1 || sy !== 1) t += ` scale(${n3(sx)} ${n3(sy)})`;
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
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 ${W} ${H}"${size}>` +
    `<defs>${ctx.defs.join("")}</defs>${body}</svg>`;
  // Several frames inlined in one HTML page need distinct ids.
  const p = opts.idPrefix;
  return p ? svg.replace(/\bid="([^"]+)"/g, `id="${p}$1"`).replace(/url\(#([^)]+)\)/g, `url(#${p}$1)`) : svg;
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
  let layers = "";
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
    // Mask blending: this layer's alpha cuts out everything below it in the same scene.
    if (node.attrs.blending === "mask") {
      const id = `m${ctx.uid++}`;
      ctx.defs.push(`<mask id="${id}" style="mask-type:alpha" maskUnits="userSpaceOnUse" x="0" y="0" width="${W}" height="${H}">${g}</mask>`);
      layers = `<g mask="url(#${id})">${layers}</g>`;
      continue;
    }
    layers += g;
  }
  return out + layers;
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
  const ps = kid(node, "path-stroke");
  if (!ps || ps.attrs.enabled === "false") return "";
  const c = valueAt(readKeyable(kid(ps, "color")), u, null) ?? (ps.attrs.color ? parseColor(ps.attrs.color) : [255, 255, 255, 1]);
  const w = valueAt(readKeyable(kid(ps, "size")), u, null) ?? Number(ps.attrs.size ?? 4);
  return ` stroke="rgba(${c.slice(0, 3).map(Math.round).join(",")},${n3(c[3])})" stroke-width="${n3(w)}" stroke-linejoin="round" stroke-linecap="round"`;
}

// <border direction="inside|outside|centered"> drawn around the shape outline.
function borders(node, u, d, ctx) {
  let under = "", over = "";
  for (const b of kids(node, "border")) {
    if (b.attrs.enabled === "false") continue;
    const c = valueAt(readKeyable(kid(b, "color")), u, null) ?? (b.attrs.color ? parseColor(b.attrs.color) : [0, 0, 0, 1]);
    const w = Number(valueAt(readKeyable(kid(b, "size")), u, null) ?? b.attrs.size ?? 4);
    const paint = `fill="none" stroke="rgba(${c.slice(0, 3).map(Math.round).join(",")},${n3(c[3])})" stroke-linejoin="round"`;
    if (b.attrs.direction === "outside") under += `<path d="${escapeAttr(d)}" ${paint} stroke-width="${n3(2 * w)}"/>`;
    else if (b.attrs.direction === "centered") over += `<path d="${escapeAttr(d)}" ${paint} stroke-width="${n3(w)}"/>`;
    else {
      const clip = `c${ctx.uid++}`;
      ctx.defs.push(`<clipPath id="${clip}"><path d="${escapeAttr(d)}"/></clipPath>`);
      over += `<path d="${escapeAttr(d)}" ${paint} stroke-width="${n3(2 * w)}" clip-path="url(#${clip})"/>`;
    }
  }
  return { under, over };
}

// Wipe effects as a gradient mask in the layer's bounding box.
function wipeMask(wipes, ctx) {
  let attr = "";
  for (const w of wipes) {
    const lo = Math.min(w.start, w.end), hi = Math.max(w.start, w.end), f = Math.max(0.001, w.feather);
    const g = `w${ctx.uid++}`, m = `m${ctx.uid++}`;
    ctx.defs.push(`<linearGradient id="${g}" gradientTransform="rotate(${n3(w.angle)} .5 .5)"><stop offset="${n3(lo - f)}" stop-color="#000"/><stop offset="${n3(lo)}" stop-color="#fff"/><stop offset="${n3(hi)}" stop-color="#fff"/><stop offset="${n3(hi + f)}" stop-color="#000"/></linearGradient>`);
    ctx.defs.push(`<mask id="${m}" maskContentUnits="objectBoundingBox"><rect width="1" height="1" fill="url(#${g})"/></mask>`);
    attr = m;
  }
  return attr;
}

function tiled(inner, d, tile) {
  if (!d) return inner;
  const b = pathBounds(parsePath(d));
  const w = b.w * (tile.scale || 1), h = b.h * (tile.scale || 1);
  let out = "";
  for (let i = -2; i <= 2; i++) for (let j = -2; j <= 2; j++) {
    const flip = tile.mirror ? ` scale(${i % 2 ? -1 : 1} ${j % 2 ? -1 : 1})` : "";
    out += `<g transform="translate(${n3(i * w)} ${n3(j * h)})${flip}">${inner}</g>`;
  }
  return out;
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
  if (node.tag === "camera" || node.tag === "nullobj" || node.tag === "audio") return "";
  const u = layerU(node, tMs);
  const start = Number(node.attrs.startTime), end = Number(node.attrs.endTime);
  const uid = `x${ctx.uid++}`;
  const fx = effectPlan(node, u, (tMs - start) / 1000, (end - start) / 1000, uid);
  const { t, opacity } = transformOf(node, u, fx);
  const blend = CSS_BLEND[node.attrs.blending];
  const style = blend ? ` style="mix-blend-mode:${blend}"` : "";
  const deco = decorationFilter(node, u, uid, fx.filterOut);
  let filter = "";
  if (fx.filter || deco.filter) {
    const fid = `f${uid}`;
    ctx.defs.push(`<filter id="${fid}" x="-100%" y="-100%" width="300%" height="300%" filterUnits="objectBoundingBox" color-interpolation-filters="sRGB">${fx.filter}${deco.filter}</filter>`);
    filter = ` filter="url(#${fid})"`;
  }
  const fxList = kids(node, "effect").map((f) => f.attrs.id.split(".").pop()).join(" ");
  const meta = ` data-id="${escapeAttr(node.attrs.id)}" data-label="${escapeAttr(node.attrs.label ?? "")}"${fxList ? ` data-fx="${escapeAttr(fxList)}"` : ""}${fx.skipped.length ? ` data-unpreviewed="${escapeAttr(fx.skipped.join(" "))}"` : ""}`;
  let inner = "";
  switch (node.tag) {
    case "shape": {
      const d = kid(node, "path")?.attrs.d ?? (node.attrs.s ? templatePath(node.attrs.s, shapeParams(node, u)) : null);
      if (!d) return "";
      const f = fillFor(node, u, ctx, d);
      // Drawing Progress trims the outline: draw it with a dash over a 0..100 path length.
      const ds = fxParam(node, "drawing.progress", "start", u, 0), de = fxParam(node, "drawing.progress", "end", u, 100);
      const dash = ds === undefined ? "" : ` pathLength="100" stroke-dasharray="0 ${n3(ds)} ${n3(Math.max(0, de - ds))} 200"`;
      const bd = borders(node, u, d, ctx);
      inner = bd.under + (f.media ?? "") + `<path d="${escapeAttr(d)}" fill="${f.fill}"${strokeFor(node, u)}${dash}/>` + bd.over;
      if (fx.tile) inner = tiled(inner, d, fx.tile);
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
      const local = (tMs - start) * Number(node.attrs.speed ?? 1) + Number(node.attrs.inTime ?? 0);
      inner = `<g transform="translate(${-w / 2} ${-h / 2})" clip-path="url(#${clip})">${renderScene(sc, local, ctx, false)}</g>`;
      break;
    }
    default:
      return "";
  }
  const mask = fx.wipes.length ? wipeMask(fx.wipes, ctx) : "";
  if (mask) inner = `<g mask="url(#${mask})">${inner}</g>`;
  const op = opacity < 1 ? ` opacity="${n3(Math.max(0, opacity))}"` : "";
  // The filter sits outside the layer transform so blur and shadow sizes are canvas pixels.
  const body = `<g transform="${t}">${inner}</g>`;
  return `<g${meta}${op}${style}${filter}>${body}</g>`;
}

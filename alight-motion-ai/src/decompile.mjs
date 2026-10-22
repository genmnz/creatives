// Turn project XML back into the friendly design spec (the JSON the builder
// takes), so an AI can read a project in seconds, pixels and full sizes, edit
// the JSON, and rebuild it. Everything the friendly form has no field for is
// kept verbatim: unknown attributes go to `attrs`, unknown children to `keep`
// (raw XML), and whole layers the builder cannot make (camera, audio, drawing)
// become {"type": "xml"}. buildFromSpec(toSpec(x)) renders the same as x.

import { kid, kids, textOf, serializeXml } from "./xml.mjs";
import { EASING } from "./anim.mjs";
import { findEffect, findShape } from "./catalog.mjs";

const EASE_NAME = Object.fromEntries(Object.entries(EASING).filter(([, v]) => v).map(([k, v]) => [v, k]));
const TRANSFORM_FIELDS = { location: "position", scale: "scale", rotation: "rotation", opacity: "opacity", pivot: "pivot", skew: "skew" };
const raw = (n) => serializeXml(n, { header: false }).trim();

function num(v) {
  if (v === undefined) return undefined;
  if (v.startsWith("#")) return v;
  if (v === "true" || v === "false") return v === "true";
  const parts = v.split(",").map(Number);
  if (parts.some((x) => !Number.isFinite(x))) return v;
  return parts.length === 1 ? parts[0] : parts;
}

/** A keyable node as a value or a keyframe list; t stays a fraction (exact), at is added for reading. */
function keyable(node, durSec) {
  const kfs = kids(node, "kf");
  if (!kfs.length) return num(node.attrs.value);
  return kfs.map((k) => {
    const o = { t: Number(k.attrs.t), v: num(k.attrs.v) };
    if (k.attrs.e) o.ease = EASE_NAME[k.attrs.e] ?? k.attrs.e;
    o.at = +(o.t * durSec).toFixed(3);
    return o;
  });
}

function stripVec3(v) {
  // position z of 0 reads better as [x, y]
  if (Array.isArray(v) && v.length === 3 && typeof v[0] === "number" && v[2] === 0) return [v[0], v[1]];
  if (Array.isArray(v) && v.length && typeof v[0] === "object") return v.map((k) => ({ ...k, v: stripVec3(k.v) }));
  return v;
}

function effectsOf(node, durSec) {
  const fxs = kids(node, "effect");
  const friendly = fxs.map((fx) => {
    const def = findEffect(fx.attrs.id);
    if (!def || def.id !== fx.attrs.id) return null;
    const extra = Object.keys(fx.attrs).filter((a) => !["id", "hidden", "locallyApplied"].includes(a));
    if (extra.length || fx.attrs.locallyApplied !== "true") return null;
    const params = {};
    for (const c of fx.children.filter((x) => x.tag)) {
      if (c.tag !== "property") return null;
      const p = def.params.find((x) => x.id === c.attrs.name);
      if (!p || p.type !== c.attrs.type || Object.keys(c.attrs).length !== 3 - (c.attrs.value === undefined ? 1 : 0)) return null;
      params[c.attrs.name] = keyable(c, durSec);
    }
    const o = { effect: def.id };
    if (Object.keys(params).length) o.params = params;
    if (fx.attrs.hidden === "true") o.hidden = true;
    return o;
  });
  // All or nothing, so the effect stack keeps its order.
  return friendly.every(Boolean) ? { effects: friendly } : { keep: fxs.map(raw) };
}

const COMMON_ATTRS = ["id", "label", "startTime", "endTime", "hidden", "blending", "parent"];

function layerSpec(l) {
  const a = l.attrs;
  const durSec = (Number(a.endTime) - Number(a.startTime)) / 1000;
  const type = l.tag === "text" ? "text" : l.tag === "nullobj" ? "null" : l.tag === "embedScene" && kid(l, "scene") ? "group"
    : l.tag === "shape" ? (a.s && !kid(l, "path") ? "shape" : kid(l, "path") ? "path" : null) : null;
  if (!type) return { type: "xml", xml: raw(l) };

  const spec = { type, id: a.id, label: a.label, start: Number(a.startTime) / 1000, end: Number(a.endTime) / 1000 };
  if (a.hidden === "true") spec.hidden = true;
  if (a.blending) spec.blend = a.blending;
  if (a.parent) spec.parent = a.parent;
  const used = new Set(COMMON_ATTRS);
  const keep = [];

  const tr = kid(l, "transform");
  const trExtra = tr && (Object.keys(tr.attrs).length || tr.children.some((c) => c.tag && !TRANSFORM_FIELDS[c.tag]));
  if (trExtra) keep.push(raw(tr));
  else for (const c of tr?.children.filter((x) => x.tag) ?? []) spec[TRANSFORM_FIELDS[c.tag]] = c.tag === "location" ? stripVec3(keyable(c, durSec)) : keyable(c, durSec);
  if (spec.position === undefined && !trExtra) spec.position = null; // no location in the file (the builder would center the layer)

  // fill (text and shapes; groups and nulls keep theirs verbatim)
  const ft = a.fillType;
  const fills = type !== "group" && type !== "null" && [undefined, "color", "gradient", "none", "media"].includes(ft);
  if (fills) {
    used.add("fillType");
    if (ft === "none") spec.fill = "none";
    else if (ft === "gradient") {
      // The app omits a default gradient (black to white, 0,0 to 1,1).
      const g = kid(l, "gradient")?.attrs ?? { type: "linear", startColor: "#FF000000", endColor: "#FFFFFFFF", start: "0,0", end: "1,1" };
      spec.gradient = { type: g.type, from: g.startColor, to: g.endColor, start: num(g.start), end: num(g.end) };
    } else if (ft === "media" && (a.fillImage || a.fillVideo)) {
      spec.image = a.fillImage ? { media: a.fillImage } : { media: a.fillVideo, video: true };
      used.add(a.fillImage ? "fillImage" : "fillVideo");
    }
    if (kid(l, "fillColor") && ft !== "media") spec.color = keyable(kid(l, "fillColor"), durSec);
    else if (kid(l, "fillColor")) keep.push(raw(kid(l, "fillColor")));
    else if (ft !== "media" && ft !== "none") (spec.drop ??= []).push("fillColor");
    if (ft !== "gradient" && kid(l, "gradient")) keep.push(raw(kid(l, "gradient")));
  } else {
    if (kid(l, "fillColor")) keep.push(raw(kid(l, "fillColor")));
    if (kid(l, "gradient")) keep.push(raw(kid(l, "gradient")));
  }

  const fx = effectsOf(l, durSec);
  if (fx.effects?.length) spec.effects = fx.effects;
  if (fx.keep) keep.push(...fx.keep);

  if (type === "text") {
    spec.text = textOf(kid(l, "content"));
    if (a.size !== undefined) spec.size = Number(a.size);
    if (a.font !== undefined) spec.fontDescriptor = a.font;
    if (a.wrapWidth !== undefined) spec.wrapWidth = Number(a.wrapWidth);
    if (a.align !== undefined) spec.align = a.align;
    for (const k of ["size", "font", "wrapWidth", "align"]) used.add(k);
  }
  if (type === "shape") {
    const tpl = findShape(a.s);
    spec.shape = a.s;
    used.add("s");
    spec.params = {};
    for (const p of kids(l, "property")) spec.params[p.attrs.name] = keyable(p, durSec);
    spec.exactParams = true; // only the parameters written in the file
    if (!tpl) return { type: "xml", xml: raw(l) };
  }
  if (type === "path") {
    spec.d = kid(l, "path").attrs.d;
    spec.absolute = false;
  }
  if (type === "group") {
    const sc = kid(l, "scene");
    spec.width = Number(sc.attrs.width);
    spec.height = Number(sc.attrs.height);
    spec.sceneAttrs = { ...sc.attrs };
    spec.layers = [];
    const sceneKeep = [];
    for (const c of sc.children.filter((x) => x.tag)) {
      if (["shape", "text", "drawing", "embedScene", "audio", "camera", "nullobj"].includes(c.tag)) spec.layers.push(layerSpec(c));
      else sceneKeep.push(raw(c));
    }
    if (sceneKeep.length) spec.sceneKeep = sceneKeep;
  }

  const handled = new Set(["transform", "fillColor", "gradient", "effect", "content", "property", "path", "scene"]);
  for (const c of l.children.filter((x) => x.tag && !handled.has(x.tag))) keep.push(raw(c));
  if (type === "shape" && kids(l, "path").length) keep.push(...kids(l, "path").map(raw));

  const attrs = Object.fromEntries(Object.entries(a).filter(([k]) => !used.has(k)));
  if (a.label === undefined) attrs.label = null; // the builder would invent "Rectangle 3"
  if (ft === undefined && fills) attrs.fillType = null; // remove the builder's default
  if (spec.image && a.mediaFillMode === undefined) attrs.mediaFillMode = null;
  if (Object.keys(attrs).length) spec.attrs = attrs;
  const k2 = keep.filter((x) => x !== null);
  if (k2.length) spec.keep = k2;
  return spec;
}

/** Project XML node (parsed <scene>) -> friendly spec. */
export function toSpec(scene) {
  const a = scene.attrs;
  const spec = {
    scene: {
      title: a.title, width: Number(a.width), height: Number(a.height), duration: Number(a.totalTime) / 1000,
      fps: Number(a.fps), background: a.bgcolor,
      attrs: Object.fromEntries(Object.entries(a).filter(([k]) => !["title", "width", "height", "totalTime", "fps", "bgcolor"].includes(k))),
    },
    keep: [],
    layers: [],
  };
  for (const c of scene.children.filter((x) => x.tag)) {
    if (["shape", "text", "drawing", "embedScene", "audio", "camera", "nullobj"].includes(c.tag)) spec.layers.push(layerSpec(c));
    else spec.keep.push(raw(c));
  }
  if (!spec.keep.length) delete spec.keep;
  return spec;
}

// Build and edit Alight Motion scenes.
//
// Friendly units used by this API (and by the JSON design spec):
//   - positions and sizes in scene pixels, origin top-left, y down
//   - layer start/end and keyframe `at` in seconds (keyframe `t` = 0..1 of the layer also works)
//   - shapes take full width/height; the XML stores half-extents (size="w/2,h/2")
//   - colors as #RRGGBB or #AARRGGBB

import { el, kid, kids, parseXml, serializeXml, textOf } from "./xml.mjs";
import { keyableNode, toColor, formatValue } from "./anim.mjs";
import { findEffect, findShape, BLEND_MODES } from "./catalog.mjs";
import { parsePath, formatPath, mapPath, pathBounds } from "./svgpath.mjs";

export const APP = {
  amver: "1028425",
  am: "com.alightcreative.motion/5.0.273.1028425",
  ffver: "106",
  amplatform: "android",
};

export const ELEMENT_TAGS = ["shape", "text", "drawing", "embedScene", "audio", "camera", "nullobj"];
const isElement = (n) => n?.tag && ELEMENT_TAGS.includes(n.tag);

// Child order inside an element, as written by the app.
const CHILD_RANK = {
  transform: 0, fillColor: 1, gradient: 2, effect: 3, gain: 4, speedMap: 5,
  border: 6, glow: 6, "path-stroke": 7, stroke: 7, shadow: 8,
  property: 9, parameter: 9, path: 10, scene: 10, content: 11,
};

const TRANSFORM = {
  // friendly name -> [tag, type, default]
  location: ["location", "vec3", [0, 0, 0]],
  pivot: ["pivot", "vec2", [0, 0]],
  scale: ["scale", "vec2", [1, 1]],
  skew: ["skew", "vec2", [0, 0]],
  rotation: ["rotation", "float", 0],
  opacity: ["opacity", "float", 1],
};
const TRANSFORM_ORDER = Object.keys(TRANSFORM);
const ALIASES = { position: "location", pos: "location", anchor: "pivot", rotate: "rotation", alpha: "opacity", fill: "fillColor", color: "fillColor" };

const ms = (s) => Math.round(Number(s) * 1000);

export function insertChild(parent, child) {
  const r = CHILD_RANK[child.tag] ?? 99;
  const idx = parent.children.findIndex((c) => c.tag && (CHILD_RANK[c.tag] ?? 99) > r);
  if (idx === -1) parent.children.push(child);
  else parent.children.splice(idx, 0, child);
  return child;
}

function replaceChild(parent, tag, child, match = () => true) {
  const idx = parent.children.findIndex((c) => c.tag === tag && match(c));
  if (idx >= 0) parent.children[idx] = child;
  else insertChild(parent, child);
  return child;
}

/** True when v is a keyframe list: [{at|t, v, ease}] or [[at, v, ease?], ...]. */
export function isKeyframes(v) {
  return Array.isArray(v) && v.length > 0 && (Array.isArray(v[0]) || (typeof v[0] === "object" && v[0] !== null && "v" in v[0]));
}

function normKeys(v, durSec, mapV) {
  return v.map((k) => {
    const o = Array.isArray(k) ? { at: k[0], v: k[1], ease: k[2] } : k;
    const t = o.t !== undefined ? Number(o.t) : Number(o.at) / durSec;
    if (!Number.isFinite(t)) throw new Error(`keyframe needs "at" (seconds) or "t" (0..1): ${JSON.stringify(k)}`);
    return { t, v: mapV(o.v), ease: o.ease };
  });
}

const vec = (v, n, fill = 0) => {
  const a = typeof v === "number" ? Array(n).fill(v) : typeof v === "string" ? v.split(",").map(Number) : [...v];
  while (a.length < n) a.push(a.length === 2 && n === 3 ? 0 : fill);
  return a.slice(0, n);
};

export function layerDuration(node) {
  return (Number(node.attrs.endTime) - Number(node.attrs.startTime)) / 1000 || 1;
}

export class Scene {
  constructor(opts = {}) {
    if (opts.node) {
      this.node = opts.node;
    } else {
      const width = Math.round(opts.width ?? 1080), height = Math.round(opts.height ?? 1920);
      this.node = el("scene", {
        title: opts.title ?? "AI Project",
        width, height,
        exportWidth: Math.round(opts.exportWidth ?? width),
        exportHeight: Math.round(opts.exportHeight ?? height),
        bgcolor: toColor(opts.background ?? opts.bgcolor ?? "#FF000000"),
        totalTime: ms(opts.duration ?? 5),
        fps: String(opts.fps ?? 30),
        modifiedTime: String(opts.modifiedTime ?? Date.now()),
        amver: APP.amver, ffver: APP.ffver, am: APP.am, amplatform: APP.amplatform,
      });
    }
    this.root = opts.root ?? this;
    this.mediaFiles = opts.mediaFiles ?? new Map(); // uri -> local path or data URL (preview + packing)
    this.mediaResolver = opts.mediaResolver ?? null; // (src) => media info, set by node.mjs
  }

  static parse(xml, opts = {}) {
    const node = typeof xml === "string" ? parseXml(xml) : xml;
    if (node.tag !== "scene") throw new Error(`root element is <${node.tag}>, expected <scene>`);
    return new Scene({ ...opts, node });
  }

  get width() { return Number(this.node.attrs.width); }
  get height() { return Number(this.node.attrs.height); }
  get duration() { return Number(this.node.attrs.totalTime) / 1000; }

  toXML({ comment = "Created for Alight Motion with alight-motion-ai" } = {}) {
    this.node.attrs.modifiedTime = String(Date.now());
    return serializeXml(this.node, { comment });
  }

  /** All elements, depth-first, including those inside nested scenes. */
  allLayers(node = this.node, out = []) {
    for (const c of node.children) {
      if (!isElement(c)) continue;
      out.push(c);
      const inner = kid(c, "scene");
      if (inner) this.allLayers(inner, out);
    }
    return out;
  }

  layers() { return this.node.children.filter(isElement); }

  nextId() {
    const ids = this.root.allLayers().map((l) => Number(l.attrs.id) || 0);
    return Math.max(0, ...ids) + 1;
  }

  /** Find a layer by numeric id or by label (exact, then case-insensitive). */
  find(ref) {
    const all = this.root.allLayers();
    if (typeof ref === "object" && ref?.tag) return ref;
    const byId = all.find((l) => l.attrs.id === String(ref));
    if (byId) return byId;
    return all.find((l) => l.attrs.label === ref) ?? all.find((l) => (l.attrs.label ?? "").toLowerCase() === String(ref).toLowerCase()) ?? null;
  }

  mustFind(ref) {
    const l = this.find(ref);
    if (!l) throw new Error(`no layer "${ref}". Layers: ${this.root.allLayers().map((x) => `${x.attrs.id}:${x.attrs.label ?? x.tag}`).join(", ")}`);
    return l;
  }

  remove(ref) {
    const l = this.mustFind(ref);
    const strip = (n) => {
      const i = n.children.indexOf(l);
      if (i >= 0) { n.children.splice(i, 1); return true; }
      return n.children.some((c) => c.tag && strip(c));
    };
    strip(this.root.node);
    return l;
  }

  /** Move a layer in the stack: "front", "back", or an index (0 = back). */
  reorder(ref, where) {
    const l = this.mustFind(ref);
    const parent = [this.root.node, ...this.root.allLayers().map((x) => kid(x, "scene")).filter(Boolean)].find((n) => n.children.includes(l));
    const els = parent.children.filter(isElement);
    parent.children = parent.children.filter((c) => c !== l);
    const target = where === "front" ? els.length - 1 : where === "back" ? 0 : Number(where);
    const ref2 = els.filter((x) => x !== l)[target];
    const idx = ref2 ? parent.children.indexOf(ref2) : parent.children.length;
    parent.children.splice(where === "front" ? parent.children.length : idx, 0, l);
  }

  // ----- media -----

  addMedia(info) {
    const existing = kids(this.root.node, "media").find((m) => m.attrs.uri === info.uri);
    if (existing) return existing;
    const m = el("media", {
      uri: info.uri, filename: info.filename, title: info.title ?? info.filename, type: info.type,
      size: info.size, sig: info.sig, orientation: info.orientation ?? 0,
      infoUpdated: info.infoUpdated ?? Date.now(), width: info.width, height: info.height,
      duration: info.duration,
    });
    const root = this.root.node;
    const firstNonMedia = root.children.findIndex((c) => c.tag && c.tag !== "media");
    root.children.splice(firstNonMedia === -1 ? root.children.length : firstNonMedia, 0, m);
    if (info.localPath || info.dataUrl) this.root.mediaFiles.set(info.uri, info.localPath ?? info.dataUrl);
    return m;
  }

  resolveMedia(spec) {
    if (spec.media) return spec.media;
    if (this.root.mediaResolver) return this.root.mediaResolver(spec.src ?? spec.image ?? spec.file);
    if (spec.uri) return { uri: spec.uri, filename: spec.uri.split("/").pop(), type: spec.mime ?? "image/png", width: spec.mediaWidth, height: spec.mediaHeight };
    throw new Error("image layers need src (a local file, when running in Node) or a media object");
  }

  // ----- building -----

  /** Add a layer from a friendly spec. Returns the element node. */
  add(spec) {
    spec = { ...spec };
    const type = (spec.type ?? (spec.text !== undefined ? "text" : spec.d ? "path" : spec.src ? "image" : spec.shape ? "shape" : "")).toLowerCase();
    const builders = {
      text: () => this.#text(spec), shape: () => this.#shape(spec), image: () => this.#image(spec),
      path: () => this.#path(spec), drawing: () => this.#drawing(spec), null: () => this.#base("nullobj", spec, "Null"),
      group: () => this.#group(spec), audio: () => this.#audio(spec),
    };
    if (!builders[type]) throw new Error(`unknown layer type "${spec.type}" (use ${Object.keys(builders).join(", ")})`);
    const node = builders[type]();
    this.node.children.push(node);
    this.#applyCommon(node, spec);
    return node;
  }

  #base(tag, spec, defaultLabel, extra = {}) {
    const start = spec.startMs ?? ms(spec.start ?? 0);
    const end = spec.endMs ?? (spec.end !== undefined ? ms(spec.end) : spec.duration !== undefined ? start + ms(spec.duration) : Number(this.node.attrs.totalTime));
    if (end <= start) throw new Error(`layer "${spec.label ?? defaultLabel}": end must be after start`);
    const label = spec.label ?? this.#numberedLabel(defaultLabel);
    const node = el(tag, {
      id: spec.id ?? this.nextId(), label, hidden: spec.hidden ? "true" : undefined,
      startTime: start, endTime: end, ...extra,
    });
    node.children.push(el("transform"));
    return node;
  }

  #numberedLabel(base) {
    const used = new Set(this.root.allLayers().map((l) => l.attrs.label));
    for (let n = 1; ; n++) if (!used.has(`${base} ${n}`)) return `${base} ${n}`;
  }

  #applyCommon(node, spec) {
    const anim = spec.animate ?? {};
    const pos = anim.position ?? anim.location ?? spec.position ?? (spec.x !== undefined || spec.y !== undefined
      ? [spec.x ?? this.width / 2, spec.y ?? this.height / 2]
      : [this.width / 2, this.height / 2]);
    this.set(node, "location", pos);
    for (const k of ["scale", "rotation", "opacity", "pivot", "skew"]) {
      const v = anim[k] ?? spec[k];
      if (v !== undefined) this.set(node, k, v);
    }
    if (spec.blend && spec.blend !== "normal") {
      if (!BLEND_MODES.includes(spec.blend)) throw new Error(`unknown blend "${spec.blend}" (use ${BLEND_MODES.join(", ")})`);
      node.attrs = reorderAttrs({ ...node.attrs, blending: spec.blend });
    }
    if (spec.parent !== undefined) {
      node.attrs = reorderAttrs({ ...node.attrs, parent: this.mustFind(spec.parent).attrs.id });
    }
    for (const fx of spec.effects ?? []) this.addEffect(node, fx);
    for (const [k, v] of Object.entries(anim)) {
      if (["position", "location", "scale", "rotation", "opacity", "pivot", "skew"].includes(k)) continue;
      this.set(node, k, v);
    }
  }

  #fill(spec, node, defaultColor) {
    const f = spec.gradient ? { gradient: spec.gradient } : spec.fill ?? spec.color ?? defaultColor;
    if (f === "none" || f === null) { node.attrs.fillType = "none"; return; }
    if (typeof f === "object" && !Array.isArray(f) && f.gradient) {
      const g = f.gradient;
      node.attrs.fillType = "gradient";
      replaceChild(node, "gradient", el("gradient", {
        type: g.type ?? "linear",
        startColor: toColor(g.from ?? g.startColor ?? "#000000"),
        endColor: toColor(g.to ?? g.endColor ?? "#FFFFFF"),
        start: formatValue("vec2", g.start ?? [0, 0]),
        end: formatValue("vec2", g.end ?? [1, 1]),
      }));
      return;
    }
    node.attrs.fillType = "color";
    this.set(node, "fillColor", f);
  }

  #stroke(spec, node) {
    const s = spec.stroke;
    if (!s) return;
    const n = el("path-stroke", { direction: s.align ?? s.direction ?? "centered", cap: s.cap, join: s.join, "end-size": s.endSize });
    if (s.color) n.children.push(keyableNode("color", "color", isKeyframes(s.color) ? normKeys(s.color, layerDuration(node), (x) => x) : s.color));
    n.children.push(keyableNode("size", "float", isKeyframes(s.width) ? normKeys(s.width, layerDuration(node), Number) : s.width ?? 8));
    replaceChild(node, "path-stroke", n);
  }

  #text(spec) {
    const font = spec.fontDescriptor ?? `googlefonts?name=${spec.font ?? "Roboto"}&weight=${spec.weight ?? 400}`;
    const node = this.#base("text", spec, "Text", {
      fillType: "color",
      size: formatValue("float", spec.size ?? 72),
      font,
      wrapWidth: Math.round(spec.wrapWidth ?? Math.min(this.width * 0.9, 2000)),
      align: spec.align ?? "center",
    });
    this.#fill(spec, node, "#FFFFFFFF");
    this.#stroke(spec, node);
    insertChild(node, el("content", {}, [{ text: String(spec.text ?? "") }]));
    return node;
  }

  #shape(spec) {
    const tpl = findShape(spec.shape ?? "rect");
    if (!tpl) throw new Error(`unknown shape "${spec.shape}" (use rect, roundrect, circle, triangle, star, poly, multifoil, plus, arrow, line, wideline, pie, arc, moon, teardrop, quad, penta, callout, stamp)`);
    const node = this.#base("shape", spec, tpl.name ?? "Shape", { fillType: "color" });
    this.#fill(spec, node, "#FFFFFFFF");
    node.attrs.s = tpl.ref;
    node.attrs = reorderAttrs(node.attrs);
    this.#stroke(spec, node);
    const params = { ...(spec.params ?? {}) };
    const has = (id) => tpl.params.some((p) => p.id === id);
    if (has("size") && params.size === undefined) {
      const w = spec.width ?? (spec.radius !== undefined ? spec.radius * 2 : spec.size ?? 200);
      const h = spec.height ?? (spec.radius !== undefined ? spec.radius * 2 : spec.size ?? w);
      params.size = isKeyframes(w) ? w.map((k) => (Array.isArray(k) ? [k[0], [k[1][0] / 2, k[1][1] / 2], k[2]] : { ...k, v: [k.v[0] / 2, k.v[1] / 2] })) : [w / 2, h / 2];
    }
    if (has("radius") && params.radius === undefined && spec.radius !== undefined) params.radius = spec.radius;
    if (has("cornerRadius") && params.cornerRadius === undefined && (spec.cornerRadius ?? spec.corner) !== undefined) params.cornerRadius = spec.cornerRadius ?? spec.corner;
    if (has("outerRadius") && params.outerRadius === undefined && spec.radius !== undefined) params.outerRadius = spec.radius;
    if (has("innerRadius") && params.innerRadius === undefined && (spec.innerRadius ?? spec.radius) !== undefined) params.innerRadius = spec.innerRadius ?? spec.radius / 2;
    if (has("pointCount") && params.pointCount === undefined && spec.points !== undefined) params.pointCount = spec.points;
    if (has("sideCount") && params.sideCount === undefined && spec.sides !== undefined) params.sideCount = spec.sides;
    for (const [k, v] of Object.entries(params)) this.set(node, k, v, { shape: tpl });
    if (spec.image) this.#mediaFill(node, spec.image);
    return node;
  }

  #mediaFill(node, src) {
    const info = this.resolveMedia(typeof src === "string" ? { src } : src);
    this.addMedia(info);
    node.attrs.fillType = "media";
    node.attrs.fillImage = info.uri;
    node.attrs.mediaFillMode = node.attrs.mediaFillMode ?? "fill";
    node.children = node.children.filter((c) => c.tag !== "fillColor" && c.tag !== "gradient");
    node.attrs = reorderAttrs(node.attrs);
    return info;
  }

  #image(spec) {
    const info = this.resolveMedia(spec);
    let { width: w, height: h } = spec;
    const iw = info.width || 1000, ih = info.height || 1000;
    if (w === undefined && h === undefined) {
      // Same as the app on import: fit inside the canvas (contain), or cover when asked.
      const k = (spec.fit === "cover" ? Math.max : Math.min)(this.width / iw, this.height / ih);
      w = iw * k; h = ih * k;
    } else if (w === undefined) w = (h * iw) / ih;
    else if (h === undefined) h = (w * ih) / iw;
    const node = this.#base("shape", spec, info.title ?? "Image", { fillType: "media" });
    this.addMedia(info);
    node.attrs.fillImage = info.uri;
    node.attrs.mediaFillMode = spec.fit === "stretch" ? "stretch" : "fill";
    node.attrs = reorderAttrs(node.attrs);
    this.#stroke(spec, node);
    insertChild(node, el("path", { d: `M ${-w / 2} ${-h / 2}L ${w / 2} ${-h / 2}L ${w / 2} ${h / 2}L ${-w / 2} ${h / 2}L ${-w / 2} ${-h / 2}Z`.replace(/(-?\d+(?:\.\d+)?)/g, (n) => (+n).toFixed(3)) }));
    return node;
  }

  #path(spec) {
    let segs = parsePath(spec.d);
    // By default d is in scene coordinates: recenter it on its bounding box so the
    // layer's position (and rotation/scale origin) sits at the drawing's center.
    if (spec.absolute !== false && spec.x === undefined && spec.y === undefined && spec.position === undefined) {
      const b = pathBounds(segs);
      segs = mapPath(segs, (x, y) => [x - b.cx, y - b.cy]);
      spec.x = b.cx;
      spec.y = b.cy;
    }
    const node = this.#base("shape", spec, spec.labelBase ?? "Shape", { fillType: "color" });
    this.#fill(spec, node, spec.stroke ? "none" : "#FFFFFFFF");
    this.#stroke(spec, node);
    insertChild(node, el("path", { d: formatPath(segs) }));
    return node;
  }

  #drawing(spec) {
    const node = this.#base("drawing", spec, "Drawing", { fillType: "none" });
    for (const s of spec.strokes ?? []) {
      const pts = s.points.map((p) => [p[0], p[1], p[2] ?? 1].map((n) => Number(n).toFixed(6)).join(",")).join(";");
      insertChild(node, el("stroke", { color: toColor(s.color ?? "#FFFFFF"), width: Number(s.width ?? 8).toFixed(6), type: s.tool ?? "pen", points: pts }));
    }
    return node;
  }

  #audio(spec) {
    const info = this.resolveMedia(spec);
    this.addMedia(info);
    const node = this.#base("audio", spec, info.title ?? "Audio", { src: info.uri, outTime: info.duration ? Math.round(info.duration / 1000) : undefined });
    node.children = [];
    return node;
  }

  #group(spec) {
    const w = spec.width ?? this.width, h = spec.height ?? this.height;
    const node = this.#base("embedScene", spec, spec.title ?? "Group");
    const inner = new Scene({
      root: this.root, mediaFiles: this.root.mediaFiles, mediaResolver: this.root.mediaResolver,
      title: spec.title ?? node.attrs.label, width: w, height: h, background: "#00000000",
      duration: (Number(node.attrs.endTime) - Number(node.attrs.startTime)) / 1000,
    });
    insertChild(node, inner.node);
    for (const l of spec.layers ?? []) inner.add(l);
    return node;
  }

  // ----- editing (works on parsed projects too) -----

  /**
   * Set a static value or keyframes on a layer property.
   * prop: location|position, scale, rotation, opacity, pivot, skew, fillColor|fill,
   *       a shape parameter (size, cornerRadius, ...), or "fx:<effect>.<param>".
   */
  set(ref, prop, value, { shape } = {}) {
    const node = this.mustFind(ref);
    prop = ALIASES[prop] ?? prop;
    const dur = layerDuration(node);
    if (TRANSFORM[prop]) {
      const [tag, type] = TRANSFORM[prop];
      const n = type === "vec3" ? 3 : type === "vec2" ? 2 : 1;
      const map = (v) => (n === 1 ? Number(v) : vec(v, n, prop === "scale" ? 1 : 0));
      const k = keyableNode(tag, type, isKeyframes(value) ? normKeys(value, dur, map) : map(value));
      let tr = kid(node, "transform") ?? insertChild(node, el("transform"));
      const others = tr.children.filter((c) => c.tag && c.tag !== tag);
      tr.children = [...others, k].sort((a, b) => TRANSFORM_ORDER.indexOf(a.tag) - TRANSFORM_ORDER.indexOf(b.tag));
      return k;
    }
    if (prop === "fillColor") {
      return replaceChild(node, "fillColor", keyableNode("fillColor", "color", isKeyframes(value) ? normKeys(value, dur, (x) => x) : value));
    }
    if (prop.startsWith("fx:")) {
      const [fxRef, param] = prop.slice(3).split(".");
      const fx = this.#findEffectNode(node, fxRef);
      return this.#setParam(fx, findEffect(fx.attrs.id), param, value, dur);
    }
    if (prop === "text" && node.tag === "text") {
      replaceChild(node, "content", el("content", {}, [{ text: String(value) }]));
      return;
    }
    const tpl = shape ?? (node.attrs.s ? findShape(node.attrs.s) : null);
    if (!tpl) throw new Error(`"${prop}" is not a property of this ${node.tag} layer (try position, scale, rotation, opacity, fill, or fx:<effect>.<param>)`);
    return this.#setParam(node, tpl, prop, value, dur);
  }

  #setParam(container, def, name, value, dur) {
    const p = def?.params.find((x) => x.id === name);
    if (!p) throw new Error(`"${def?.name ?? def?.id}" has no parameter "${name}". Valid: ${def?.params.map((x) => x.id).join(", ")}`);
    const map = (v) => {
      if (p.choices && typeof v === "string" && !/^-?\d+$/.test(v)) {
        const c = p.choices.find(([, label]) => label?.toLowerCase() === v.toLowerCase());
        if (!c) throw new Error(`"${name}" choices: ${p.choices.map(([val, l]) => `${val}=${l}`).join(", ")}`);
        return Number(c[0]);
      }
      return v;
    };
    const node = keyableNode("property", p.type, isKeyframes(value) ? normKeys(value, dur, map) : map(value), { name, type: p.type });
    const existing = container.children.findIndex((c) => c.tag === "property" && c.attrs.name === name);
    if (existing >= 0) container.children[existing] = node;
    else if (container.tag === "effect") container.children.push(node);
    else insertChild(container, node);
    return node;
  }

  #findEffectNode(node, ref) {
    const fxs = kids(node, "effect");
    const def = findEffect(ref);
    const fx = /^\d+$/.test(ref) ? fxs[Number(ref)] : fxs.find((f) => f.attrs.id === (def?.id ?? ref));
    if (!fx) throw new Error(`layer has no effect "${ref}" (has: ${fxs.map((f) => f.attrs.id).join(", ") || "none"})`);
    return fx;
  }

  /** Add an effect: {effect: id|name, params: {...}} (param values may be keyframes). */
  addEffect(ref, spec) {
    const node = this.mustFind(ref);
    const s = typeof spec === "string" ? { effect: spec } : spec;
    const def = findEffect(s.effect ?? s.id ?? s.name);
    if (!def) throw new Error(`unknown effect "${s.effect ?? s.id}". Search the catalog (amx effects <words>).`);
    const fx = el("effect", { id: def.id, hidden: s.hidden ? "true" : undefined, locallyApplied: "true" });
    const params = { ...(s.params ?? {}), ...(s.animate ?? {}) };
    for (const [k, v] of Object.entries(params)) this.#setParam(fx, def, k, v, layerDuration(node));
    insertChild(node, fx); // after existing effects, so the stack keeps its order
    return fx;
  }

  removeEffect(ref, fxRef) {
    const node = this.mustFind(ref);
    const fx = this.#findEffectNode(node, fxRef);
    node.children = node.children.filter((c) => c !== fx);
  }

  /** Change timing (seconds). Keyframes stay attached proportionally, like the app's stretch. */
  setTiming(ref, { start, end }) {
    const node = this.mustFind(ref);
    if (start !== undefined) node.attrs.startTime = String(ms(start));
    if (end !== undefined) node.attrs.endTime = String(ms(end));
  }

  setScene(opts) {
    const a = this.root.node.attrs;
    if (opts.title !== undefined) a.title = opts.title;
    if (opts.width !== undefined) a.width = a.exportWidth = String(Math.round(opts.width));
    if (opts.height !== undefined) a.height = a.exportHeight = String(Math.round(opts.height));
    if (opts.duration !== undefined) a.totalTime = String(ms(opts.duration));
    if (opts.fps !== undefined) a.fps = String(opts.fps);
    if (opts.background !== undefined) a.bgcolor = toColor(opts.background);
  }
}

const ATTR_ORDER = [
  "id", "tag", "label", "hidden", "startTime", "endTime", "clippingMask", "fillType", "blending",
  "fillImage", "src", "fillVideo", "inTime", "outTime", "loop", "speed", "mediaFillMode", "parent",
  "templatePPId", "presetId", "size", "font", "wrapWidth", "align", "s", "link",
];
function reorderAttrs(a) {
  const keys = Object.keys(a).sort((x, y) => {
    const i = ATTR_ORDER.indexOf(x), j = ATTR_ORDER.indexOf(y);
    return (i === -1 ? 999 : i) - (j === -1 ? 999 : j);
  });
  return Object.fromEntries(keys.map((k) => [k, a[k]]));
}

/** Build a whole project from a JSON design spec: {scene: {...}, layers: [...]} */
export function buildFromSpec(spec, opts = {}) {
  const scene = new Scene({ ...(spec.scene ?? {}), ...opts });
  for (const layer of spec.layers ?? []) scene.add(layer);
  return scene;
}

export { textOf };

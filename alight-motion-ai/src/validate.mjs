// Check a scene against what Alight Motion's importer expects, and describe it.

import { kid, kids, textOf, parseXml } from "./xml.mjs";
import { findEffect, findShape, BLEND_MODES } from "./catalog.mjs";
import { readKeyable } from "./anim.mjs";
import { parsePath } from "./svgpath.mjs";

const ELEMENT_TAGS = new Set(["shape", "text", "drawing", "embedScene", "audio", "camera", "nullobj"]);
const COLOR = /^#([0-9a-fA-F]{8}|[0-9a-fA-F]{6})$/;
const REQUIRED = ["width", "height", "exportWidth", "exportHeight", "bgcolor", "totalTime", "fps"];
const TRANSFORM_KIDS = new Set(["location", "pivot", "scale", "skew", "rotation", "opacity"]);
const RANK = {
  transform: 0, fillColor: 1, gradient: 2, effect: 3, gain: 4, speedMap: 5, border: 6, glow: 6,
  "path-stroke": 7, stroke: 7, shadow: 8, property: 9, parameter: 9, path: 10, scene: 10, content: 11,
};

const isInt = (v) => v !== undefined && /^-?\d+$/.test(String(v).trim());
const isNum = (v) => v !== undefined && String(v).trim() !== "" && Number.isFinite(Number(v));

export function validate(input) {
  const issues = [];
  const add = (level, where, msg) => issues.push({ level, where, msg });
  let scene;
  try {
    scene = typeof input === "string" ? parseXml(input) : input;
  } catch (e) {
    add("error", "xml", e.message);
    return { ok: false, issues };
  }
  if (scene.tag !== "scene") {
    add("error", "root", `root element must be <scene>, got <${scene.tag}>`);
    return { ok: false, issues };
  }
  checkScene(scene, "scene", add, true);
  return { ok: !issues.some((i) => i.level === "error"), issues };
}

function checkScene(scene, where, add, isRoot) {
  for (const a of REQUIRED) if (scene.attrs[a] === undefined) add("error", where, `missing attribute ${a}`);
  for (const a of ["width", "height", "exportWidth", "exportHeight", "totalTime"]) {
    if (scene.attrs[a] !== undefined && !isInt(scene.attrs[a])) add("error", where, `${a} must be an integer`);
  }
  if (scene.attrs.bgcolor && !COLOR.test(scene.attrs.bgcolor)) add("error", where, `bgcolor must be #AARRGGBB`);
  if (isRoot && !scene.attrs.ffver) add("warn", where, "missing ffver (use 106)");
  if (isRoot && !scene.attrs.amver) add("warn", where, "missing amver/am/amplatform (the app's own exports always have them)");
  const media = new Set(kids(scene, "media").map((m) => m.attrs.uri));
  for (const m of kids(scene, "media")) {
    if (!m.attrs.uri) add("error", where, "<media> without uri");
    if (!m.attrs.type) add("warn", where, `<media ${m.attrs.filename ?? ""}> without type`);
  }
  let seenElement = false;
  for (const c of scene.children) {
    if (!c.tag) continue;
    if (c.tag === "media" && seenElement) add("warn", where, "<media> should come before the layers");
    if (ELEMENT_TAGS.has(c.tag)) seenElement = true;
  }
  const els = scene.children.filter((c) => c.tag && ELEMENT_TAGS.has(c.tag));
  const ids = new Map();
  for (const e of els) ids.set(e.attrs.id, (ids.get(e.attrs.id) ?? 0) + 1);
  const total = Number(scene.attrs.totalTime);
  for (const e of els) checkElement(e, { add, ids, media, total, where });
}

function checkElement(e, { add, ids, media, total, where }) {
  const w = `${where} > ${e.tag}#${e.attrs.id ?? "?"}${e.attrs.label ? ` "${e.attrs.label}"` : ""}`;
  if (!isInt(e.attrs.id) || Number(e.attrs.id) <= 0) add("error", w, "id must be a positive integer");
  else if (ids.get(e.attrs.id) > 1) add("error", w, `duplicate id ${e.attrs.id}`);
  if (!isInt(e.attrs.startTime) || !isInt(e.attrs.endTime)) add("error", w, "startTime/endTime must be integer milliseconds");
  else {
    if (Number(e.attrs.endTime) <= Number(e.attrs.startTime)) add("error", w, "endTime must be greater than startTime");
    if (Number(e.attrs.startTime) >= total) add("warn", w, "starts after the scene ends");
  }
  if (e.attrs.blending && !BLEND_MODES.includes(e.attrs.blending)) add("error", w, `unknown blending "${e.attrs.blending}"`);
  if (e.attrs.parent && !ids.has(e.attrs.parent)) add("error", w, `parent ${e.attrs.parent} is not a layer in this scene`);
  if (e.attrs.fillImage && !media.has(e.attrs.fillImage)) add("warn", w, "fillImage has no matching <media> entry");

  let prev = -1;
  for (const c of e.children) {
    if (!c.tag) continue;
    const r = RANK[c.tag] ?? 99;
    if (r === 99) add("warn", w, `unexpected child <${c.tag}>`);
    if (r < prev) add("warn", w, `<${c.tag}> is out of the usual order (transform, fillColor, gradient, effect, …, path-stroke, property, path, content)`);
    prev = Math.max(prev, r);
  }

  const tr = kid(e, "transform");
  if (!tr && e.tag !== "audio") add("warn", w, "no <transform>");
  for (const c of kids(tr)) {
    if (!TRANSFORM_KIDS.has(c.tag)) add("warn", w, `unknown transform child <${c.tag}>`);
    checkKeyable(c, w + " transform." + c.tag, add);
  }
  const fc = kid(e, "fillColor");
  if (fc) checkKeyable(fc, w + " fillColor", add, "color");

  for (const fx of kids(e, "effect")) {
    const def = findEffect(fx.attrs.id);
    if (!fx.attrs.id) { add("error", w, "<effect> without id"); continue; }
    if (!def) add("warn", w, `effect ${fx.attrs.id} is not in the bundled catalog (may be a downloadable effect)`);
    else if (def.id !== fx.attrs.id) add("error", w, `effect id must be the full id "${def.id}", not "${fx.attrs.id}"`);
    else if (def.deprecated) add("warn", w, `effect ${def.id} is deprecated`);
    if (fx.attrs.locallyApplied === undefined) add("warn", w, `effect ${fx.attrs.id} missing locallyApplied="true"`);
    for (const p of kids(fx, "property")) {
      const pd = def?.params.find((x) => x.id === p.attrs.name);
      if (def && !pd) add("warn", w, `${def.name} has no parameter "${p.attrs.name}"`);
      if (pd && p.attrs.type && p.attrs.type !== pd.type && !(["int", "float"].includes(pd.type) && ["int", "float"].includes(p.attrs.type))) add("warn", w, `${def.name}.${p.attrs.name} should be type ${pd.type}`);
      checkKeyable(p, `${w} ${fx.attrs.id.split(".").pop()}.${p.attrs.name}`, add, p.attrs.type);
    }
  }

  if (e.tag === "shape") {
    const path = kid(e, "path");
    if (e.attrs.s) {
      const tpl = findShape(e.attrs.s);
      if (!tpl) add("error", w, `unknown shape template ${e.attrs.s}`);
      for (const p of kids(e, "property")) {
        if (tpl && !tpl.params.some((x) => x.id === p.attrs.name)) add("warn", w, `${tpl.name} has no parameter "${p.attrs.name}"`);
        checkKeyable(p, `${w} ${p.attrs.name}`, add, p.attrs.type);
      }
    } else if (!path) {
      add("warn", w, "shape has neither s=\".template\" nor <path d>");
    }
    if (path) {
      try {
        parsePath(path.attrs.d);
        if (/[a-zA-Z]/.test(path.attrs.d.replace(/[MLCZe]/g, ""))) add("warn", w, "path uses commands other than M, L, C, Z; the app writes only those (normalize with amx)");
      } catch (err) { add("error", w, `bad path d: ${err.message}`); }
    }
    const ft = e.attrs.fillType;
    if (ft === "media" && !e.attrs.fillImage && !e.attrs.fillVideo) add("error", w, "fillType media needs fillImage or fillVideo");
  }
  if (e.tag === "text") {
    if (!kid(e, "content")) add("warn", w, "text without <content>");
    if (!e.attrs.font) add("warn", w, "text without font (e.g. googlefonts?name=Roboto&weight=400)");
    if (!isNum(e.attrs.size)) add("warn", w, "text size should be a number");
  }
  if (e.tag === "embedScene") {
    const inner = kid(e, "scene");
    if (!inner) add("error", w, "embedScene without a nested <scene>");
    else checkScene(inner, w, add, false);
  }
}

function checkKeyable(node, where, add, type) {
  const kfs = kids(node, "kf");
  if (!kfs.length) {
    if (node.attrs.value === undefined && node.tag !== "property") add("warn", where, "no value and no keyframes");
    if (type === "color" && node.attrs.value && !COLOR.test(node.attrs.value)) add("error", where, `bad color ${node.attrs.value}`);
    return;
  }
  for (const k of kfs) {
    if (!isNum(k.attrs.t)) add("error", where, "keyframe without numeric t");
    else if (Number(k.attrs.t) < -0.5 || Number(k.attrs.t) > 1.5) {
      // The app's own exports have t a little outside 0..1 (e.g. -0.0165), but never far.
      add("error", where, `keyframe t=${k.attrs.t} is far outside 0..1. t is a fraction of the layer's duration, not seconds`);
    }
    if (k.attrs.v === undefined) add("error", where, "keyframe without v");
    if (k.attrs.e && !/^(local )?(cubicBezier( -?[\d.eE-]+){4}|cyclic( -?[\d.eE-]+){5})$/.test(k.attrs.e)) add("warn", where, `unusual easing "${k.attrs.e}"`);
  }
}

const fmtV = (v) => (Array.isArray(v) ? (v.length === 4 && v[3] <= 1 && Number.isInteger(v[0]) ? `rgba(${v.join(",")})` : v.map((x) => +(+x).toFixed(2)).join(",")) : typeof v === "number" ? +v.toFixed(3) : String(v));

/** Human/AI readable outline of a scene. */
export function outline(scene, ind = "") {
  const a = scene.attrs;
  const lines = [];
  if (!ind) lines.push(`"${a.title ?? ""}" ${a.width}x${a.height} @${a.fps}fps, ${Number(a.totalTime) / 1000}s, bg ${a.bgcolor}`);
  for (const m of kids(scene, "media")) lines.push(`${ind}media ${m.attrs.title ?? m.attrs.filename} (${m.attrs.type}${m.attrs.width ? ` ${m.attrs.width}x${m.attrs.height}` : ""}) uri=${m.attrs.uri}`);
  const els = scene.children.filter((c) => c.tag && ELEMENT_TAGS.has(c.tag));
  els.forEach((e, i) => {
    const s = Number(e.attrs.startTime) / 1000, en = Number(e.attrs.endTime) / 1000;
    let head = `${ind}[${i}] ${e.tag}#${e.attrs.id} "${e.attrs.label ?? ""}" ${s}s-${en}s`;
    if (e.attrs.s) head += ` template ${e.attrs.s}`;
    if (kid(e, "path")) head += ` custom path`;
    if (e.attrs.fillType) head += ` fill=${e.attrs.fillType}`;
    if (e.attrs.blending) head += ` blend=${e.attrs.blending}`;
    if (e.attrs.parent) head += ` parent=#${e.attrs.parent}`;
    if (e.attrs.hidden === "true") head += " hidden";
    lines.push(head);
    const desc = (n) => {
      const k = readKeyable(n);
      if (!k) return "";
      if (k.keys) return k.keys.map((x) => `${(x.t * (en - s)).toFixed(2)}s:${fmtV(x.v)}${x.e ? "~" : ""}`).join(" → ");
      return fmtV(k.value);
    };
    const tr = kid(e, "transform");
    const parts = kids(tr).map((c) => `${c.tag}=${desc(c)}`);
    if (parts.length) lines.push(`${ind}    ${parts.join("  ")}`);
    if (kid(e, "fillColor")) lines.push(`${ind}    fillColor=${kid(e, "fillColor").attrs.value ?? desc(kid(e, "fillColor"))}`);
    const g = kid(e, "gradient");
    if (g) lines.push(`${ind}    gradient ${g.attrs.type} ${g.attrs.startColor}→${g.attrs.endColor}`);
    if (e.tag === "text") lines.push(`${ind}    text "${textOf(kid(e, "content")).replace(/\n/g, "\\n")}" size=${e.attrs.size} font=${e.attrs.font} align=${e.attrs.align}`);
    for (const p of kids(e, "property")) lines.push(`${ind}    ${p.attrs.name}=${p.attrs.value ?? desc(p)}`);
    const ps = kid(e, "path-stroke");
    if (ps) lines.push(`${ind}    stroke ${kid(ps, "color")?.attrs.value ?? ""} width ${kid(ps, "size")?.attrs.value ?? ""}`);
    for (const fx of kids(e, "effect")) {
      const def = findEffect(fx.attrs.id);
      lines.push(`${ind}    effect ${def?.name ?? "?"} (${fx.attrs.id})${fx.attrs.hidden === "true" ? " hidden" : ""}`);
      for (const p of kids(fx, "property")) lines.push(`${ind}      ${p.attrs.name}=${p.attrs.value ?? desc(p)}`);
    }
    const inner = kid(e, "scene");
    if (inner) lines.push(...outline(inner, ind + "    ").split("\n"));
  });
  return lines.join("\n");
}

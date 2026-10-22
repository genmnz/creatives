import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, existsSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadCatalog, buildSpecFile, writeProject, openXml, unzip, ROOT } from "../src/node.mjs";
import { Scene, buildFromSpec } from "../src/builder.mjs";
import { parseXml, kid, kids } from "../src/xml.mjs";
import { validate } from "../src/validate.mjs";
import { renderSVG } from "../src/render.mjs";
import { normalizePath } from "../src/svgpath.mjs";
import { toSpec } from "../src/decompile.mjs";
import { svgToLayers } from "../src/svgimport.mjs";
import { findPreset, remapT } from "../src/presets.mjs";
import { applyOps } from "../src/ops.mjs";

loadCatalog();

// Optional corpus of real Alight Motion exports (see tools/fetch-corpus.sh).
const corpus = process.env.AM_CORPUS;
const corpusFiles = corpus && existsSync(corpus) ? readdirSync(corpus).filter((f) => f.endsWith(".xml")) : [];

test("transitions become keyframed effects at the start and end of the layer", () => {
  const s = new Scene({ width: 1080, height: 1080, duration: 4 });
  const n = s.add({ type: "text", text: "Hi", in: "fade", out: { type: "slide-down", duration: 1 } });
  const fxs = kids(n, "effect");
  assert.equal(fxs.length, 2);
  const alphaIn = kids(fxs[0], "property").find((p) => p.attrs.name === "alpha");
  assert.deepEqual(kids(alphaIn, "kf").map((k) => [k.attrs.t, k.attrs.v]), [["0.000000", "0.000000"], ["0.150000", "1.000000"]]);
  const offOut = kids(fxs[1], "property").find((p) => p.attrs.name === "offset");
  assert.deepEqual(kids(offOut, "kf").map((k) => k.attrs.t), ["0.750000", "1.000000"]);
  assert.ok(validate(s.node).ok);
  assert.throws(() => s.add({ type: "shape", shape: "rect", in: "typewriter" }), /text/);
});

test("app presets remap keyframes by their timing tag", () => {
  assert.equal(remapT(0.5, "start", 2000, 4000), 0.25);
  assert.equal(remapT(0.5, "end", 2000, 4000), 0.75);
  assert.equal(remapT(0.5, "stretch", 2000, 4000), 0.5);
  const p = findPreset("Ghost Pop");
  assert.equal(p.timing, "start");
  const s = new Scene({ width: 1080, height: 1080, duration: 4 });
  const n = s.add({ type: "shape", shape: "star", presets: ["Ghost Pop"] });
  assert.equal(kids(n, "effect")[0].attrs.id, "com.alightcreative.effects.transform");
  assert.ok(validate(s.node).ok);
});

test("packages use the app's layout: <uuid>.xml, manifest.txt, amproj: media", () => {
  const scene = buildSpecFile(join(ROOT, "examples/specs/02-images.json"));
  const dir = mkdtempSync(join(tmpdir(), "amx-test-"));
  const [, zipPath] = writeProject(scene, join(dir, "p.xml"));
  const { xmlName, xml, files } = unzip(readFileSync(zipPath));
  assert.match(xmlName, /^[0-9a-f-]{36}\.xml$/);
  const manifest = files.get("manifest.txt").toString().split("\n");
  for (const line of manifest) {
    const [sig, name] = line.split(":");
    assert.match(sig, /^[0-9A-F]{40}$/);
    assert.ok(files.has(name), `${name} in zip`);
    assert.ok(xml.includes(`uri="amproj:${name}"`));
  }
  const back = openXml(zipPath);
  assert.equal(kids(back.node, "media").length, manifest.length);
  assert.ok([...back.mediaFiles.values()].every((p) => existsSync(p)));
});

test("decompiled specs rebuild to the same picture", () => {
  const files = [...readdirSync(join(ROOT, "examples/out")).filter((f) => f.endsWith(".xml")).map((f) => join(ROOT, "examples/out", f)),
    ...corpusFiles.map((f) => join(corpus, f))];
  for (const f of files) {
    const node = parseXml(readFileSync(f, "utf8"));
    const again = buildFromSpec(JSON.parse(JSON.stringify(toSpec(node)))).node;
    const T = Number(node.attrs.totalTime) / 1000;
    for (const k of [0.2, 0.5, 0.8]) assert.equal(renderSVG(again, T * k), renderSVG(node, T * k), `${f} at ${k}`);
  }
});

test("SVG import: shapes, transforms, classes, gradients, compact arc flags", () => {
  assert.equal(normalizePath("M10 10a5 5 0 017.07 0"), "M 10.0 10.0C 11.952 8.048, 15.118 8.048, 17.07 10.0");
  const { layers } = svgToLayers(readFileSync(join(ROOT, "examples/assets/mark.svg"), "utf8"), { width: 1000, height: 1000, box: { x: 0, y: 0, w: 1000, h: 1000 } });
  assert.equal(layers.length, 9);
  assert.equal(layers[0].gradient.from, "#FFFF4F9E");
  assert.equal(layers[1].stroke.width, 30); // 6 * (1000 / 200)
  assert.equal(layers[1].fill, "none");
  assert.match(layers[8].color, /^#99/); // opacity 0.6 folded into the color
  const s = new Scene({ width: 1000, height: 1000 });
  const g = s.add({ type: "svg", svg: readFileSync(join(ROOT, "examples/assets/mark.svg"), "utf8"), stagger: 0.1, itemIn: "pop" });
  const ids = s.allLayers().map((l) => l.attrs.id);
  assert.equal(new Set(ids).size, ids.length, "ids are unique inside groups");
  assert.equal(g.tag, "embedScene");
  assert.ok(validate(s.node).ok);
});

test("edit ops: transition and preset", () => {
  const s = new Scene({ width: 1080, height: 1080, duration: 3 });
  s.add({ type: "text", text: "A", label: "T" });
  applyOps(s, [{ op: "transition", layer: "T", in: "pop", out: "fade" }, { op: "preset", layer: "T", preset: "Vibrate Horizontal" }]);
  assert.equal(kids(s.find("T"), "effect").length, 3);
});

test("previewer handles every effect, decoration and blend in the real corpus", { skip: !corpusFiles.length }, () => {
  for (const f of corpusFiles) {
    const node = parseXml(readFileSync(join(corpus, f), "utf8"));
    assert.ok(validate(node).ok, f);
    const T = Number(node.attrs.totalTime) / 1000;
    for (const k of [0.25, 0.75]) assert.match(renderSVG(node, T * k), /^<svg/);
  }
});

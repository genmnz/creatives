import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { loadCatalog, buildSpecFile, ROOT } from "../src/node.mjs";
import { Scene } from "../src/builder.mjs";
import { parseXml, serializeXml, kid, kids } from "../src/xml.mjs";
import { validate } from "../src/validate.mjs";
import { renderSVG } from "../src/render.mjs";
import { normalizePath } from "../src/svgpath.mjs";
import { readKeyable, valueAt } from "../src/anim.mjs";
import { applyOps } from "../src/ops.mjs";

loadCatalog();

test("keyframe at= seconds becomes a fraction of the layer duration", () => {
  const s = new Scene({ width: 1080, height: 1080, duration: 5 });
  const n = s.add({ type: "shape", shape: "rect", start: 0.5, end: 4.5, animate: { rotation: [{ at: 0, v: 0 }, { at: 1.2, v: 90, ease: "easeOut" }] } });
  const kfs = kids(kid(kid(n, "transform"), "rotation"), "kf");
  assert.equal(kfs[1].attrs.t, "0.300000");
  assert.equal(kfs[1].attrs.e, "cubicBezier 0.0 0.0 0.58 1.0");
  assert.equal(kfs[0].attrs.e, undefined);
});

test("shape width/height are written as half-extents", () => {
  const s = new Scene({ width: 1080, height: 1080 });
  const n = s.add({ type: "shape", shape: "rect", width: 1080, height: 600 });
  assert.equal(kids(n, "property")[0].attrs.value, "540.000000,300.000000");
  assert.equal(n.attrs.s, ".rect");
});

test("SVG paths are normalized to absolute M/L/C/Z", () => {
  const d = normalizePath("m10 10 h20 v20 q 10 10 20 0 a 5 5 0 0 1 10 0 z");
  assert.match(d, /^M 10\.0 10\.0L 30\.0 10\.0L 30\.0 30\.0C /);
  assert.doesNotMatch(d, /[a-zHVQTSA]/);
  assert.match(d, /Z$/);
});

test("easing goes into the keyframe that carries it", () => {
  const k = readKeyable(parseXml('<rotation><kf t="0" v="0"/><kf t="1" v="100" e="cubicBezier 1.0 0.0 1.0 0.0"/></rotation>'));
  assert.ok(valueAt(k, 0.5) < 5); // hold-like curve stays low until the end
  assert.equal(valueAt(k, 1), 100);
});

test("validator flags keyframes written in seconds and short effect ids", () => {
  const xml = `<scene width="100" height="100" exportWidth="100" exportHeight="100" bgcolor="#FF000000" totalTime="5000" fps="30" ffver="106" amver="1">
    <shape id="1" label="a" startTime="0" endTime="5000" fillType="color" s=".rect"><transform><rotation><kf t="0" v="0"/><kf t="4.0" v="90"/></rotation></transform>
    <effect id="gaussianblur" locallyApplied="true"/></shape></scene>`;
  const r = validate(xml);
  assert.equal(r.ok, false);
  assert.ok(r.issues.some((i) => /not seconds/.test(i.msg)));
  assert.ok(r.issues.some((i) => /full id/.test(i.msg)));
});

test("failed edit operations leave the project unchanged", () => {
  const s = new Scene({ width: 100, height: 100 });
  s.add({ type: "text", label: "T", text: "x" });
  const before = serializeXml(s.node);
  assert.throws(() => applyOps(s, [{ op: "effect", layer: "T", effect: "Gaussian Blur", params: { nope: 1 } }]), /no parameter "nope"/);
  assert.equal(serializeXml(s.node), before);
});

test("XML round-trips without changes", () => {
  const xml = readFileSync(join(ROOT, "examples/out/07-showcase.xml"), "utf8");
  const once = serializeXml(parseXml(xml));
  assert.equal(serializeXml(parseXml(once)), once);
});

test("every example spec builds, validates and renders", () => {
  const dir = join(ROOT, "examples/specs");
  for (const f of readdirSync(dir).filter((x) => x.endsWith(".json"))) {
    const scene = buildSpecFile(join(dir, f));
    const r = validate(scene.node);
    assert.ok(r.ok, `${f}: ${JSON.stringify(r.issues)}`);
    assert.match(renderSVG(scene.node, scene.duration / 2), /^<svg /);
  }
});

// Optional: the app's own exports, from an apktool dump (not shipped here).
const presets = process.env.AM_PRESETS;
test("Alight Motion's own exports pass the validator", { skip: !presets || !existsSync(presets) }, () => {
  for (const f of readdirSync(presets).filter((x) => x.endsWith(".xml"))) {
    const r = validate(readFileSync(join(presets, f), "utf8"));
    assert.ok(r.ok, `${f}: ${JSON.stringify(r.issues.filter((i) => i.level === "error"))}`);
  }
});

test("MCP server lists tools and builds a project", async () => {
  const p = spawn("node", [join(ROOT, "mcp/server.mjs")], { stdio: ["pipe", "pipe", "inherit"] });
  const replies = [];
  let buf = "";
  const done = new Promise((res) => p.stdout.on("data", (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf("\n")) >= 0) { replies.push(JSON.parse(buf.slice(0, i))); buf = buf.slice(i + 1); }
    if (replies.length === 3) res();
  }));
  const send = (m) => p.stdin.write(JSON.stringify({ jsonrpc: "2.0", ...m }) + "\n");
  send({ id: 1, method: "initialize", params: {} });
  send({ id: 2, method: "tools/list" });
  send({ id: 3, method: "tools/call", params: { name: "am_build", arguments: { spec: { scene: { width: 500, height: 500, duration: 2 }, layers: [{ type: "text", text: "hi" }] } } } });
  await done;
  p.kill();
  assert.ok(replies[1].result.tools.some((t) => t.name === "am_export"));
  assert.match(replies[2].result.content[0].text, /checks: pass/);
});

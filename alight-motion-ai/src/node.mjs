// Node-only helpers: catalog loading, local media info, and zip packaging.

import { readFileSync, writeFileSync, existsSync, readdirSync, rmSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { renderSVG } from "./render.mjs";
import { createHash, randomUUID } from "node:crypto";
import { inflateRawSync } from "node:zlib";
import { basename, dirname, extname, resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import { setCatalog } from "./catalog.mjs";
import { setPresets } from "./presets.mjs";
import { Scene, buildFromSpec } from "./builder.mjs";
import { kids } from "./xml.mjs";

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

let loaded = false;
export function loadCatalog() {
  if (!loaded) {
    setCatalog(JSON.parse(readFileSync(join(ROOT, "catalog/catalog.json"), "utf8")));
    const pp = join(ROOT, "catalog/presets.json");
    if (existsSync(pp)) setPresets(JSON.parse(readFileSync(pp, "utf8")));
    loaded = true;
  }
}

const MIME = {
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp", ".gif": "image/gif",
  ".mp4": "video/mp4", ".mov": "video/quicktime", ".webm": "video/webm",
  ".mp3": "audio/mpeg", ".m4a": "audio/mp4", ".wav": "audio/x-wav", ".ogg": "audio/ogg", ".aac": "audio/aac",
};

/** Pixel size from PNG, JPEG, GIF or WebP headers. */
export function imageSize(buf) {
  if (buf.readUInt32BE(0) === 0x89504e47) return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
  if (buf.toString("ascii", 0, 3) === "GIF") return { width: buf.readUInt16LE(6), height: buf.readUInt16LE(8) };
  if (buf.toString("ascii", 0, 4) === "RIFF" && buf.toString("ascii", 8, 12) === "WEBP") {
    const fmt = buf.toString("ascii", 12, 16);
    if (fmt === "VP8X") return { width: 1 + buf.readUIntLE(24, 3), height: 1 + buf.readUIntLE(27, 3) };
    if (fmt === "VP8L") { const b = buf.readUInt32LE(21); return { width: (b & 0x3fff) + 1, height: ((b >> 14) & 0x3fff) + 1 }; }
    return { width: buf.readUInt16LE(26) & 0x3fff, height: buf.readUInt16LE(28) & 0x3fff };
  }
  if (buf[0] === 0xff && buf[1] === 0xd8) {
    let i = 2;
    while (i < buf.length) {
      if (buf[i] !== 0xff) { i++; continue; }
      const m = buf[i + 1];
      if (m >= 0xc0 && m <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(m)) return { height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7) };
      i += 2 + buf.readUInt16BE(i + 2);
    }
  }
  return { width: undefined, height: undefined };
}

/**
 * Media info for a local file, in the form the app writes into shared project
 * packages: uri = amproj:<file name>, sig = SHA-1 of the bytes (upper-case
 * hex), and the package carries the file under that name plus a manifest.txt
 * line "SIG:name". (The APK's own presets use am-internal:///<SIG>.<ext> for
 * media stored inside the app; that form is read but not written.)
 */
export function mediaInfoFromFile(path, baseDir = process.cwd()) {
  const full = resolve(baseDir, path);
  if (!existsSync(full)) throw new Error(`media file not found: ${full}`);
  const buf = readFileSync(full);
  const ext = extname(full).toLowerCase();
  const sig = createHash("sha1").update(buf).digest("hex").toUpperCase();
  const type = MIME[ext] ?? "application/octet-stream";
  const dims = type.startsWith("image/") ? imageSize(buf) : {};
  const name = basename(full).replace(/[\\/:*?"<>|\s]+/g, "_");
  return {
    uri: `amproj:${name}`, filename: name, title: basename(full),
    type, size: buf.length, sig, ...dims, localPath: full,
  };
}

export function newScene(opts = {}, baseDir = process.cwd()) {
  loadCatalog();
  return new Scene({ ...opts, mediaResolver: (src) => mediaInfoFromFile(src, baseDir) });
}

/** Read "src" of svg layers (recursively) into "svg" text, relative to base. */
export function inlineSvgFiles(layers, base) {
  for (const l of layers ?? []) {
    if (l.type === "svg" && !l.svg && l.src) l.svg = readFileSync(resolve(base, l.src), "utf8");
    if (l.layers) inlineSvgFiles(l.layers, base);
  }
  return layers;
}

export function buildSpecFile(specPath) {
  loadCatalog();
  const spec = JSON.parse(readFileSync(specPath, "utf8"));
  const base = dirname(resolve(specPath));
  inlineSvgFiles(spec.layers, base);
  return buildFromSpec(spec, { mediaResolver: (src) => mediaInfoFromFile(src, base) });
}

export function openXml(path, mediaDir) {
  loadCatalog();
  if (/\.zip$/i.test(path)) return openPackage(path);
  const scene = Scene.parse(readFileSync(path, "utf8"), { mediaResolver: (src) => mediaInfoFromFile(src, dirname(resolve(path))) });
  linkMedia(scene, mediaDir ?? dirname(resolve(path)));
  return scene;
}

/** Open a package zip: media files are unpacked to a temp folder for previews and re-export. */
export function openPackage(path) {
  const { xml, files } = unzip(readFileSync(path));
  const dir = mkdtempSync(join(tmpdir(), "amx-"));
  for (const [name, data] of files) if (!name.includes("/") && !name.endsWith(".xml")) writeFileSync(join(dir, name), data);
  const scene = Scene.parse(xml, { mediaResolver: (src) => mediaInfoFromFile(src, dirname(resolve(path))) });
  linkMedia(scene, dir);
  return scene;
}

/** Point media uris at local files found next to the project (by filename or title). */
export function linkMedia(scene, dir) {
  for (const m of kids(scene.node, "media")) {
    if (scene.mediaFiles.has(m.attrs.uri)) continue;
    for (const name of [m.attrs.uri?.startsWith("amproj:") ? m.attrs.uri.slice(7) : null, m.attrs.filename, m.attrs.title, m.attrs.uri?.split("/").pop()]) {
      if (name && existsSync(join(dir, name))) { scene.mediaFiles.set(m.attrs.uri, join(dir, name)); break; }
    }
  }
}

// ----- zip (stored, no compression; enough for a project package) -----

const CRC = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; }
  return t;
})();
const crc32 = (b) => { let c = 0xffffffff; for (const x of b) c = CRC[(c ^ x) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };

export function zip(files) {
  const parts = [], central = [];
  let offset = 0;
  for (const { name, data } of files) {
    const nameBuf = Buffer.from(name, "utf8"), crc = crc32(data);
    const h = Buffer.alloc(30);
    h.writeUInt32LE(0x04034b50, 0); h.writeUInt16LE(20, 4); h.writeUInt16LE(0x0800, 6); h.writeUInt16LE(0, 8);
    h.writeUInt32LE(0, 10); h.writeUInt32LE(crc, 14); h.writeUInt32LE(data.length, 18); h.writeUInt32LE(data.length, 22);
    h.writeUInt16LE(nameBuf.length, 26); h.writeUInt16LE(0, 28);
    parts.push(h, nameBuf, data);
    const c = Buffer.alloc(46);
    c.writeUInt32LE(0x02014b50, 0); c.writeUInt16LE(20, 4); c.writeUInt16LE(20, 6); c.writeUInt16LE(0x0800, 8);
    c.writeUInt16LE(0, 10); c.writeUInt32LE(0, 12); c.writeUInt32LE(crc, 16); c.writeUInt32LE(data.length, 20);
    c.writeUInt32LE(data.length, 24); c.writeUInt16LE(nameBuf.length, 28); c.writeUInt32LE(offset, 42);
    central.push(c, nameBuf);
    offset += 30 + nameBuf.length + data.length;
  }
  const cd = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, cd, end]);
}

/**
 * Write <name>.xml, and when the project uses media also <name>.zip laid out
 * like the packages the app shares: <uuid>.xml, manifest.txt ("SIG:file" per
 * line) and each media file under its amproj: name.
 */
export function writeProject(scene, outXml) {
  const xml = scene.toXML();
  writeFileSync(outXml, xml);
  const written = [outXml];
  const media = kids(scene.node, "media");
  if (media.length) {
    const files = [{ name: `${randomUUID()}.xml`, data: Buffer.from(xml) }];
    const manifest = [];
    for (const m of media) {
      const src = scene.mediaFiles.get(m.attrs.uri);
      if (!src || !existsSync(src)) continue;
      const name = m.attrs.uri.startsWith("amproj:") ? m.attrs.uri.slice(7) : m.attrs.filename ?? basename(src);
      const data = readFileSync(src);
      files.push({ name, data });
      manifest.push(`${m.attrs.sig ?? createHash("sha1").update(data).digest("hex").toUpperCase()}:${name}`);
    }
    files.splice(1, 0, { name: "manifest.txt", data: Buffer.from(manifest.join("\n")) });
    const zipPath = outXml.replace(/\.xml$/i, "") + ".zip";
    writeFileSync(zipPath, zip(files));
    written.push(zipPath);
  }
  return written;
}

/** Read a package zip (stored or deflated): returns {xml, files: Map(name -> Buffer)}. */
export function unzip(buf) {
  const files = new Map();
  let eocd = buf.length - 22;
  while (eocd >= 0 && buf.readUInt32LE(eocd) !== 0x06054b50) eocd--;
  if (eocd < 0) throw new Error("not a zip file");
  let p = buf.readUInt32LE(eocd + 16);
  const count = buf.readUInt16LE(eocd + 10);
  for (let i = 0; i < count; i++) {
    const method = buf.readUInt16LE(p + 10), size = buf.readUInt32LE(p + 20);
    const nl = buf.readUInt16LE(p + 28), xl = buf.readUInt16LE(p + 30), cl = buf.readUInt16LE(p + 32);
    const off = buf.readUInt32LE(p + 42);
    const name = buf.toString("utf8", p + 46, p + 46 + nl);
    const dataStart = off + 30 + buf.readUInt16LE(off + 26) + buf.readUInt16LE(off + 28);
    const raw = buf.subarray(dataStart, dataStart + size);
    if (!name.endsWith("/")) files.set(name, method === 8 ? inflateRawSync(raw) : Buffer.from(raw));
    p += 46 + nl + xl + cl;
  }
  const xmlName = [...files.keys()].find((n) => n.toLowerCase().endsWith(".xml") && !n.includes("/"));
  if (!xmlName) throw new Error("package has no project .xml");
  return { xmlName, xml: files.get(xmlName).toString("utf8"), files };
}

// ----- rendering to files -----

export function chrome() {
  // Prefer a headless shell: its --window-size is the exact viewport.
  const pw = "/opt/pw-browsers";
  const found = existsSync(pw) ? readdirSync(pw).flatMap((d) => [
    join(pw, d, "chrome-linux/headless_shell"), join(pw, d, "chrome-headless-shell-linux64/chrome-headless-shell"), join(pw, d, "chrome-linux/chrome"),
  ]).sort((a, b) => b.includes("headless") - a.includes("headless")) : [];
  for (const p of [process.env.CHROME, ...found, "/usr/bin/chromium", "/usr/bin/chromium-browser", "/usr/bin/google-chrome"]) {
    if (p && existsSync(p)) return p;
  }
  return null;
}

/** Rasterize an SVG string to PNG with headless Chromium. */
export function svgToPng(svg, out, w, h) {
  const bin = chrome();
  if (!bin) throw new Error("PNG needs Chromium (set CHROME=/path/to/chrome); write .svg instead");
  const tmp = out.replace(/\.png$/i, ".tmp.html");
  writeFileSync(tmp, `<html><body style="margin:0;background:#000;overflow:hidden">${svg.replace("<svg ", `<svg style="display:block" width="${w}" height="${h}" `)}</body></html>`);
  const headless = bin.includes("headless") ? [] : ["--headless"];
  execFileSync(bin, [...headless, "--no-sandbox", "--disable-gpu", "--hide-scrollbars", `--window-size=${w},${h}`, "--virtual-time-budget=3000", `--screenshot=${resolve(out)}`, `file://${resolve(tmp)}`], { stdio: "ignore" });
  rmSync(tmp, { force: true });
}

export function mediaHrefFor(scene) {
  return (uri) => {
    const p = scene.mediaFiles.get(uri);
    if (!p) return null;
    if (p.startsWith("data:")) return p;
    const ext = extname(p).slice(1).toLowerCase().replace("jpg", "jpeg");
    return `data:image/${ext};base64,${readFileSync(p).toString("base64")}`;
  };
}

export function renderOut(scene, t, out, width) {
  const svg = renderSVG(scene.node, t, { mediaHref: mediaHrefFor(scene) });
  if (out.toLowerCase().endsWith(".png")) {
    const w = Number(width ?? Math.min(scene.width, 1080));
    svgToPng(svg, out, w, Math.round((w * scene.height) / scene.width));
  } else writeFileSync(out, svg);
  return out;
}


// Node-only helpers: catalog loading, local media info, and zip packaging.

import { readFileSync, writeFileSync, existsSync, readdirSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { renderSVG } from "./render.mjs";
import { createHash } from "node:crypto";
import { basename, dirname, extname, resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import { setCatalog } from "./catalog.mjs";
import { Scene, buildFromSpec } from "./builder.mjs";
import { kids } from "./xml.mjs";

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

let loaded = false;
export function loadCatalog() {
  if (!loaded) {
    setCatalog(JSON.parse(readFileSync(join(ROOT, "catalog/catalog.json"), "utf8")));
    loaded = true;
  }
}

const MIME = {
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp", ".gif": "image/gif",
  ".mp4": "video/mp4", ".mov": "video/quicktime", ".webm": "video/webm",
  ".mp3": "audio/mpeg", ".m4a": "audio/mp4", ".wav": "audio/wav", ".ogg": "audio/ogg", ".aac": "audio/aac",
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
 * Media info for a local file, in the form the app uses for packaged projects:
 * the content hash (SHA-1, upper-case hex) is the signature and the internal
 * file name, so uri = am-internal:///<SIG>.<ext>.
 */
export function mediaInfoFromFile(path, baseDir = process.cwd()) {
  const full = resolve(baseDir, path);
  if (!existsSync(full)) throw new Error(`media file not found: ${full}`);
  const buf = readFileSync(full);
  const ext = extname(full).toLowerCase();
  const sig = createHash("sha1").update(buf).digest("hex").toUpperCase();
  const type = MIME[ext] ?? "application/octet-stream";
  const dims = type.startsWith("image/") ? imageSize(buf) : {};
  return {
    uri: `am-internal:///${sig}${ext}`, filename: `${sig}${ext}`, title: basename(full),
    type, size: buf.length, sig, ...dims, localPath: full,
  };
}

export function newScene(opts = {}, baseDir = process.cwd()) {
  loadCatalog();
  return new Scene({ ...opts, mediaResolver: (src) => mediaInfoFromFile(src, baseDir) });
}

export function buildSpecFile(specPath) {
  loadCatalog();
  const spec = JSON.parse(readFileSync(specPath, "utf8"));
  const base = dirname(resolve(specPath));
  return buildFromSpec(spec, { mediaResolver: (src) => mediaInfoFromFile(src, base) });
}

export function openXml(path, mediaDir) {
  loadCatalog();
  const scene = Scene.parse(readFileSync(path, "utf8"), { mediaResolver: (src) => mediaInfoFromFile(src, dirname(resolve(path))) });
  linkMedia(scene, mediaDir ?? dirname(resolve(path)));
  return scene;
}

/** Point media uris at local files found next to the project (by filename or title). */
export function linkMedia(scene, dir) {
  for (const m of kids(scene.node, "media")) {
    if (scene.mediaFiles.has(m.attrs.uri)) continue;
    for (const name of [m.attrs.filename, m.attrs.title, m.attrs.uri?.split("/").pop()]) {
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

/** Write <name>.xml plus, when the project uses media, <name>.zip with the XML and media files. */
export function writeProject(scene, outXml) {
  const xml = scene.toXML();
  writeFileSync(outXml, xml);
  const written = [outXml];
  const media = kids(scene.node, "media");
  if (media.length) {
    const files = [{ name: basename(outXml), data: Buffer.from(xml) }];
    for (const m of media) {
      const src = scene.mediaFiles.get(m.attrs.uri);
      if (src && existsSync(src)) files.push({ name: m.attrs.filename, data: readFileSync(src) });
    }
    const zipPath = outXml.replace(/\.xml$/i, "") + ".zip";
    writeFileSync(zipPath, zip(files));
    written.push(zipPath);
  }
  return written;
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


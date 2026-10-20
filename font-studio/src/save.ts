// Saving files: a normal browser download, or, inside a claude.ai artifact (where pages may not
// start downloads), the viewer's `downloads` capability. That capability accepts .ttf and .zip,
// so web fonts (.woff/.woff2) are delivered inside a zip there.

export interface OutFile { name: string; bytes: Uint8Array; }

let capability: Promise<any> | null = null;
/** Resolve the artifact downloads capability once (null outside an artifact viewer). */
export function downloadsCapability(): Promise<any> {
  return (capability ??= (async () => {
    const c = (window as any).claude;
    if (!c?.use) return null;
    try { return await c.use('downloads'); } catch { return null; }
  })());
}

function anchorDownload(f: OutFile) {
  const url = URL.createObjectURL(new Blob([f.bytes]));
  const a = document.createElement('a');
  a.href = url; a.download = f.name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

/** Returns a sentence describing what happened; throws with a readable message on failure. */
export async function saveFiles(files: OutFile[], zipName: string): Promise<string> {
  const dl = await downloadsCapability();
  if (!dl) {
    files.forEach(anchorDownload);
    return `Downloaded ${files.map((f) => f.name).join(', ')}.`;
  }
  const direct = files.length === 1 && /\.(ttf|zip)$/i.test(files[0].name);
  const file = direct ? files[0] : { name: zipName, bytes: zip(files) };
  try {
    await dl.save({ filename: file.name, data: new Blob([file.bytes]) });
    return direct ? `Saved ${file.name}.` : `Saved ${file.name} (${files.map((f) => f.name).join(', ')}).`;
  } catch (e: any) {
    const code = e?.code;
    if (code === 'declined') throw new Error('Save cancelled.');
    if (code === 'rate_limited') throw new Error('A save prompt is already open. Finish it, then save again.');
    throw new Error(`This view cannot save files (${code ?? e?.message ?? e}).`);
  }
}

// ------------------------------------------------------------ zip (stored, no compression)

const CRC = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; }
  return t;
})();
function crc32(b: Uint8Array) {
  let c = 0xffffffff;
  for (let i = 0; i < b.length; i++) c = CRC[(c ^ b[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

export function zip(files: OutFile[]): Uint8Array {
  const enc = new TextEncoder();
  const parts: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;
  for (const f of files) {
    const name = enc.encode(f.name);
    const crc = crc32(f.bytes);
    const local = new DataView(new ArrayBuffer(30));
    local.setUint32(0, 0x04034b50, true); local.setUint16(4, 20, true); local.setUint16(8, 0, true);
    local.setUint32(14, crc, true); local.setUint32(18, f.bytes.length, true); local.setUint32(22, f.bytes.length, true);
    local.setUint16(26, name.length, true);
    parts.push(new Uint8Array(local.buffer), name, f.bytes);
    const cen = new DataView(new ArrayBuffer(46));
    cen.setUint32(0, 0x02014b50, true); cen.setUint16(4, 20, true); cen.setUint16(6, 20, true);
    cen.setUint32(16, crc, true); cen.setUint32(20, f.bytes.length, true); cen.setUint32(24, f.bytes.length, true);
    cen.setUint16(28, name.length, true); cen.setUint32(42, offset, true);
    central.push(new Uint8Array(cen.buffer), name);
    offset += 30 + name.length + f.bytes.length;
  }
  const cenSize = central.reduce((s, b) => s + b.length, 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true); end.setUint16(8, files.length, true); end.setUint16(10, files.length, true);
  end.setUint32(12, cenSize, true); end.setUint32(16, offset, true);
  const all = [...parts, ...central, new Uint8Array(end.buffer)];
  const out = new Uint8Array(all.reduce((s, b) => s + b.length, 0));
  let p = 0;
  for (const b of all) { out.set(b, p); p += b.length; }
  return out;
}

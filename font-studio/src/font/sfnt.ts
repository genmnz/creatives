// SFNT container: read TTF/OTF/TTC/WOFF/WOFF2, write TTF/WOFF/WOFF2.
import { Reader, Writer, checksum } from './binary.ts';

export type Tables = Map<string, Uint8Array>;
export interface Sfnt { flavor: number; tables: Tables; }

export const FLAVOR_TT = 0x00010000;
export const FLAVOR_CFF = 0x4f54544f; // 'OTTO'

export function detectFormat(b: Uint8Array): 'ttf' | 'otf' | 'ttc' | 'woff' | 'woff2' | 'unknown' {
  if (b.length < 4) return 'unknown';
  const t = String.fromCharCode(b[0], b[1], b[2], b[3]);
  if (t === 'wOFF') return 'woff';
  if (t === 'wOF2') return 'woff2';
  if (t === 'ttcf') return 'ttc';
  if (t === 'OTTO') return 'otf';
  if ((b[0] === 0 && b[1] === 1 && b[2] === 0 && b[3] === 0) || t === 'true') return 'ttf';
  return 'unknown';
}

/** Turn any supported font file into plain sfnt bytes. */
export async function toSfntBytes(input: Uint8Array): Promise<Uint8Array> {
  const fmt = detectFormat(input);
  if (fmt === 'woff') return decodeWoff(input);
  if (fmt === 'woff2') {
    const { decompressWoff2 } = await import('./woff2.ts');
    return decompressWoff2(input);
  }
  if (fmt === 'ttc') {
    // first font of the collection, re-packed as a standalone sfnt
    const r = new Reader(input);
    r.seek(12);
    const off = r.u32();
    const s = readSfnt(input, off);
    return writeSfnt(s.tables, s.flavor);
  }
  if (fmt === 'unknown') throw new Error('Not a font file (expected TTF, OTF, TTC, WOFF or WOFF2).');
  return input;
}

export function readSfnt(data: Uint8Array, start = 0): Sfnt {
  const r = new Reader(data, start);
  const flavor = r.u32();
  const numTables = r.u16();
  r.pos += 6;
  const tables: Tables = new Map();
  for (let i = 0; i < numTables; i++) {
    const tag = r.tag();
    r.u32(); // checksum
    const offset = r.u32();
    const length = r.u32();
    if (offset + length > data.length) throw new Error(`Table ${tag} runs past the end of the file.`);
    tables.set(tag, data.slice(offset, offset + length));
  }
  return { flavor, tables };
}

export function writeSfnt(tables: Tables, flavor = FLAVOR_TT): Uint8Array {
  const tags = [...tables.keys()].sort();
  const n = tags.length;
  let es = 0;
  while (1 << (es + 1) <= n) es++;
  const searchRange = (1 << es) * 16;
  const w = new Writer(1 << 20);
  w.u32(flavor).u16(n).u16(searchRange).u16(es).u16(n * 16 - searchRange);
  let offset = 12 + n * 16;
  const dirPos: number[] = [];
  for (const tag of tags) {
    const t = tables.get(tag)!;
    dirPos.push(w.length);
    w.tag(tag).u32(tag === 'head' ? checksum(zeroAdjust(t)) : checksum(t)).u32(offset).u32(t.length);
    offset += (t.length + 3) & ~3;
  }
  let headPos = -1;
  for (const tag of tags) {
    if (tag === 'head') headPos = w.length;
    w.bytes(tables.get(tag)!).pad(4);
  }
  const out = w.done();
  if (headPos >= 0) {
    const view = new DataView(out.buffer);
    view.setUint32(headPos + 8, 0);
    const adj = (0xb1b0afba - checksum(out)) >>> 0;
    view.setUint32(headPos + 8, adj);
  }
  return out;
}

function zeroAdjust(head: Uint8Array) {
  const c = head.slice();
  new DataView(c.buffer).setUint32(8, 0);
  return c;
}

// ---------------------------------------------------------------- WOFF 1.0

async function inflate(data: Uint8Array): Promise<Uint8Array> {
  const ds = new DecompressionStream('deflate');
  const out = new Response(new Blob([data]).stream().pipeThrough(ds));
  return new Uint8Array(await out.arrayBuffer());
}

async function deflate(data: Uint8Array): Promise<Uint8Array> {
  const cs = new CompressionStream('deflate');
  const out = new Response(new Blob([data]).stream().pipeThrough(cs));
  return new Uint8Array(await out.arrayBuffer());
}

export async function decodeWoff(data: Uint8Array): Promise<Uint8Array> {
  const r = new Reader(data);
  r.u32();
  const flavor = r.u32();
  r.u32();
  const numTables = r.u16();
  r.pos = 44;
  const tables: Tables = new Map();
  for (let i = 0; i < numTables; i++) {
    const tag = r.tag();
    const off = r.u32();
    const compLength = r.u32();
    const origLength = r.u32();
    r.u32();
    const raw = data.subarray(off, off + compLength);
    tables.set(tag, compLength < origLength ? await inflate(raw) : raw.slice());
  }
  return writeSfnt(tables, flavor);
}

export async function encodeWoff(sfnt: Uint8Array): Promise<Uint8Array> {
  const s = readSfnt(sfnt);
  const tags = [...s.tables.keys()].sort();
  const entries: { tag: string; data: Uint8Array; orig: Uint8Array }[] = [];
  for (const tag of tags) {
    const orig = s.tables.get(tag)!;
    const comp = await deflate(orig);
    entries.push({ tag, orig, data: comp.length < orig.length ? comp : orig });
  }
  const w = new Writer(sfnt.length + 1024);
  w.tag('wOFF').u32(s.flavor).u32(0).u16(tags.length).u16(0).u32(sfnt.length).u16(1).u16(0);
  w.u32(0).u32(0).u32(0).u32(0).u32(0);
  let off = 44 + 20 * tags.length;
  for (const e of entries) {
    w.tag(e.tag).u32(off).u32(e.data.length).u32(e.orig.length).u32(checksum(e.orig));
    off += (e.data.length + 3) & ~3;
  }
  for (const e of entries) w.bytes(e.data).pad(4);
  const out = w.done();
  new DataView(out.buffer).setUint32(8, out.length);
  return out;
}

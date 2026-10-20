// Parsers and writers for the core tables the studio edits.
import { Reader, Writer } from './binary.ts';

// ------------------------------------------------------------------ fields
type FieldType = 'u8' | 'u16' | 'i16' | 'u32' | 'i32' | 'fixed' | 'tag' | 'date' | 'panose';
type FieldSpec = [name: string, type: FieldType, minVersion?: number];

function readFields(r: Reader, spec: FieldSpec[], version = 0): Record<string, any> {
  const o: Record<string, any> = {};
  for (const [name, type, minV] of spec) {
    if (minV !== undefined && version < minV) continue;
    if (r.pos >= r.data.length) break;
    o[name] = readField(r, type);
  }
  return o;
}

function readField(r: Reader, t: FieldType): any {
  switch (t) {
    case 'u8': return r.u8();
    case 'u16': return r.u16();
    case 'i16': return r.i16();
    case 'u32': return r.u32();
    case 'i32': return r.i32();
    case 'fixed': return r.u32();
    case 'tag': return r.tag();
    case 'date': { const hi = r.u32(), lo = r.u32(); return hi * 4294967296 + lo; }
    case 'panose': return Array.from(r.bytes(10));
  }
}

function writeFields(w: Writer, spec: FieldSpec[], o: Record<string, any>, version = 0) {
  for (const [name, type, minV] of spec) {
    if (minV !== undefined && version < minV) continue;
    const v = o[name] ?? 0;
    switch (type) {
      case 'u8': w.u8(v); break;
      case 'u16': w.u16(Math.max(0, Math.min(65535, Math.round(v)))); break;
      case 'i16': w.i16(v); break;
      case 'u32': w.u32(v); break;
      case 'i32': w.i32(v); break;
      case 'fixed': w.u32(v); break;
      case 'tag': w.tag(String(v || '    ').padEnd(4, ' ').slice(0, 4)); break;
      case 'date': w.u32(Math.floor(v / 4294967296)).u32(v % 4294967296); break;
      case 'panose': for (let i = 0; i < 10; i++) w.u8((v as number[])[i] ?? 0); break;
    }
  }
}

// -------------------------------------------------------------------- head
const HEAD: FieldSpec[] = [
  ['majorVersion', 'u16'], ['minorVersion', 'u16'], ['fontRevision', 'fixed'],
  ['checkSumAdjustment', 'u32'], ['magicNumber', 'u32'], ['flags', 'u16'], ['unitsPerEm', 'u16'],
  ['created', 'date'], ['modified', 'date'], ['xMin', 'i16'], ['yMin', 'i16'], ['xMax', 'i16'],
  ['yMax', 'i16'], ['macStyle', 'u16'], ['lowestRecPPEM', 'u16'], ['fontDirectionHint', 'i16'],
  ['indexToLocFormat', 'i16'], ['glyphDataFormat', 'i16'],
];
export const parseHead = (d: Uint8Array) => readFields(new Reader(d), HEAD);
export function writeHead(o: Record<string, any>) {
  const w = new Writer(64);
  writeFields(w, HEAD, { ...o, magicNumber: 0x5f0f3cf5, checkSumAdjustment: 0 });
  return w.done();
}
/** Seconds since 1904-01-01, as stored in head.created/modified. */
export const nowLongDateTime = () => Math.floor(Date.now() / 1000) + 2082844800;

// -------------------------------------------------------------------- hhea
const HHEA: FieldSpec[] = [
  ['version', 'u32'], ['ascender', 'i16'], ['descender', 'i16'], ['lineGap', 'i16'],
  ['advanceWidthMax', 'u16'], ['minLeftSideBearing', 'i16'], ['minRightSideBearing', 'i16'],
  ['xMaxExtent', 'i16'], ['caretSlopeRise', 'i16'], ['caretSlopeRun', 'i16'], ['caretOffset', 'i16'],
  ['r0', 'i16'], ['r1', 'i16'], ['r2', 'i16'], ['r3', 'i16'], ['metricDataFormat', 'i16'],
  ['numberOfHMetrics', 'u16'],
];
export const parseHhea = (d: Uint8Array) => readFields(new Reader(d), HHEA);
export function writeHhea(o: Record<string, any>) { const w = new Writer(40); writeFields(w, HHEA, o); return w.done(); }

// -------------------------------------------------------------------- maxp
const MAXP1: FieldSpec[] = [
  ['maxPoints', 'u16'], ['maxContours', 'u16'], ['maxCompositePoints', 'u16'],
  ['maxCompositeContours', 'u16'], ['maxZones', 'u16'], ['maxTwilightPoints', 'u16'],
  ['maxStorage', 'u16'], ['maxFunctionDefs', 'u16'], ['maxInstructionDefs', 'u16'],
  ['maxStackElements', 'u16'], ['maxSizeOfInstructions', 'u16'], ['maxComponentElements', 'u16'],
  ['maxComponentDepth', 'u16'],
];
export function parseMaxp(d: Uint8Array) {
  const r = new Reader(d);
  const version = r.u32();
  const numGlyphs = r.u16();
  const o: Record<string, any> = { version, numGlyphs };
  if (version === 0x00010000) Object.assign(o, readFields(r, MAXP1));
  return o;
}
export function writeMaxp(o: Record<string, any>) {
  const w = new Writer(40);
  w.u32(0x00010000).u16(o.numGlyphs);
  writeFields(w, MAXP1, { maxZones: 2, ...o });
  return w.done();
}

// -------------------------------------------------------------------- OS/2
export const OS2: FieldSpec[] = [
  ['version', 'u16'], ['xAvgCharWidth', 'i16'], ['usWeightClass', 'u16'], ['usWidthClass', 'u16'],
  ['fsType', 'u16'], ['ySubscriptXSize', 'i16'], ['ySubscriptYSize', 'i16'],
  ['ySubscriptXOffset', 'i16'], ['ySubscriptYOffset', 'i16'], ['ySuperscriptXSize', 'i16'],
  ['ySuperscriptYSize', 'i16'], ['ySuperscriptXOffset', 'i16'], ['ySuperscriptYOffset', 'i16'],
  ['yStrikeoutSize', 'i16'], ['yStrikeoutPosition', 'i16'], ['sFamilyClass', 'i16'],
  ['panose', 'panose'], ['ulUnicodeRange1', 'u32'], ['ulUnicodeRange2', 'u32'],
  ['ulUnicodeRange3', 'u32'], ['ulUnicodeRange4', 'u32'], ['achVendID', 'tag'],
  ['fsSelection', 'u16'], ['usFirstCharIndex', 'u16'], ['usLastCharIndex', 'u16'],
  ['sTypoAscender', 'i16'], ['sTypoDescender', 'i16'], ['sTypoLineGap', 'i16'],
  ['usWinAscent', 'u16'], ['usWinDescent', 'u16'],
  ['ulCodePageRange1', 'u32', 1], ['ulCodePageRange2', 'u32', 1],
  ['sxHeight', 'i16', 2], ['sCapHeight', 'i16', 2], ['usDefaultChar', 'u16', 2],
  ['usBreakChar', 'u16', 2], ['usMaxContext', 'u16', 2],
  ['usLowerOpticalPointSize', 'u16', 5], ['usUpperOpticalPointSize', 'u16', 5],
];
export function parseOS2(d: Uint8Array) {
  const version = new Reader(d).u16();
  return readFields(new Reader(d), OS2, version);
}
export function writeOS2(o: Record<string, any>) {
  const w = new Writer(110);
  writeFields(w, OS2, o, o.version);
  return w.done();
}

// -------------------------------------------------------------------- name
export interface NameRecord { platformID: number; encodingID: number; languageID: number; nameID: number; value: string; }

const MAC_ROMAN_HIGH =
  'ÄÅÇÉÑÖÜáàâäãåçéèêëíìîïñóòôöõúùûü†°¢£§•¶ß®©™´¨≠ÆØ∞±≤≥¥µ∂∑∏π∫ªºΩæø¿¡¬√ƒ≈∆«»… ÀÃÕŒœ–—“”‘’÷◊ÿŸ⁄€‹›ﬁﬂ‡·‚„‰ÂÊÁËÈÍÎÏÌÓÔÓÒÚÛÙıˆ˜¯˘˙˚¸˝˛ˇ';

function decodeName(b: Uint8Array, platformID: number, encodingID: number) {
  if (platformID === 0 || platformID === 3) {
    let s = '';
    for (let i = 0; i + 1 < b.length; i += 2) s += String.fromCharCode((b[i] << 8) | b[i + 1]);
    return s;
  }
  if (platformID === 1 && encodingID === 0) {
    let s = '';
    for (const c of b) s += c < 128 ? String.fromCharCode(c) : MAC_ROMAN_HIGH[c - 128] ?? '?';
    return s;
  }
  return Array.from(b, (c) => String.fromCharCode(c)).join('');
}

function encodeName(s: string, platformID: number) {
  if (platformID === 1) {
    return Uint8Array.from(s, (ch) => {
      const c = ch.charCodeAt(0);
      if (c < 128) return c;
      const i = MAC_ROMAN_HIGH.indexOf(ch);
      return i >= 0 ? 128 + i : 63;
    });
  }
  const out = new Uint8Array(s.length * 2);
  for (let i = 0; i < s.length; i++) { out[2 * i] = s.charCodeAt(i) >> 8; out[2 * i + 1] = s.charCodeAt(i) & 255; }
  return out;
}

export function parseName(d: Uint8Array): NameRecord[] {
  const r = new Reader(d);
  r.u16();
  const count = r.u16();
  const strOff = r.u16();
  const recs: NameRecord[] = [];
  for (let i = 0; i < count; i++) {
    const platformID = r.u16(), encodingID = r.u16(), languageID = r.u16(), nameID = r.u16();
    const length = r.u16(), offset = r.u16();
    const b = d.subarray(strOff + offset, strOff + offset + length);
    recs.push({ platformID, encodingID, languageID, nameID, value: decodeName(b, platformID, encodingID) });
  }
  return recs;
}

export function writeName(recs: NameRecord[]) {
  const sorted = [...recs].filter((r) => r.languageID < 0x8000).sort((a, b) =>
    a.platformID - b.platformID || a.encodingID - b.encodingID || a.languageID - b.languageID || a.nameID - b.nameID);
  const strings = new Writer(4096);
  const seen = new Map<string, number>();
  const w = new Writer(4096);
  w.u16(0).u16(sorted.length).u16(6 + 12 * sorted.length);
  for (const rec of sorted) {
    const bytes = encodeName(rec.value, rec.platformID);
    const key = rec.platformID + ':' + Array.from(bytes).join(',');
    let off = seen.get(key);
    if (off === undefined) { off = strings.length; seen.set(key, off); strings.bytes(bytes); }
    w.u16(rec.platformID).u16(rec.encodingID).u16(rec.languageID).u16(rec.nameID).u16(bytes.length).u16(off);
  }
  w.bytes(strings.done());
  return w.done();
}

export const NAME_IDS: Record<number, string> = {
  0: 'Copyright', 1: 'Family', 2: 'Subfamily', 3: 'Unique ID', 4: 'Full name', 5: 'Version',
  6: 'PostScript name', 7: 'Trademark', 8: 'Manufacturer', 9: 'Designer', 10: 'Description',
  11: 'Vendor URL', 12: 'Designer URL', 13: 'License', 14: 'License URL', 16: 'Typographic family',
  17: 'Typographic subfamily', 18: 'Compatible full (Mac)', 19: 'Sample text', 21: 'WWS family',
  22: 'WWS subfamily', 25: 'Variations PS prefix',
};

// -------------------------------------------------------------------- post
import { MAC_GLYPH_NAMES } from './macnames.ts';

export function parsePost(d: Uint8Array, numGlyphs: number) {
  const r = new Reader(d);
  const version = r.u32();
  const o: Record<string, any> = {
    version, italicAngle: r.i32() / 65536, underlinePosition: r.i16(), underlineThickness: r.i16(),
    isFixedPitch: r.u32(),
  };
  let names: string[] | null = null;
  if (version === 0x00010000) names = MAC_GLYPH_NAMES.slice(0, numGlyphs);
  else if (version === 0x00020000 && d.length > 34) {
    r.pos = 32;
    const n = r.u16();
    const idx: number[] = [];
    for (let i = 0; i < n; i++) idx.push(r.u16());
    const extra: string[] = [];
    while (r.pos < d.length) {
      const len = r.u8();
      let s = '';
      for (let i = 0; i < len && r.pos < d.length; i++) s += String.fromCharCode(r.u8());
      extra.push(s);
    }
    names = idx.map((i) => (i < 258 ? MAC_GLYPH_NAMES[i] : extra[i - 258] ?? ''));
  }
  return { info: o, names };
}

export function writePost(info: Record<string, any>, names: string[] | null) {
  const w = new Writer(names ? names.length * 12 + 64 : 40);
  w.u32(names ? 0x00020000 : 0x00030000).fixed(info.italicAngle ?? 0)
    .i16(info.underlinePosition ?? 0).i16(info.underlineThickness ?? 0).u32(info.isFixedPitch ?? 0)
    .u32(0).u32(0).u32(0).u32(0);
  if (names) {
    const std = new Map(MAC_GLYPH_NAMES.map((n, i) => [n, i]));
    const extra: string[] = [];
    const extraIdx = new Map<string, number>();
    w.u16(names.length);
    for (const n of names) {
      const s = std.get(n);
      if (s !== undefined) { w.u16(s); continue; }
      let e = extraIdx.get(n);
      if (e === undefined) { e = extra.length; extra.push(n); extraIdx.set(n, e); }
      w.u16(258 + e);
    }
    for (const n of extra) {
      const s = n.slice(0, 255);
      w.u8(s.length);
      for (const ch of s) w.u8(ch.charCodeAt(0) & 0x7f);
    }
  }
  return w.done();
}

// -------------------------------------------------------------------- cmap
export function parseCmap(d: Uint8Array): Map<number, number> {
  const r = new Reader(d);
  r.u16();
  const n = r.u16();
  const subs: { p: number; e: number; off: number; fmt: number }[] = [];
  for (let i = 0; i < n; i++) {
    const p = r.u16(), e = r.u16(), off = r.u32();
    subs.push({ p, e, off, fmt: r.u16At(off) });
  }
  const rank = (s: { p: number; e: number; fmt: number }) =>
    s.fmt === 12 && (s.p === 3 && s.e === 10 || s.p === 0) ? 0 :
    s.fmt === 4 && (s.p === 3 && s.e === 1 || s.p === 0) ? 1 :
    s.fmt === 6 || s.fmt === 4 ? 2 : s.fmt === 0 ? 3 : 9;
  subs.sort((a, b) => rank(a) - rank(b));
  const map = new Map<number, number>();
  for (const s of subs) {
    if (rank(s) === 9) continue;
    readCmapSub(d, s.off, map);
    if (map.size) break;
  }
  return map;
}

function readCmapSub(d: Uint8Array, off: number, map: Map<number, number>) {
  const r = new Reader(d, off);
  const fmt = r.u16();
  if (fmt === 4) {
    r.u16(); r.u16();
    const segX2 = r.u16();
    const seg = segX2 / 2;
    r.pos += 6;
    const endP = r.pos, startP = endP + segX2 + 2, deltaP = startP + segX2, rangeP = deltaP + segX2;
    for (let i = 0; i < seg; i++) {
      const end = r.u16At(endP + 2 * i), start = r.u16At(startP + 2 * i);
      const delta = r.i16At(deltaP + 2 * i), ro = r.u16At(rangeP + 2 * i);
      for (let c = start; c <= end && c !== 0xffff; c++) {
        let g: number;
        if (ro === 0) g = (c + delta) & 0xffff;
        else {
          const p = rangeP + 2 * i + ro + 2 * (c - start);
          g = p + 1 < d.length ? r.u16At(p) : 0;
          if (g) g = (g + delta) & 0xffff;
        }
        if (g) map.set(c, g);
      }
    }
  } else if (fmt === 12) {
    r.u16(); r.u32(); r.u32();
    const n = r.u32();
    for (let i = 0; i < n; i++) {
      const s = r.u32(), e = r.u32(), g = r.u32();
      for (let c = s; c <= e; c++) map.set(c, g + c - s);
    }
  } else if (fmt === 6) {
    r.u16(); r.u16();
    const first = r.u16(), count = r.u16();
    for (let i = 0; i < count; i++) { const g = r.u16(); if (g) map.set(first + i, g); }
  } else if (fmt === 0) {
    r.u16(); r.u16();
    for (let c = 0; c < 256; c++) { const g = r.u8(); if (g) map.set(c, g); }
  }
}

function cmap4(map: Map<number, number>) {
  const cps = [...map.keys()].filter((c) => c <= 0xfffe).sort((a, b) => a - b);
  type Seg = { start: number; end: number; delta: number; ids: number[] | null };
  const segs: Seg[] = [];
  let i = 0;
  while (i < cps.length) {
    let j = i;
    while (j + 1 < cps.length && cps[j + 1] === cps[j] + 1) j++;
    // split the run into constant-delta pieces when long enough, else one array segment
    let k = i;
    while (k <= j) {
      let m = k;
      const d = map.get(cps[k])! - cps[k];
      while (m + 1 <= j && map.get(cps[m + 1])! - cps[m + 1] === d) m++;
      if (m - k >= 3 || (k === i && m === j)) {
        segs.push({ start: cps[k], end: cps[m], delta: d, ids: null });
        k = m + 1;
      } else {
        // gather a run of irregular codepoints into an array segment
        let e = k;
        while (e + 1 <= j) {
          let mm = e + 1;
          const dd = map.get(cps[e + 1])! - cps[e + 1];
          while (mm + 1 <= j && map.get(cps[mm + 1])! - cps[mm + 1] === dd) mm++;
          if (mm - (e + 1) >= 3) break;
          e = mm;
        }
        segs.push({ start: cps[k], end: cps[e], delta: 0, ids: cps.slice(k, e + 1).map((c) => map.get(c)!) });
        k = e + 1;
      }
    }
    i = j + 1;
  }
  segs.push({ start: 0xffff, end: 0xffff, delta: 1, ids: null });
  const n = segs.length;
  const w = new Writer(16 + n * 8);
  let es = 0;
  while (1 << (es + 1) <= n) es++;
  const sr = 2 * (1 << es);
  w.u16(4).u16(0).u16(0).u16(n * 2).u16(sr).u16(es).u16(2 * n - sr);
  for (const s of segs) w.u16(s.end);
  w.u16(0);
  for (const s of segs) w.u16(s.start);
  for (const s of segs) w.u16(s.delta & 0xffff);
  const glyphIds: number[] = [];
  segs.forEach((s, idx) => {
    if (!s.ids) { w.u16(0); return; }
    const ro = 2 * (n - idx) + 2 * glyphIds.length;
    w.u16(ro);
    glyphIds.push(...s.ids);
  });
  for (const g of glyphIds) w.u16(g);
  const out = w.done();
  new DataView(out.buffer).setUint16(2, out.length);
  return out;
}

function cmap12(map: Map<number, number>) {
  const cps = [...map.keys()].sort((a, b) => a - b);
  const groups: [number, number, number][] = [];
  for (const c of cps) {
    const g = map.get(c)!;
    const last = groups[groups.length - 1];
    if (last && c === last[1] + 1 && g === last[2] + (c - last[0])) last[1] = c;
    else groups.push([c, c, g]);
  }
  const w = new Writer(16 + groups.length * 12);
  w.u16(12).u16(0).u32(16 + groups.length * 12).u32(0).u32(groups.length);
  for (const [s, e, g] of groups) w.u32(s).u32(e).u32(g);
  return w.done();
}

export function writeCmap(map: Map<number, number>) {
  const subs: [number, number, Uint8Array][] = [];
  const t4 = cmap4(map);
  const needs12 = [...map.keys()].some((c) => c > 0xffff);
  const t12 = needs12 ? cmap12(map) : null;
  subs.push([0, 3, t4]);
  if (t12) subs.push([0, 4, t12]);
  subs.push([3, 1, t4]);
  if (t12) subs.push([3, 10, t12]);
  const w = new Writer(4096);
  w.u16(0).u16(subs.length);
  const offsets = new Map<Uint8Array, number>();
  let off = 4 + subs.length * 8;
  for (const [, , t] of subs) if (!offsets.has(t)) { offsets.set(t, off); off += t.length; }
  for (const [p, e, t] of subs) w.u16(p).u16(e).u32(offsets.get(t)!);
  for (const t of offsets.keys()) w.bytes(t);
  return w.done();
}

// -------------------------------------------------------------------- hmtx
export function parseHmtx(d: Uint8Array, numberOfHMetrics: number, numGlyphs: number) {
  const r = new Reader(d);
  const adv: number[] = [], lsb: number[] = [];
  let last = 0;
  for (let i = 0; i < numGlyphs; i++) {
    if (i < numberOfHMetrics) { last = r.u16(); adv.push(last); lsb.push(r.i16()); }
    else { adv.push(last); lsb.push(r.pos + 1 < d.length ? r.i16() : 0); }
  }
  return { adv, lsb };
}

export function writeHmtx(adv: number[], lsb: number[]) {
  const w = new Writer(adv.length * 4);
  for (let i = 0; i < adv.length; i++) w.u16(Math.max(0, Math.round(adv[i]))).i16(lsb[i]);
  return w.done();
}

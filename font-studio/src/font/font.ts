// FontProject: the editable font. Everything not edited is carried over byte for byte.
import { Reader } from './binary.ts';
import { FLAVOR_CFF, FLAVOR_TT, readSfnt, toSfntBytes, writeSfnt, type Tables } from './sfnt.ts';
import {
  parseCmap, parseHead, parseHhea, parseHmtx, parseMaxp, parseName, parseOS2, parsePost,
  writeCmap, writeHead, writeHhea, writeHmtx, writeMaxp, writeName, writeOS2, writePost,
  nowLongDateTime, type NameRecord,
} from './tables.ts';
import {
  cloneGlyph, compileGlyph, emptyGlyph, glyphBounds, parseGlyph, resolveContours,
  type Glyph,
} from './glyf.ts';
import { readGpos, readGsub, anchorXY, type AnchorRef, type PosData, type SubstGraph, type ValueRef } from './otl.ts';

export const VARIATION_TABLES = ['fvar', 'gvar', 'avar', 'cvar', 'HVAR', 'VVAR', 'MVAR', 'STAT'];
const ALWAYS_DROP = ['DSIG', 'hdmx', 'LTSH', 'VDMX'];
const HINTING_TABLES = ['fpgm', 'prep', 'cvt '];

export interface BuildOptions { dropHinting?: boolean; }

export interface Snapshot {
  glyphs?: Map<number, { glyph: Glyph; adv: number; name: string; unicodes: number[] }>;
  numGlyphs?: number;
  gpos?: Uint8Array;
  info?: string;
}

export class FontProject {
  tables: Tables = new Map();
  flavor = FLAVOR_TT;
  glyphs: Glyph[] = [];
  names: string[] = [];
  adv: number[] = [];
  cmap = new Map<number, number>();
  head: Record<string, any> = {};
  hhea: Record<string, any> = {};
  maxp: Record<string, any> = {};
  os2: Record<string, any> = {};
  post: Record<string, any> = {};
  nameRecords: NameRecord[] = [];
  gpos?: Uint8Array;
  gsub: SubstGraph = { substs: [], out: new Map(), in: new Map(), features: [] };
  pos: PosData = { anchors: [], values: [], byGlyph: new Map(), features: [] };
  gdefClass = new Map<number, number>();
  warnings: string[] = [];
  isVariable = false;
  wasCFF = false;
  originalNumGlyphs = 0;
  /** bumps on every edit; per glyph for caches */
  version = 0;
  glyphVersion: number[] = [];
  edited = new Set<number>();
  private compiled: (Uint8Array | null)[] = [];
  private unicodeIndex: Map<number, number[]> | null = null;

  // ------------------------------------------------------------- loading

  static async open(input: Uint8Array): Promise<FontProject> {
    const bytes = await toSfntBytes(input);
    const sfnt = readSfnt(bytes);
    const p = new FontProject();
    p.tables = sfnt.tables;
    p.flavor = sfnt.flavor;
    const t = p.tables;
    for (const req of ['head', 'hhea', 'maxp', 'hmtx']) if (!t.has(req)) throw new Error(`Missing required table '${req}'.`);
    p.head = parseHead(t.get('head')!);
    p.hhea = parseHhea(t.get('hhea')!);
    p.maxp = parseMaxp(t.get('maxp')!);
    const n = p.maxp.numGlyphs;
    p.os2 = t.has('OS/2') ? parseOS2(t.get('OS/2')!) : defaultOS2();
    p.nameRecords = t.has('name') ? parseName(t.get('name')!) : [];
    const { adv } = parseHmtx(t.get('hmtx')!, p.hhea.numberOfHMetrics, n);
    p.adv = adv;
    p.cmap = t.has('cmap') ? parseCmap(t.get('cmap')!) : new Map();
    const post = t.has('post') ? parsePost(t.get('post')!, n) : { info: { italicAngle: 0, underlinePosition: -100, underlineThickness: 50, isFixedPitch: 0 }, names: null };
    p.post = post.info;

    if (t.has('glyf') && t.has('loca')) {
      const loca = readLoca(t.get('loca')!, p.head.indexToLocFormat, n);
      const glyf = t.get('glyf')!;
      for (let i = 0; i < n; i++) {
        try { p.glyphs.push(parseGlyph(glyf.subarray(loca[i], loca[i + 1]))); }
        catch { p.glyphs.push(emptyGlyph()); p.warnings.push(`Glyph ${i} could not be read and was left empty.`); }
      }
    } else if (t.has('CFF ') || t.has('CFF2')) {
      const { cffToGlyphs } = await import('./cff.ts');
      const res = await cffToGlyphs(bytes, n);
      p.glyphs = res.glyphs;
      if (!post.names) post.names = res.names;
      p.wasCFF = true;
      p.warnings.push('PostScript (CFF) outlines were converted to TrueType quadratic curves; the studio saves TrueType fonts.');
    } else throw new Error('This font has no outlines the studio can read (no glyf or CFF table).');

    p.names = uniqueNames(post.names, n, p.cmap);
    if (t.has('fvar')) {
      p.isVariable = true;
      p.warnings.push('Variable font: the studio edits the default instance. Saving writes a static font (variation tables are removed).');
    }
    if (t.has('GDEF')) p.gdefClass = readGdefClasses(t.get('GDEF')!);
    p.gpos = t.get('GPOS')?.slice();
    p.reparseLayout();
    p.originalNumGlyphs = n;
    p.glyphVersion = new Array(n).fill(0);
    p.compiled = new Array(n).fill(null);
    return p;
  }

  reparseLayout() {
    this.gsub = readGsub(this.tables.get('GSUB'));
    this.pos = readGpos(this.gpos);
  }

  // ------------------------------------------------------------- queries

  get numGlyphs() { return this.glyphs.length; }
  get upm() { return this.head.unitsPerEm as number; }
  lookup = (gid: number) => this.glyphs[gid];

  unicodesOf(gid: number): number[] {
    if (!this.unicodeIndex) {
      this.unicodeIndex = new Map();
      for (const [cp, g] of this.cmap) {
        if (!this.unicodeIndex.has(g)) this.unicodeIndex.set(g, []);
        this.unicodeIndex.get(g)!.push(cp);
      }
      for (const l of this.unicodeIndex.values()) l.sort((a, b) => a - b);
    }
    return this.unicodeIndex.get(gid) ?? [];
  }

  glyphByName(name: string) { return this.names.indexOf(name); }
  bounds(gid: number) { return glyphBounds(this.glyphs[gid], this.lookup); }
  contours(gid: number) { return resolveContours(this.glyphs[gid], this.lookup); }
  lsb(gid: number) { return this.bounds(gid)?.xMin ?? 0; }
  rsb(gid: number) { const b = this.bounds(gid); return b ? this.adv[gid] - b.xMax : this.adv[gid]; }

  getName(id: number): string {
    const pick = (f: (r: NameRecord) => boolean) => this.nameRecords.find((r) => r.nameID === id && f(r));
    return (pick((r) => r.platformID === 3 && r.languageID === 0x409) ?? pick((r) => r.platformID === 3) ??
      pick((r) => r.platformID === 0) ?? pick((r) => r.platformID === 1))?.value ?? '';
  }

  anchorValue(a: AnchorRef) { return anchorXY(this.gpos!, a); }

  valueOf(v: ValueRef, field: keyof ValueRef['fields']) {
    const p = v.fields[field];
    return p === undefined || !this.gpos ? 0 : new Reader(this.gpos).i16At(p);
  }

  private revDeps: Map<number, number[]> | null = null;

  /** composites that use gid (directly or indirectly) */
  dependents(gid: number): number[] {
    if (!this.revDeps) {
      this.revDeps = new Map();
      this.glyphs.forEach((gl, i) => {
        for (const c of gl.components) {
          if (!this.revDeps!.has(c.gid)) this.revDeps!.set(c.gid, []);
          this.revDeps!.get(c.gid)!.push(i);
        }
      });
    }
    const out = new Set<number>();
    const stack = [gid];
    while (stack.length) for (const d of this.revDeps.get(stack.pop()!) ?? []) if (!out.has(d)) { out.add(d); stack.push(d); }
    return [...out];
  }

  // ------------------------------------------------------------- editing

  touch(gid: number) {
    this.version++;
    this.edited.add(gid);
    this.glyphVersion[gid] = (this.glyphVersion[gid] ?? 0) + 1;
    this.compiled[gid] = null;
    for (const d of this.dependents(gid)) { this.glyphVersion[d]++; this.compiled[d] = null; }
  }

  setGlyph(gid: number, g: Glyph, opts: { keepInstructions?: boolean } = {}) {
    // edited outlines invalidate their hinting
    if (!opts.keepInstructions) g.instructions = new Uint8Array(0);
    if (g.components.length || this.glyphs[gid]?.components.length) this.revDeps = null;
    this.glyphs[gid] = g;
    this.touch(gid);
  }

  setAdvance(gid: number, adv: number) { this.adv[gid] = Math.max(0, Math.round(adv)); this.touch(gid); }

  setUnicodes(gid: number, cps: number[]) {
    for (const [cp, g] of [...this.cmap]) if (g === gid) this.cmap.delete(cp);
    for (const cp of cps) this.cmap.set(cp, gid);
    this.unicodeIndex = null;
    this.version++;
  }

  renameGlyph(gid: number, name: string) {
    name = name.replace(/[^A-Za-z0-9._-]/g, '').slice(0, 63) || `glyph${gid}`;
    if (this.names.some((n, i) => n === name && i !== gid)) throw new Error(`A glyph named "${name}" already exists.`);
    this.names[gid] = name;
    this.version++;
  }

  addGlyph(name: string, opts: { from?: number; unicode?: number; advance?: number } = {}): number {
    const gid = this.glyphs.length;
    if (gid >= 65535) throw new Error('A font can hold at most 65535 glyphs.');
    let base = name.replace(/[^A-Za-z0-9._-]/g, '') || `glyph${gid}`;
    let unique = base, k = 1;
    while (this.names.includes(unique)) unique = `${base}.${k++}`;
    const src = opts.from !== undefined ? this.glyphs[opts.from] : undefined;
    this.glyphs.push(src ? cloneGlyph(src) : emptyGlyph());
    this.revDeps = null;
    this.names.push(unique);
    this.adv.push(opts.advance ?? (opts.from !== undefined ? this.adv[opts.from] : Math.round(this.upm / 2)));
    this.glyphVersion.push(0);
    this.compiled.push(null);
    if (opts.from !== undefined && this.gdefClass.has(opts.from)) this.gdefClass.set(gid, this.gdefClass.get(opts.from)!);
    if (opts.unicode !== undefined) this.setUnicodes(gid, [opts.unicode]);
    this.touch(gid);
    return gid;
  }

  setName(nameID: number, value: string) {
    let found = false;
    for (const r of this.nameRecords) {
      if (r.nameID !== nameID) continue;
      if ((r.platformID === 3 && r.languageID === 0x409) || (r.platformID === 1 && r.languageID === 0) || r.platformID === 0) {
        r.value = value; found = true;
      }
    }
    if (!found) this.nameRecords.push({ platformID: 3, encodingID: 1, languageID: 0x409, nameID, value });
    this.nameRecords = this.nameRecords.filter((r) => !(r.nameID === nameID && value === '' ));
    this.version++;
  }

  /** Move an anchor. With `independent`, a shared anchor table is first copied for this reference. */
  setAnchor(a: AnchorRef, x: number, y: number, independent = true): { shared: number; unshared: boolean } {
    if (!this.gpos) throw new Error('No GPOS table.');
    const sharers = this.pos.anchors.filter((b) => b.anchorPos === a.anchorPos);
    let unshared = false;
    if (independent && sharers.length > 1) {
      const newPos = (this.gpos.length + 1) & ~1;
      const rel = newPos - a.base;
      if (rel > 0 && rel < 65536) {
        const grown = new Uint8Array(newPos + 6);
        grown.set(this.gpos);
        const view = new DataView(grown.buffer);
        view.setUint16(newPos, 1);
        view.setInt16(newPos + 2, x);
        view.setInt16(newPos + 4, y);
        view.setUint16(a.fieldPos, rel);
        this.gpos = grown;
        a.anchorPos = newPos;
        unshared = true;
      }
    }
    if (!unshared) {
      const view = new DataView(this.gpos.buffer, this.gpos.byteOffset);
      view.setInt16(a.anchorPos + 2, Math.round(x));
      view.setInt16(a.anchorPos + 4, Math.round(y));
    }
    this.version++;
    return { shared: unshared ? 1 : sharers.length, unshared };
  }

  setValue(v: ValueRef, field: keyof ValueRef['fields'], value: number) {
    const p = v.fields[field];
    if (p === undefined || !this.gpos) throw new Error(`This record has no ${field} field.`);
    new DataView(this.gpos.buffer, this.gpos.byteOffset).setInt16(p, Math.round(value));
    this.version++;
  }

  // ------------------------------------------------------------- undo

  snapshot(scope: { glyphs?: number[]; gpos?: boolean; info?: boolean }): Snapshot {
    const s: Snapshot = { numGlyphs: this.glyphs.length };
    if (scope.glyphs) {
      s.glyphs = new Map();
      for (const g of scope.glyphs) if (g < this.glyphs.length)
        s.glyphs.set(g, { glyph: cloneGlyph(this.glyphs[g]), adv: this.adv[g], name: this.names[g], unicodes: this.unicodesOf(g) });
    }
    if (scope.gpos && this.gpos) s.gpos = this.gpos.slice();
    if (scope.info) s.info = JSON.stringify({ head: this.head, hhea: this.hhea, os2: this.os2, post: this.post, names: this.nameRecords });
    return s;
  }

  restore(s: Snapshot) {
    if (s.numGlyphs !== undefined && s.numGlyphs > this.glyphs.length) {
      while (this.glyphs.length < s.numGlyphs) {
        this.glyphs.push(emptyGlyph()); this.names.push(`glyph${this.glyphs.length - 1}`); this.adv.push(0);
        this.glyphVersion.push(0); this.compiled.push(null);
      }
    }
    if (s.numGlyphs !== undefined && s.numGlyphs < this.glyphs.length) {
      for (let g = s.numGlyphs; g < this.glyphs.length; g++) this.setUnicodes(g, []);
      this.glyphs.length = this.names.length = this.adv.length = s.numGlyphs;
      this.glyphVersion.length = this.compiled.length = s.numGlyphs;
    }
    this.revDeps = null;
    if (s.glyphs) for (const [g, v] of s.glyphs) {
      if (g >= this.glyphs.length) continue;
      this.glyphs[g] = cloneGlyph(v.glyph);
      this.adv[g] = v.adv;
      this.names[g] = v.name;
      this.setUnicodes(g, v.unicodes);
      this.touch(g);
    }
    if (s.gpos) { this.gpos = s.gpos.slice(); this.pos = readGpos(this.gpos); }
    if (s.info) {
      const o = JSON.parse(s.info);
      this.head = o.head; this.hhea = o.hhea; this.os2 = o.os2; this.post = o.post; this.nameRecords = o.names;
    }
    this.version++;
  }

  // ------------------------------------------------------------- saving

  build(opts: BuildOptions = {}): Uint8Array {
    const n = this.glyphs.length;
    const tables: Tables = new Map(this.tables);
    for (const t of ALWAYS_DROP) tables.delete(t);
    if (this.isVariable) for (const t of VARIATION_TABLES) tables.delete(t);
    if (this.wasCFF) { tables.delete('CFF '); tables.delete('CFF2'); tables.delete('VORG'); }
    if (opts.dropHinting) for (const t of HINTING_TABLES) tables.delete(t);
    if (n !== this.originalNumGlyphs) { tables.delete('vhea'); tables.delete('vmtx'); }

    // glyf + loca
    const parts: Uint8Array[] = [];
    const loca = new Uint32Array(n + 1);
    let off = 0;
    let maxPts = 0, maxCont = 0, maxCPts = 0, maxCCont = 0, maxComp = 0, maxDepth = 0, maxInstr = 0;
    let xMin = Infinity, yMin = Infinity, xMax = -Infinity, yMax = -Infinity;
    const lsb: number[] = [];
    let advMax = 0, minL = Infinity, minR = Infinity, maxExt = -Infinity;
    for (let g = 0; g < n; g++) {
      let gl = this.glyphs[g];
      if (opts.dropHinting && gl.instructions.length) gl = { ...gl, instructions: new Uint8Array(0) };
      let data = opts.dropHinting ? null : this.compiled[g];
      if (!data) {
        data = compileGlyph(gl, this.lookup);
        if (!opts.dropHinting) this.compiled[g] = data;
      }
      loca[g] = off;
      parts.push(data);
      off += data.length;
      const pad = (4 - (data.length % 4)) % 4;
      if (pad) { parts.push(new Uint8Array(pad)); off += pad; }
      maxInstr = Math.max(maxInstr, gl.instructions.length);
      const b = data.length ? glyphBounds(gl, this.lookup) : null;
      lsb.push(b ? b.xMin : 0);
      advMax = Math.max(advMax, this.adv[g]);
      if (b) {
        xMin = Math.min(xMin, b.xMin); yMin = Math.min(yMin, b.yMin);
        xMax = Math.max(xMax, b.xMax); yMax = Math.max(yMax, b.yMax);
        minL = Math.min(minL, b.xMin); minR = Math.min(minR, this.adv[g] - b.xMax);
        maxExt = Math.max(maxExt, b.xMax);
      }
      if (gl.components.length) {
        const res = resolveContours(gl, this.lookup);
        maxCPts = Math.max(maxCPts, res.reduce((s, c) => s + c.length, 0));
        maxCCont = Math.max(maxCCont, res.length);
        maxComp = Math.max(maxComp, gl.components.length);
        maxDepth = Math.max(maxDepth, this.depth(g));
      } else {
        maxPts = Math.max(maxPts, gl.contours.reduce((s, c) => s + c.length, 0));
        maxCont = Math.max(maxCont, gl.contours.length);
      }
    }
    loca[n] = off;
    const glyf = new Uint8Array(off);
    let p = 0;
    for (const part of parts) { glyf.set(part, p); p += part.length; }
    const locaBytes = new Uint8Array(4 * (n + 1));
    const lv = new DataView(locaBytes.buffer);
    for (let i = 0; i <= n; i++) lv.setUint32(4 * i, loca[i]);
    tables.set('glyf', glyf);
    tables.set('loca', locaBytes);
    tables.set('hmtx', writeHmtx(this.adv, lsb));

    const empty = xMin === Infinity;
    tables.set('head', writeHead({
      ...this.head, indexToLocFormat: 1, modified: nowLongDateTime(), glyphDataFormat: 0,
      xMin: empty ? 0 : xMin, yMin: empty ? 0 : yMin, xMax: empty ? 0 : xMax, yMax: empty ? 0 : yMax,
    }));
    tables.set('hhea', writeHhea({
      ...this.hhea, version: 0x00010000, advanceWidthMax: advMax,
      minLeftSideBearing: empty ? 0 : minL, minRightSideBearing: empty ? 0 : minR, xMaxExtent: empty ? 0 : maxExt,
      numberOfHMetrics: n, metricDataFormat: 0,
    }));
    const keepHint = !opts.dropHinting;
    tables.set('maxp', writeMaxp({
      ...(keepHint ? this.maxp : {}), numGlyphs: n, maxPoints: maxPts, maxContours: maxCont,
      maxCompositePoints: maxCPts, maxCompositeContours: maxCCont, maxComponentElements: maxComp,
      maxComponentDepth: maxDepth,
      maxSizeOfInstructions: Math.max(maxInstr, keepHint ? this.maxp.maxSizeOfInstructions ?? 0 : 0),
      maxZones: keepHint ? this.maxp.maxZones || 2 : 1,
    }));
    const bmp = [...this.cmap.keys()].filter((c) => c <= 0xffff);
    const advs = this.adv.filter((a) => a > 0);
    tables.set('OS/2', writeOS2({
      ...this.os2,
      xAvgCharWidth: advs.length ? Math.round(advs.reduce((s, a) => s + a, 0) / advs.length) : 0,
      usFirstCharIndex: bmp.length ? Math.min(...bmp) : 0xffff,
      usLastCharIndex: bmp.length ? Math.max(...bmp) : 0,
    }));
    tables.set('name', writeName(this.nameRecords));
    tables.set('post', writePost(this.post, this.names));
    tables.set('cmap', writeCmap(this.cmap));
    if (this.gpos) tables.set('GPOS', this.isVariable ? stripDeviceVariations(this.gpos) : this.gpos);
    if (this.isVariable && tables.has('GDEF')) tables.set('GDEF', stripGdefVarStore(tables.get('GDEF')!));
    return writeSfnt(tables, FLAVOR_TT);
  }

  private depth(g: number, d = 0): number {
    if (d > 16) return d;
    const gl = this.glyphs[g];
    if (!gl.components.length) return d;
    return Math.max(...gl.components.map((c) => this.depth(c.gid, d + 1)));
  }
}

/** Static save of a variable font: GDEF loses its ItemVariationStore. */
function stripGdefVarStore(gdef: Uint8Array) {
  const out = gdef.slice();
  const v = new DataView(out.buffer);
  if (v.getUint32(0) >= 0x00010003 && out.length >= 18) v.setUint32(14, 0);
  return out;
}

/** ...and GPOS value records / anchors stop pointing at VariationIndex device tables. */
function stripDeviceVariations(gpos: Uint8Array) {
  const out = gpos.slice();
  const v = new DataView(out.buffer);
  const isVarIdx = (base: number, off: number) => off && base + off + 6 <= out.length && v.getUint16(base + off + 4) === 0x8000;
  const pos = readGpos(gpos);
  for (const a of pos.anchors) {
    if (v.getUint16(a.anchorPos) !== 3) continue;
    for (const k of [6, 8]) if (isVarIdx(a.anchorPos, v.getUint16(a.anchorPos + k))) v.setUint16(a.anchorPos + k, 0);
  }
  for (const val of devicePositions(gpos)) if (isVarIdx(val.base, v.getUint16(val.pos))) v.setUint16(val.pos, 0);
  return out;
}

/** Positions of device-table offsets inside value records (single and pair positioning). */
function devicePositions(gpos: Uint8Array): { pos: number; base: number }[] {
  const r = new Reader(gpos);
  const out: { pos: number; base: number }[] = [];
  const lookupList = r.u16At(8);
  if (!lookupList) return out;
  const size = (f: number) => { let n = 0; for (let b = 0; b < 8; b++) if (f & (1 << b)) n += 2; return n; };
  const devs = (f: number, start: number, base: number) => {
    let p = start;
    for (let b = 0; b < 8; b++) if (f & (1 << b)) { if (b >= 4) out.push({ pos: p, base }); p += 2; }
  };
  for (let i = 0; i < r.u16At(lookupList); i++) {
    const lo = lookupList + r.u16At(lookupList + 2 + 2 * i);
    let type = r.u16At(lo);
    for (let k = 0; k < r.u16At(lo + 4); k++) {
      let so = lo + r.u16At(lo + 6 + 2 * k);
      if (type === 9) { type = r.u16At(so + 2); so += r.u32At(so + 4); }
      const fmt = r.u16At(so);
      if (type === 1) {
        const vf = r.u16At(so + 4);
        if (!(vf & 0xf0)) continue;
        if (fmt === 1) devs(vf, so + 6, so);
        else for (let j = 0; j < r.u16At(so + 6); j++) devs(vf, so + 8 + j * size(vf), so);
      } else if (type === 2) {
        const vf1 = r.u16At(so + 4), vf2 = r.u16At(so + 6);
        if (!((vf1 | vf2) & 0xf0)) continue;
        const s1 = size(vf1), s2 = size(vf2);
        if (fmt === 1) {
          for (let j = 0; j < r.u16At(so + 8); j++) {
            const ps = so + r.u16At(so + 10 + 2 * j);
            for (let q = 0; q < r.u16At(ps); q++) {
              const rec = ps + 2 + q * (2 + s1 + s2);
              devs(vf1, rec + 2, ps); devs(vf2, rec + 2 + s1, ps);
            }
          }
        } else if (fmt === 2) {
          const c1 = r.u16At(so + 12), c2 = r.u16At(so + 14);
          for (let q = 0; q < c1 * c2; q++) { const rec = so + 16 + q * (s1 + s2); devs(vf1, rec, so); devs(vf2, rec + s1, so); }
        }
      }
    }
  }
  return out;
}

function readLoca(d: Uint8Array, fmt: number, n: number) {
  const r = new Reader(d);
  const out: number[] = [];
  for (let i = 0; i <= n; i++) out.push(fmt ? r.u32At(4 * i) : r.u16At(2 * i) * 2);
  for (let i = 1; i <= n; i++) if (out[i] < out[i - 1]) out[i] = out[i - 1];
  return out;
}

function readGdefClasses(d: Uint8Array) {
  const r = new Reader(d);
  const off = r.u16At(4);
  const m = new Map<number, number>();
  if (!off) return m;
  const fmt = r.u16At(off);
  if (fmt === 1) {
    const s = r.u16At(off + 2), c = r.u16At(off + 4);
    for (let i = 0; i < c; i++) m.set(s + i, r.u16At(off + 6 + 2 * i));
  } else if (fmt === 2) {
    const c = r.u16At(off + 2);
    for (let i = 0; i < c; i++) {
      const p = off + 4 + 6 * i;
      for (let g = r.u16At(p); g <= r.u16At(p + 2); g++) m.set(g, r.u16At(p + 4));
    }
  }
  return m;
}

function uniqueNames(names: string[] | null, n: number, cmap: Map<number, number>): string[] {
  const byGid = new Map<number, number>();
  for (const [cp, g] of cmap) if (!byGid.has(g) || cp < byGid.get(g)!) byGid.set(g, cp);
  const out: string[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < n; i++) {
    let nm = names?.[i] || '';
    if (!nm) {
      const cp = byGid.get(i);
      nm = i === 0 ? '.notdef' : cp !== undefined ? (cp > 0xffff ? 'u' : 'uni') + cp.toString(16).toUpperCase().padStart(4, '0') : `glyph${i}`;
    }
    let u = nm, k = 1;
    while (seen.has(u)) u = `${nm}.${k++}`;
    seen.add(u);
    out.push(u);
  }
  return out;
}

export function defaultOS2(): Record<string, any> {
  return {
    version: 4, xAvgCharWidth: 0, usWeightClass: 400, usWidthClass: 5, fsType: 0,
    ySubscriptXSize: 650, ySubscriptYSize: 600, ySubscriptXOffset: 0, ySubscriptYOffset: 75,
    ySuperscriptXSize: 650, ySuperscriptYSize: 600, ySuperscriptXOffset: 0, ySuperscriptYOffset: 350,
    yStrikeoutSize: 50, yStrikeoutPosition: 300, sFamilyClass: 0, panose: new Array(10).fill(0),
    ulUnicodeRange1: 0, ulUnicodeRange2: 0, ulUnicodeRange3: 0, ulUnicodeRange4: 0, achVendID: 'NONE',
    fsSelection: 0x40 | 0x80, usFirstCharIndex: 0, usLastCharIndex: 0, sTypoAscender: 800,
    sTypoDescender: -200, sTypoLineGap: 0, usWinAscent: 1000, usWinDescent: 200,
    ulCodePageRange1: 1, ulCodePageRange2: 0, sxHeight: 500, sCapHeight: 700, usDefaultChar: 0,
    usBreakChar: 32, usMaxContext: 2,
  };
}

export { FLAVOR_CFF };

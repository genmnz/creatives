// OpenType layout: GSUB substitution graph (read-only) and GPOS values (edited in place).
import { Reader } from './binary.ts';

export function readCoverage(r: Reader, off: number): number[] {
  const fmt = r.u16At(off);
  const out: number[] = [];
  if (fmt === 1) {
    const n = r.u16At(off + 2);
    for (let i = 0; i < n; i++) out.push(r.u16At(off + 4 + 2 * i));
  } else if (fmt === 2) {
    const n = r.u16At(off + 2);
    for (let i = 0; i < n; i++) {
      const p = off + 4 + 6 * i;
      const s = r.u16At(p), e = r.u16At(p + 2);
      for (let g = s; g <= e; g++) out.push(g);
    }
  }
  return out;
}

export function readClassDef(r: Reader, off: number): Map<number, number> {
  const m = new Map<number, number>();
  if (!off) return m;
  const fmt = r.u16At(off);
  if (fmt === 1) {
    const start = r.u16At(off + 2), n = r.u16At(off + 4);
    for (let i = 0; i < n; i++) { const c = r.u16At(off + 6 + 2 * i); if (c) m.set(start + i, c); }
  } else if (fmt === 2) {
    const n = r.u16At(off + 2);
    for (let i = 0; i < n; i++) {
      const p = off + 4 + 6 * i;
      const s = r.u16At(p), e = r.u16At(p + 2), c = r.u16At(p + 4);
      for (let g = s; g <= e; g++) if (c) m.set(g, c);
    }
  }
  return m;
}

export interface Lookup { index: number; type: number; flag: number; subtables: number[]; }
export interface LayoutHeader { features: { tag: string; lookups: number[] }[]; lookups: Lookup[]; scripts: string[]; }

export function readLayout(d: Uint8Array, extType: number): LayoutHeader {
  const r = new Reader(d);
  const scriptList = r.u16At(4), featureList = r.u16At(6), lookupList = r.u16At(8);
  const scripts: string[] = [];
  if (scriptList) {
    const n = r.u16At(scriptList);
    for (let i = 0; i < n; i++) { r.pos = scriptList + 2 + 6 * i; scripts.push(r.tag()); }
  }
  const features: { tag: string; lookups: number[] }[] = [];
  if (featureList) {
    const n = r.u16At(featureList);
    for (let i = 0; i < n; i++) {
      r.pos = featureList + 2 + 6 * i;
      const tag = r.tag();
      const fo = featureList + r.u16();
      const cnt = r.u16At(fo + 2);
      const lookups: number[] = [];
      for (let k = 0; k < cnt; k++) lookups.push(r.u16At(fo + 4 + 2 * k));
      features.push({ tag, lookups });
    }
  }
  const lookups: Lookup[] = [];
  if (lookupList) {
    const n = r.u16At(lookupList);
    for (let i = 0; i < n; i++) {
      const lo = lookupList + r.u16At(lookupList + 2 + 2 * i);
      let type = r.u16At(lo);
      const flag = r.u16At(lo + 2), cnt = r.u16At(lo + 4);
      const subtables: number[] = [];
      for (let k = 0; k < cnt; k++) {
        let so = lo + r.u16At(lo + 6 + 2 * k);
        if (type === extType) {
          const realType = r.u16At(so + 2);
          so = so + r.u32At(so + 4);
          subtables.push(so);
          type = extType * 100 + realType; // marker, fixed below
        } else subtables.push(so);
      }
      if (type > 100) type = type % 100;
      lookups.push({ index: i, type, flag, subtables });
    }
  }
  return { features, lookups, scripts };
}

/** Feature tags that reach each lookup, directly or through contextual lookups. */
function lookupTags(r: Reader, h: LayoutHeader, ctxTypes: [number, number], chainRefs: (r: Reader, so: number, type: number) => number[]) {
  const tags = h.lookups.map(() => new Set<string>());
  h.features.forEach((f) => f.lookups.forEach((l) => tags[l]?.add(f.tag)));
  let changed = true, guard = 0;
  while (changed && guard++ < 10) {
    changed = false;
    for (const lk of h.lookups) {
      if (lk.type !== ctxTypes[0] && lk.type !== ctxTypes[1]) continue;
      for (const so of lk.subtables) for (const ref of chainRefs(r, so, lk.type)) {
        if (!tags[ref]) continue;
        for (const t of tags[lk.index]) if (!tags[ref].has(t)) { tags[ref].add(t); changed = true; }
      }
    }
  }
  return tags;
}

function contextRefs(r: Reader, so: number, type: number): number[] {
  const fmt = r.u16At(so);
  const refs: number[] = [];
  const readRecords = (p: number, n: number) => { for (let i = 0; i < n; i++) refs.push(r.u16At(p + 4 * i + 2)); };
  const ruleSets = (setsP: number, n: number, chained: boolean) => {
    for (let i = 0; i < n; i++) {
      const rs = r.u16At(setsP + 2 * i);
      if (!rs) continue;
      const base = so + rs;
      const rc = r.u16At(base);
      for (let k = 0; k < rc; k++) {
        let p = base + r.u16At(base + 2 + 2 * k);
        if (chained) {
          p += 2 + 2 * r.u16At(p);          // backtrack
          const inN = r.u16At(p); p += 2 + 2 * (inN - 1);
          p += 2 + 2 * r.u16At(p);          // lookahead
          readRecords(p + 2, r.u16At(p));
        } else {
          const inN = r.u16At(p), sc = r.u16At(p + 2);
          readRecords(p + 4 + 2 * (inN - 1), sc);
        }
      }
    }
  };
  const chained = type === 6 || type === 8;
  if (fmt === 1) ruleSets(so + 6, r.u16At(so + 4), chained);
  else if (fmt === 2) ruleSets(chained ? so + 12 : so + 8, r.u16At(chained ? so + 10 : so + 6), chained);
  else if (fmt === 3) {
    if (chained) {
      let p = so + 2;
      p += 2 + 2 * r.u16At(p);
      p += 2 + 2 * r.u16At(p);
      p += 2 + 2 * r.u16At(p);
      readRecords(p + 2, r.u16At(p));
    } else {
      const gc = r.u16At(so + 2), sc = r.u16At(so + 4);
      readRecords(so + 6 + 2 * gc, sc);
    }
  }
  return refs;
}

// ------------------------------------------------------------------- GSUB

export interface Subst { lookup: number; type: number; from: number[]; to: number[]; tags: string[]; }
export interface SubstGraph { substs: Subst[]; out: Map<number, Subst[]>; in: Map<number, Subst[]>; features: string[]; }

export function readGsub(d: Uint8Array | undefined): SubstGraph {
  const graph: SubstGraph = { substs: [], out: new Map(), in: new Map(), features: [] };
  if (!d) return graph;
  const r = new Reader(d);
  const h = readLayout(d, 7);
  graph.features = [...new Set(h.features.map((f) => f.tag))].sort();
  const tags = lookupTags(r, h, [5, 6], contextRefs);
  const add = (s: Subst) => {
    graph.substs.push(s);
    for (const g of s.from) { if (!graph.out.has(g)) graph.out.set(g, []); graph.out.get(g)!.push(s); }
    for (const g of s.to) { if (!graph.in.has(g)) graph.in.set(g, []); graph.in.get(g)!.push(s); }
  };
  for (const lk of h.lookups) {
    const t = [...tags[lk.index]].sort();
    for (const so of lk.subtables) {
      try {
        const fmt = r.u16At(so);
        if (![1, 2, 3, 4, 8].includes(lk.type)) continue;
        const cov = readCoverage(r, so + r.u16At(so + 2));
        if (lk.type === 1) {
          if (fmt === 1) {
            const delta = r.i16At(so + 4);
            cov.forEach((g) => add({ lookup: lk.index, type: 1, from: [g], to: [(g + delta) & 0xffff], tags: t }));
          } else cov.forEach((g, i) => add({ lookup: lk.index, type: 1, from: [g], to: [r.u16At(so + 6 + 2 * i)], tags: t }));
        } else if (lk.type === 2 || lk.type === 3) {
          cov.forEach((g, i) => {
            const so2 = so + r.u16At(so + 6 + 2 * i);
            const n = r.u16At(so2);
            const to: number[] = [];
            for (let k = 0; k < n; k++) to.push(r.u16At(so2 + 2 + 2 * k));
            add({ lookup: lk.index, type: lk.type, from: [g], to, tags: t });
          });
        } else if (lk.type === 4) {
          cov.forEach((g, i) => {
            const ls = so + r.u16At(so + 6 + 2 * i);
            const n = r.u16At(ls);
            for (let k = 0; k < n; k++) {
              const lo = ls + r.u16At(ls + 2 + 2 * k);
              const lig = r.u16At(lo), cc = r.u16At(lo + 2);
              const comps = [g];
              for (let c = 1; c < cc; c++) comps.push(r.u16At(lo + 4 + 2 * (c - 1)));
              add({ lookup: lk.index, type: 4, from: comps, to: [lig], tags: t });
            }
          });
        } else if (lk.type === 8) {
          let p = so + 4;
          p += 2 + 2 * r.u16At(p);
          p += 2 + 2 * r.u16At(p);
          const n = r.u16At(p);
          cov.forEach((g, i) => { if (i < n) add({ lookup: lk.index, type: 8, from: [g], to: [r.u16At(p + 2 + 2 * i)], tags: t }); });
        }
      } catch { /* malformed subtable: skip */ }
    }
  }
  return graph;
}

/** All glyphs reachable from `gid` through substitutions (its "forms"). */
export function formsOf(graph: SubstGraph, gid: number, limit = 200): Map<number, Set<string>> {
  const seen = new Map<number, Set<string>>([[gid, new Set(['base'])]]);
  const queue = [gid];
  while (queue.length && seen.size < limit) {
    const g = queue.shift()!;
    for (const s of graph.out.get(g) ?? []) for (const t of s.to) {
      if (!seen.has(t)) { seen.set(t, new Set()); queue.push(t); }
      for (const tag of s.tags.length ? s.tags : [`lookup ${s.lookup}`]) seen.get(t)!.add(tag);
    }
  }
  return seen;
}

// ------------------------------------------------------------------- GPOS

export interface AnchorRef {
  kind: 'mark' | 'base' | 'ligature' | 'mark2' | 'entry' | 'exit';
  lookup: number; gid: number; cls: number; component?: number;
  fieldPos: number;   // where the Offset16 to the anchor is stored
  base: number;       // what that offset is relative to
  anchorPos: number;  // absolute position of the anchor table
}

export interface ValueRef {
  kind: 'single' | 'pair' | 'pairClass';
  lookup: number; gid: number; gid2?: number; class1?: number; class2?: number;
  second: boolean;    // Value2 of a pair
  class2Glyphs?: number[]; // pairClass: the second glyphs of class2 (empty = "all other glyphs")
  fields: Partial<Record<'XPlacement' | 'YPlacement' | 'XAdvance' | 'YAdvance', number>>; // absolute byte positions
  sharedBy: number;   // how many glyph (pairs) this exact record applies to
}

export interface PosData { anchors: AnchorRef[]; values: ValueRef[]; byGlyph: Map<number, { anchors: AnchorRef[]; values: ValueRef[] }>; features: string[]; }

const VF_FIELDS: ['XPlacement' | 'YPlacement' | 'XAdvance' | 'YAdvance', number][] =
  [['XPlacement', 1], ['YPlacement', 2], ['XAdvance', 4], ['YAdvance', 8]];

function valueSize(fmt: number) { let n = 0; for (let b = 0; b < 8; b++) if (fmt & (1 << b)) n += 2; return n; }
function valueFields(fmt: number, pos: number) {
  const f: ValueRef['fields'] = {};
  let p = pos;
  for (const [name, bit] of VF_FIELDS) if (fmt & bit) { f[name] = p; p += 2; }
  return f;
}

export function readGpos(d: Uint8Array | undefined): PosData {
  const data: PosData = { anchors: [], values: [], byGlyph: new Map(), features: [] };
  if (!d) return data;
  const r = new Reader(d);
  const h = readLayout(d, 9);
  data.features = [...new Set(h.features.map((f) => f.tag))].sort();
  const anchor = (a: Omit<AnchorRef, 'anchorPos'>) => {
    const off = r.u16At(a.fieldPos);
    if (!off) return;
    data.anchors.push({ ...a, anchorPos: a.base + off });
  };
  for (const lk of h.lookups) {
    for (const so of lk.subtables) {
      try {
        const fmt = r.u16At(so);
        if (lk.type === 1) {
          const cov = readCoverage(r, so + r.u16At(so + 2));
          const vf = r.u16At(so + 4);
          if (fmt === 1) {
            cov.forEach((g) => data.values.push({ kind: 'single', lookup: lk.index, gid: g, second: false, fields: valueFields(vf, so + 6), sharedBy: cov.length }));
          } else {
            const sz = valueSize(vf);
            cov.forEach((g, i) => data.values.push({ kind: 'single', lookup: lk.index, gid: g, second: false, fields: valueFields(vf, so + 8 + i * sz), sharedBy: 1 }));
          }
        } else if (lk.type === 2) {
          const cov = readCoverage(r, so + r.u16At(so + 2));
          const vf1 = r.u16At(so + 4), vf2 = r.u16At(so + 6);
          const s1 = valueSize(vf1), s2 = valueSize(vf2);
          if (fmt === 1) {
            cov.forEach((g, i) => {
              const ps = so + r.u16At(so + 10 + 2 * i);
              const n = r.u16At(ps);
              for (let k = 0; k < n; k++) {
                const rec = ps + 2 + k * (2 + s1 + s2);
                const g2 = r.u16At(rec);
                if (vf1) data.values.push({ kind: 'pair', lookup: lk.index, gid: g, gid2: g2, second: false, fields: valueFields(vf1, rec + 2), sharedBy: 1 });
                if (vf2) data.values.push({ kind: 'pair', lookup: lk.index, gid: g, gid2: g2, second: true, fields: valueFields(vf2, rec + 2 + s1), sharedBy: 1 });
              }
            });
          } else if (fmt === 2) {
            const cd1 = readClassDef(r, so + r.u16At(so + 8)), cd2 = readClassDef(r, so + r.u16At(so + 10));
            const c1n = r.u16At(so + 12), c2n = r.u16At(so + 14);
            const members2 = new Map<number, number[]>();
            for (const [g2, c] of cd2) { if (!members2.has(c)) members2.set(c, []); members2.get(c)!.push(g2); }
            const members1 = new Map<number, number>();
            for (const g of cov) { const c = cd1.get(g) ?? 0; members1.set(c, (members1.get(c) ?? 0) + 1); }
            const rec = (c1: number, c2: number) => so + 16 + (c1 * c2n + c2) * (s1 + s2);
            for (const g of cov) {
              const c1 = cd1.get(g) ?? 0;
              if (c1 >= c1n) continue;
              for (let c2 = 0; c2 < c2n; c2++) {
                const p = rec(c1, c2);
                // only list pairs that actually do something
                let nonzero = false;
                for (let k = 0; k < s1 + s2; k += 2) if (r.i16At(p + k)) nonzero = true;
                if (!nonzero) continue;
                const g2s = members2.get(c2) ?? [];
                const shared = (members1.get(c1) ?? 1) * Math.max(1, g2s.length);
                const common = { kind: 'pairClass' as const, lookup: lk.index, gid: g, class1: c1, class2: c2, class2Glyphs: g2s, sharedBy: shared };
                if (vf1) data.values.push({ ...common, second: false, fields: valueFields(vf1, p) });
                if (vf2) data.values.push({ ...common, second: true, fields: valueFields(vf2, p + s1) });
              }
            }
          }
        } else if (lk.type === 3) {
          const cov = readCoverage(r, so + r.u16At(so + 2));
          cov.forEach((g, i) => {
            const rec = so + 6 + 4 * i;
            anchor({ kind: 'entry', lookup: lk.index, gid: g, cls: 0, fieldPos: rec, base: so });
            anchor({ kind: 'exit', lookup: lk.index, gid: g, cls: 0, fieldPos: rec + 2, base: so });
          });
        } else if (lk.type === 4 || lk.type === 6) {
          const markCov = readCoverage(r, so + r.u16At(so + 2));
          const baseCov = readCoverage(r, so + r.u16At(so + 4));
          const classCount = r.u16At(so + 6);
          const markArr = so + r.u16At(so + 8), baseArr = so + r.u16At(so + 10);
          markCov.forEach((g, i) => {
            const rec = markArr + 2 + 4 * i;
            anchor({ kind: 'mark', lookup: lk.index, gid: g, cls: r.u16At(rec), fieldPos: rec + 2, base: markArr });
          });
          baseCov.forEach((g, i) => {
            for (let c = 0; c < classCount; c++) {
              const fp = baseArr + 2 + 2 * (i * classCount + c);
              anchor({ kind: lk.type === 4 ? 'base' : 'mark2', lookup: lk.index, gid: g, cls: c, fieldPos: fp, base: baseArr });
            }
          });
        } else if (lk.type === 5) {
          const markCov = readCoverage(r, so + r.u16At(so + 2));
          const ligCov = readCoverage(r, so + r.u16At(so + 4));
          const classCount = r.u16At(so + 6);
          const markArr = so + r.u16At(so + 8), ligArr = so + r.u16At(so + 10);
          markCov.forEach((g, i) => {
            const rec = markArr + 2 + 4 * i;
            anchor({ kind: 'mark', lookup: lk.index, gid: g, cls: r.u16At(rec), fieldPos: rec + 2, base: markArr });
          });
          ligCov.forEach((g, i) => {
            const la = ligArr + r.u16At(ligArr + 2 + 2 * i);
            const comps = r.u16At(la);
            for (let k = 0; k < comps; k++) for (let c = 0; c < classCount; c++) {
              const fp = la + 2 + 2 * (k * classCount + c);
              anchor({ kind: 'ligature', lookup: lk.index, gid: g, cls: c, component: k, fieldPos: fp, base: la });
            }
          });
        }
      } catch { /* skip malformed subtable */ }
    }
  }
  const slot = (g: number) => {
    if (!data.byGlyph.has(g)) data.byGlyph.set(g, { anchors: [], values: [] });
    return data.byGlyph.get(g)!;
  };
  for (const a of data.anchors) slot(a.gid).anchors.push(a);
  for (const v of data.values) {
    slot(v.gid).values.push(v);
    if (v.gid2 !== undefined && v.gid2 !== v.gid) slot(v.gid2).values.push(v);
  }
  return data;
}

export function anchorXY(gpos: Uint8Array, a: AnchorRef) {
  const r = new Reader(gpos);
  return { x: r.i16At(a.anchorPos + 2), y: r.i16At(a.anchorPos + 4) };
}

/** How many references point at the same anchor table (editing it moves all of them). */
export function anchorShares(pos: PosData, a: AnchorRef) {
  return pos.anchors.filter((b) => b.anchorPos === a.anchorPos);
}

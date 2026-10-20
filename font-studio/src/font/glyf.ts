// TrueType glyph model: simple outlines (quadratic, on/off-curve points) and composites.
import { Reader, Writer } from './binary.ts';

export interface Point { x: number; y: number; on: boolean; }
export type Contour = Point[];
export interface Component {
  gid: number;
  dx: number; dy: number;          // offset (ARGS_ARE_XY_VALUES) ...
  match?: [number, number];        // ... or point matching (parent point, child point)
  m: [number, number, number, number]; // 2x2 transform xx, xy, yx, yy
  flags: number;                   // preserved: ROUND_XY_TO_GRID, USE_MY_METRICS, OVERLAP_COMPOUND, SCALED/UNSCALED
}
export interface Glyph {
  contours: Contour[];
  components: Component[];
  instructions: Uint8Array;
  overlap: boolean;                // OVERLAP_SIMPLE / OVERLAP_COMPOUND flag
}

export const emptyGlyph = (): Glyph => ({ contours: [], components: [], instructions: new Uint8Array(0), overlap: false });

export const ON_CURVE = 0x01, X_SHORT = 0x02, Y_SHORT = 0x04, REPEAT = 0x08, X_SAME = 0x10, Y_SAME = 0x20, OVERLAP_SIMPLE = 0x40;
const ARG_WORDS = 0x1, ARGS_XY = 0x2, HAVE_SCALE = 0x8, MORE = 0x20, HAVE_XY_SCALE = 0x40, HAVE_2X2 = 0x80,
  HAVE_INSTR = 0x100, OVERLAP_COMPOUND = 0x400;
const KEEP_FLAGS = 0x4 | 0x200 | 0x400 | 0x800 | 0x1000;

export function parseGlyph(data: Uint8Array): Glyph {
  const g = emptyGlyph();
  if (data.length === 0) return g;
  const r = new Reader(data);
  const n = r.i16();
  r.pos = 10;
  if (n >= 0) {
    const ends: number[] = [];
    for (let i = 0; i < n; i++) ends.push(r.u16());
    const il = r.u16();
    g.instructions = data.slice(r.pos, r.pos + il);
    r.pos += il;
    const count = n ? ends[n - 1] + 1 : 0;
    const flags: number[] = [];
    while (flags.length < count) {
      const f = r.u8();
      flags.push(f);
      if (f & REPEAT) { let k = r.u8(); while (k--) flags.push(f); }
    }
    const xs: number[] = [], ys: number[] = [];
    let v = 0;
    for (const f of flags) {
      if (f & X_SHORT) v += (f & X_SAME) ? r.u8() : -r.u8();
      else if (!(f & X_SAME)) v += r.i16();
      xs.push(v);
    }
    v = 0;
    for (const f of flags) {
      if (f & Y_SHORT) v += (f & Y_SAME) ? r.u8() : -r.u8();
      else if (!(f & Y_SAME)) v += r.i16();
      ys.push(v);
    }
    g.overlap = !!(flags[0] & OVERLAP_SIMPLE);
    let s = 0;
    for (const e of ends) {
      const c: Contour = [];
      for (let i = s; i <= e; i++) c.push({ x: xs[i], y: ys[i], on: !!(flags[i] & ON_CURVE) });
      g.contours.push(c);
      s = e + 1;
    }
  } else {
    let flags: number;
    do {
      flags = r.u16();
      const gid = r.u16();
      let a1: number, a2: number;
      if (flags & ARG_WORDS) {
        if (flags & ARGS_XY) { a1 = r.i16(); a2 = r.i16(); } else { a1 = r.u16(); a2 = r.u16(); }
      } else if (flags & ARGS_XY) { a1 = r.i8(); a2 = r.i8(); } else { a1 = r.u8(); a2 = r.u8(); }
      let m: [number, number, number, number] = [1, 0, 0, 1];
      if (flags & HAVE_SCALE) { const s = r.f2dot14(); m = [s, 0, 0, s]; }
      else if (flags & HAVE_XY_SCALE) { const sx = r.f2dot14(), sy = r.f2dot14(); m = [sx, 0, 0, sy]; }
      else if (flags & HAVE_2X2) m = [r.f2dot14(), r.f2dot14(), r.f2dot14(), r.f2dot14()];
      const comp: Component = { gid, dx: 0, dy: 0, m, flags: flags & KEEP_FLAGS };
      if (flags & ARGS_XY) { comp.dx = a1; comp.dy = a2; } else comp.match = [a1, a2];
      if (flags & OVERLAP_COMPOUND) g.overlap = true;
      g.components.push(comp);
    } while (flags & MORE);
    if (flags & HAVE_INSTR) {
      const il = r.u16();
      g.instructions = data.slice(r.pos, r.pos + il);
    }
  }
  return g;
}

export type GlyphLookup = (gid: number) => Glyph | undefined;

/** Resolve a glyph (composites included) into absolute contours. */
export function resolveContours(g: Glyph, lookup: GlyphLookup, depth = 0): Contour[] {
  if (!g.components.length || depth > 16) return g.contours;
  const out: Contour[] = [];
  for (const c of g.components) {
    const child = lookup(c.gid);
    if (!child) continue;
    let dx = c.dx, dy = c.dy;
    const cc = resolveContours(child, lookup, depth + 1);
    if (c.match) {
      const parentPts = out.flat();
      const childPts = cc.flat();
      const p = parentPts[c.match[0]], q = childPts[c.match[1]];
      if (p && q) {
        const [a, b, cc2, d] = c.m;
        dx = p.x - (a * q.x + cc2 * q.y);
        dy = p.y - (b * q.x + d * q.y);
      }
    }
    const [a, b, c2, d] = c.m;
    for (const con of cc) out.push(con.map((p) => ({ x: a * p.x + c2 * p.y + dx, y: b * p.x + d * p.y + dy, on: p.on })));
  }
  return out;
}

export interface BBox { xMin: number; yMin: number; xMax: number; yMax: number; }

export function contoursBounds(contours: Contour[]): BBox | null {
  let xMin = Infinity, yMin = Infinity, xMax = -Infinity, yMax = -Infinity;
  for (const c of contours) for (const p of c) {
    if (p.x < xMin) xMin = p.x; if (p.x > xMax) xMax = p.x;
    if (p.y < yMin) yMin = p.y; if (p.y > yMax) yMax = p.y;
  }
  if (xMin === Infinity) return null;
  // control-point bounds are what the TrueType rasteriser and the spec use
  return { xMin: Math.floor(xMin), yMin: Math.floor(yMin), xMax: Math.ceil(xMax), yMax: Math.ceil(yMax) };
}

export function compileGlyph(g: Glyph, lookup: GlyphLookup): Uint8Array {
  const w = new Writer(256);
  if (g.components.length) {
    const b = contoursBounds(resolveContours(g, lookup));
    w.i16(-1).i16(b?.xMin ?? 0).i16(b?.yMin ?? 0).i16(b?.xMax ?? 0).i16(b?.yMax ?? 0);
    g.components.forEach((c, i) => {
      const last = i === g.components.length - 1;
      let flags = c.flags & KEEP_FLAGS;
      if (g.overlap && i === 0) flags |= OVERLAP_COMPOUND;
      if (!last) flags |= MORE;
      if (last && g.instructions.length) flags |= HAVE_INSTR;
      let a1: number, a2: number;
      if (c.match) { a1 = c.match[0]; a2 = c.match[1]; }
      else { flags |= ARGS_XY; a1 = Math.round(c.dx); a2 = Math.round(c.dy); }
      const words = c.match ? (a1 > 255 || a2 > 255) : (a1 < -128 || a1 > 127 || a2 < -128 || a2 > 127);
      if (words) flags |= ARG_WORDS;
      const [xx, xy, yx, yy] = c.m;
      if (xy !== 0 || yx !== 0) flags |= HAVE_2X2;
      else if (xx !== yy) flags |= HAVE_XY_SCALE;
      else if (xx !== 1) flags |= HAVE_SCALE;
      w.u16(flags).u16(c.gid);
      if (words) { if (c.match) w.u16(a1).u16(a2); else w.i16(a1).i16(a2); }
      else if (c.match) w.u8(a1).u8(a2); else w.i8(a1).i8(a2);
      if (flags & HAVE_2X2) w.f2dot14(xx).f2dot14(xy).f2dot14(yx).f2dot14(yy);
      else if (flags & HAVE_XY_SCALE) w.f2dot14(xx).f2dot14(yy);
      else if (flags & HAVE_SCALE) w.f2dot14(xx);
    });
    if (g.instructions.length) w.u16(g.instructions.length).bytes(g.instructions);
    return w.pad(2).done();
  }
  const contours = g.contours.filter((c) => c.length > 0);
  if (!contours.length) return new Uint8Array(0);
  const pts = contours.flat().map((p) => ({ x: Math.round(p.x), y: Math.round(p.y), on: p.on }));
  const b = contoursBounds([pts])!;
  w.i16(contours.length).i16(b.xMin).i16(b.yMin).i16(b.xMax).i16(b.yMax);
  let end = -1;
  for (const c of contours) { end += c.length; w.u16(end); }
  w.u16(g.instructions.length).bytes(g.instructions);
  const flags: number[] = [];
  const xb = new Writer(pts.length * 2), yb = new Writer(pts.length * 2);
  let px = 0, py = 0;
  pts.forEach((p, i) => {
    let f = p.on ? ON_CURVE : 0;
    if (i === 0 && g.overlap) f |= OVERLAP_SIMPLE;
    const dx = p.x - px, dy = p.y - py;
    if (dx === 0) f |= X_SAME;
    else if (dx >= -255 && dx <= 255) { f |= X_SHORT; if (dx > 0) f |= X_SAME; xb.u8(Math.abs(dx)); }
    else xb.i16(dx);
    if (dy === 0) f |= Y_SAME;
    else if (dy >= -255 && dy <= 255) { f |= Y_SHORT; if (dy > 0) f |= Y_SAME; yb.u8(Math.abs(dy)); }
    else yb.i16(dy);
    flags.push(f);
    px = p.x; py = p.y;
  });
  for (let i = 0; i < flags.length;) {
    let j = i;
    while (j + 1 < flags.length && flags[j + 1] === flags[i] && j - i < 255) j++;
    if (j > i) { w.u8(flags[i] | REPEAT).u8(j - i); i = j + 1; }
    else { w.u8(flags[i]); i++; }
  }
  w.bytes(xb.done()).bytes(yb.done());
  return w.pad(2).done();
}

/** Glyph bounding box (resolving composites) without compiling. */
export function glyphBounds(g: Glyph, lookup: GlyphLookup) {
  return contoursBounds(resolveContours(g, lookup));
}

export function pointCount(g: Glyph, lookup: GlyphLookup) {
  return resolveContours(g, lookup).reduce((s, c) => s + c.length, 0);
}

/** SVG path data (font units, y up) for a list of TrueType contours. */
export function contoursToPath(contours: Contour[], fmt = (v: number) => String(Math.round(v * 10) / 10)): string {
  let d = '';
  for (const c of contours) {
    const n = c.length;
    if (n < 2) continue;
    let start = c.findIndex((p) => p.on);
    let pts: Point[];
    if (start < 0) {
      // all off-curve: start at the implied midpoint
      const a = c[0], b = c[n - 1];
      pts = [{ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, on: true }, ...c];
    } else pts = [...c.slice(start), ...c.slice(0, start)];
    d += `M${fmt(pts[0].x)} ${fmt(pts[0].y)}`;
    let ctrl: Point | null = null;
    for (let i = 1; i <= pts.length; i++) {
      const p = pts[i % pts.length];
      if (p.on) {
        if (ctrl) { d += `Q${fmt(ctrl.x)} ${fmt(ctrl.y)} ${fmt(p.x)} ${fmt(p.y)}`; ctrl = null; }
        else if (i < pts.length) d += `L${fmt(p.x)} ${fmt(p.y)}`;
      } else {
        if (ctrl) {
          const mx = (ctrl.x + p.x) / 2, my = (ctrl.y + p.y) / 2;
          d += `Q${fmt(ctrl.x)} ${fmt(ctrl.y)} ${fmt(mx)} ${fmt(my)}`;
        }
        ctrl = p;
      }
    }
    d += 'Z';
  }
  return d;
}

export function cloneGlyph(g: Glyph): Glyph {
  return {
    contours: g.contours.map((c) => c.map((p) => ({ ...p }))),
    components: g.components.map((c) => ({ ...c, m: [...c.m] as Component['m'], match: c.match ? [...c.match] as [number, number] : undefined })),
    instructions: g.instructions.slice(),
    overlap: g.overlap,
  };
}

// Outline operations used by the editor and by batch tools.
import { cloneGlyph, resolveContours, type Contour, type Glyph, type GlyphLookup, type Point } from './glyf.ts';

export type Matrix = [number, number, number, number, number, number]; // a b c d e f: x' = a x + c y + e, y' = b x + d y + f

export const identity = (): Matrix => [1, 0, 0, 1, 0, 0];
export const translate = (dx: number, dy: number): Matrix => [1, 0, 0, 1, dx, dy];
export const scaleAbout = (sx: number, sy: number, ox = 0, oy = 0): Matrix => [sx, 0, 0, sy, ox - sx * ox, oy - sy * oy];
export function rotateAbout(deg: number, ox = 0, oy = 0): Matrix {
  const r = (deg * Math.PI) / 180, c = Math.cos(r), s = Math.sin(r);
  return [c, s, -s, c, ox - c * ox + s * oy, oy - s * ox - c * oy];
}
export function skewAbout(degX: number, ox = 0, oy = 0): Matrix {
  const t = Math.tan((degX * Math.PI) / 180);
  return [1, 0, t, 1, -t * oy, 0];
}
export const apply = (m: Matrix, p: { x: number; y: number }) => ({ x: m[0] * p.x + m[2] * p.y + m[4], y: m[1] * p.x + m[3] * p.y + m[5] });

/** Transform a glyph; with `selection` only those (contour, point) keys move. */
export function transformGlyph(g: Glyph, m: Matrix, selection?: Set<string>): Glyph {
  const out = cloneGlyph(g);
  out.contours = out.contours.map((c, ci) => c.map((p, pi) => {
    if (selection && !selection.has(`${ci}:${pi}`)) return p;
    return { ...apply(m, p), on: p.on };
  }));
  if (!selection) out.components = out.components.map((c) => {
    if (c.match) return c;
    const o = apply(m, { x: c.dx, y: c.dy });
    const [a, b, cc, d] = c.m;
    // new linear part = M_lin * C_lin
    const nm: [number, number, number, number] = [m[0] * a + m[2] * b, m[1] * a + m[3] * b, m[0] * cc + m[2] * d, m[1] * cc + m[3] * d];
    return { ...c, dx: o.x, dy: o.y, m: nm.map((v) => Math.max(-2, Math.min(1.99993896484375, v))) as typeof nm };
  });
  return out;
}

export function roundGlyph(g: Glyph): Glyph {
  const out = cloneGlyph(g);
  out.contours = out.contours.map((c) => c.map((p) => ({ x: Math.round(p.x), y: Math.round(p.y), on: p.on })));
  out.components = out.components.map((c) => ({ ...c, dx: Math.round(c.dx), dy: Math.round(c.dy) }));
  return out;
}

export function decompose(g: Glyph, lookup: GlyphLookup): Glyph {
  if (!g.components.length) return cloneGlyph(g);
  return { contours: resolveContours(g, lookup).map((c) => c.map((p) => ({ ...p }))), components: [], instructions: new Uint8Array(0), overlap: g.overlap };
}

export function reverseContour(c: Contour): Contour {
  return c.length ? [c[0], ...c.slice(1).reverse()].map((p) => ({ ...p })) : c;
}

export function signedArea(c: Contour) {
  let a = 0;
  for (let i = 0; i < c.length; i++) {
    const p = c[i], q = c[(i + 1) % c.length];
    a += p.x * q.y - q.x * p.y;
  }
  return a / 2;
}

/** Make outer contours clockwise and counters counter-clockwise (TrueType convention). */
export function correctDirection(g: Glyph): Glyph {
  const out = cloneGlyph(g);
  out.contours = out.contours.map((c, i) => {
    // nesting depth by testing one point against the other contours
    const p = c[0];
    let depth = 0;
    out.contours.forEach((o, j) => { if (j !== i && pointInPolygon(p, o)) depth++; });
    const wantClockwise = depth % 2 === 0;
    const isClockwise = signedArea(c) < 0;
    return wantClockwise === isClockwise ? c : reverseContour(c);
  });
  return out;
}

export function pointInPolygon(p: { x: number; y: number }, c: Contour) {
  let inside = false;
  for (let i = 0, j = c.length - 1; i < c.length; j = i++) {
    const a = c[i], b = c[j];
    if ((a.y > p.y) !== (b.y > p.y) && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}

/** Point-preserving outline offset (FreeType FT_Outline_EmboldenXY, TrueType orientation).
 *  sx, sy are per-side amounts; negative values thin the glyph. */
export function emboldenContour(c: Contour, sx: number, sy: number, miter = 1.05): Contour {
  const n = c.length;
  if (n < 3 || (!sx && !sy)) return c.map((p) => ({ ...p }));
  const out: Point[] = [];
  for (let i = 0; i < n; i++) {
    const { x, y } = c[i];
    let j = (i - 1 + n) % n;
    while (j !== i && c[j].x === x && c[j].y === y) j = (j - 1 + n) % n;
    let k = (i + 1) % n;
    while (k !== i && c[k].x === x && c[k].y === y) k = (k + 1) % n;
    let ix = x - c[j].x, iy = y - c[j].y, ox = c[k].x - x, oy = c[k].y - y;
    const lin = Math.hypot(ix, iy), lout = Math.hypot(ox, oy);
    if (!lin || !lout) { out.push({ ...c[i] }); continue; }
    ix /= lin; iy /= lin; ox /= lout; oy /= lout;
    let d = ix * ox + iy * oy;
    let shx = 0, shy = 0;
    if (d > -0.9375) {
      d += 1;
      shx = -(iy + oy);
      shy = ix + ox;
      const q = -(ox * iy - oy * ix);
      const l = Math.min(lin, lout);
      const ax = Math.abs(sx), ay = Math.abs(sy);
      shx = ax * q <= l * d ? (shx * sx) / d : (shx * l * Math.sign(sx || 1)) / q;
      shy = ay * q <= l * d ? (shy * sy) / d : (shy * l * Math.sign(sy || 1)) / q;
      const lim = miter * Math.hypot(sx, sy), m = Math.hypot(shx, shy);
      if (m > lim && lim > 0) { shx *= lim / m; shy *= lim / m; }
    }
    out.push({ x: x + shx, y: y + shy, on: c[i].on });
  }
  return out;
}

export function emboldenGlyph(g: Glyph, sx: number, sy: number, lookup: GlyphLookup): Glyph {
  const base = decompose(g, lookup);
  base.contours = base.contours.map((c) => emboldenContour(c, sx, sy));
  return base;
}

// ------------------------------------------------------------ point edits

export function deletePoints(g: Glyph, sel: Set<string>): Glyph {
  const out = cloneGlyph(g);
  out.contours = out.contours.map((c, ci) => c.filter((_, pi) => !sel.has(`${ci}:${pi}`))).filter((c) => c.length >= 2);
  return out;
}

export function toggleOnCurve(g: Glyph, sel: Set<string>): Glyph {
  const out = cloneGlyph(g);
  out.contours.forEach((c, ci) => c.forEach((p, pi) => { if (sel.has(`${ci}:${pi}`)) p.on = !p.on; }));
  return out;
}

export function setStartPoint(g: Glyph, ci: number, pi: number): Glyph {
  const out = cloneGlyph(g);
  const c = out.contours[ci];
  out.contours[ci] = [...c.slice(pi), ...c.slice(0, pi)];
  return out;
}

/** Insert a point on the segment that starts at point `pi`, at parameter t. */
export function splitSegment(g: Glyph, ci: number, pi: number, t = 0.5): Glyph {
  const out = cloneGlyph(g);
  const c = out.contours[ci];
  const n = c.length;
  const a = c[pi], b = c[(pi + 1) % n];
  if (a.on && b.on) {
    c.splice(pi + 1, 0, { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t, on: true });
    return out;
  }
  if (!b.on) {
    // quadratic segment a(on or implied) - b(off) - next(on or implied)
    const nx = c[(pi + 2) % n];
    const start = a.on ? a : { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    const end = nx.on ? nx : { x: (b.x + nx.x) / 2, y: (b.y + nx.y) / 2 };
    const q0 = { x: start.x + (b.x - start.x) * t, y: start.y + (b.y - start.y) * t };
    const q1 = { x: b.x + (end.x - b.x) * t, y: b.y + (end.y - b.y) * t };
    const mid = { x: q0.x + (q1.x - q0.x) * t, y: q0.y + (q1.y - q0.y) * t, on: true };
    c.splice(pi + 1, 1, { ...q0, on: false }, mid, { ...q1, on: false });
    return out;
  }
  // a off, b on: segment belongs to the previous curve; add an on-curve midpoint on the line to b
  c.splice(pi + 1, 0, { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, on: true });
  return out;
}

export function rectContour(x0: number, y0: number, x1: number, y1: number): Contour {
  // clockwise in y-up space
  return [{ x: x0, y: y0, on: true }, { x: x0, y: y1, on: true }, { x: x1, y: y1, on: true }, { x: x1, y: y0, on: true }];
}

export function ellipseContour(cx: number, cy: number, rx: number, ry: number): Contour {
  // 8 off-curve points with implied on-curve points between them, clockwise
  const r = 1 / Math.cos(Math.PI / 8);
  const pts: Point[] = [];
  for (let i = 0; i < 8; i++) {
    const a = Math.PI / 2 - (i * Math.PI) / 4 - Math.PI / 8;
    pts.push({ x: cx + rx * r * Math.cos(a), y: cy + ry * r * Math.sin(a), on: false });
  }
  return pts;
}

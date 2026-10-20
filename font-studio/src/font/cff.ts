// PostScript (CFF) outlines -> TrueType quadratic contours, using opentype.js to read CFF.
import type { Contour, Glyph, Point } from './glyf.ts';
import { emptyGlyph } from './glyf.ts';

type P = { x: number; y: number };

/** Approximate a cubic Bézier with quadratic pieces to within `tol` font units. */
export function cubicToQuads(p0: P, c1: P, c2: P, p3: P, tol = 1): { ctrl: P; end: P }[] {
  const at = (t: number): P => {
    const u = 1 - t;
    return {
      x: u * u * u * p0.x + 3 * u * u * t * c1.x + 3 * u * t * t * c2.x + t * t * t * p3.x,
      y: u * u * u * p0.y + 3 * u * u * t * c1.y + 3 * u * t * t * c2.y + t * t * t * p3.y,
    };
  };
  const deriv = (t: number): P => {
    const u = 1 - t;
    return {
      x: 3 * u * u * (c1.x - p0.x) + 6 * u * t * (c2.x - c1.x) + 3 * t * t * (p3.x - c2.x),
      y: 3 * u * u * (c1.y - p0.y) + 6 * u * t * (c2.y - c1.y) + 3 * t * t * (p3.y - c2.y),
    };
  };
  for (let n = 1; n <= 16; n++) {
    const out: { ctrl: P; end: P }[] = [];
    let ok = true;
    for (let i = 0; i < n; i++) {
      const t0 = i / n, t1 = (i + 1) / n;
      const a = at(t0), b = at(t1);
      const d0 = deriv(t0), d1 = deriv(t1);
      const h = t1 - t0;
      // quadratic control from the tangents at both ends (averaged estimate)
      const qa = { x: a.x + d0.x * h / 2, y: a.y + d0.y * h / 2 };
      const qb = { x: b.x - d1.x * h / 2, y: b.y - d1.y * h / 2 };
      const ctrl = { x: (qa.x + qb.x) / 2, y: (qa.y + qb.y) / 2 };
      for (const s of [0.25, 0.5, 0.75]) {
        const c = at(t0 + h * s);
        const u = 1 - s;
        const q = { x: u * u * a.x + 2 * u * s * ctrl.x + s * s * b.x, y: u * u * a.y + 2 * u * s * ctrl.y + s * s * b.y };
        if (Math.hypot(c.x - q.x, c.y - q.y) > tol) { ok = false; break; }
      }
      out.push({ ctrl, end: b });
      if (!ok) break;
    }
    if (ok || n === 16) return out;
  }
  return [];
}

export async function cffToGlyphs(sfnt: Uint8Array, numGlyphs: number): Promise<{ glyphs: Glyph[]; names: string[] }> {
  const opentype: any = await import('opentype.js');
  const parse = opentype.parse ?? opentype.default?.parse;
  const font = parse(sfnt.buffer.slice(sfnt.byteOffset, sfnt.byteOffset + sfnt.byteLength));
  const glyphs: Glyph[] = [];
  const names: string[] = [];
  for (let i = 0; i < numGlyphs; i++) {
    const og = font.glyphs.get(i);
    names.push(og?.name ?? '');
    const g = emptyGlyph();
    let cur: Contour | null = null;
    let last: P = { x: 0, y: 0 };
    for (const cmd of og?.path?.commands ?? []) {
      if (cmd.type === 'M') {
        cur = [{ x: cmd.x, y: cmd.y, on: true }];
        g.contours.push(cur);
        last = { x: cmd.x, y: cmd.y };
      } else if (cmd.type === 'L' && cur) {
        cur.push({ x: cmd.x, y: cmd.y, on: true });
        last = { x: cmd.x, y: cmd.y };
      } else if (cmd.type === 'Q' && cur) {
        cur.push({ x: cmd.x1, y: cmd.y1, on: false }, { x: cmd.x, y: cmd.y, on: true });
        last = { x: cmd.x, y: cmd.y };
      } else if (cmd.type === 'C' && cur) {
        for (const q of cubicToQuads(last, { x: cmd.x1, y: cmd.y1 }, { x: cmd.x2, y: cmd.y2 }, { x: cmd.x, y: cmd.y })) {
          cur.push({ ...q.ctrl, on: false }, { ...q.end, on: true });
        }
        last = { x: cmd.x, y: cmd.y };
      } else if (cmd.type === 'Z' && cur) {
        const a = cur[0], b = cur[cur.length - 1];
        if (cur.length > 1 && b.on && Math.abs(a.x - b.x) < 1e-6 && Math.abs(a.y - b.y) < 1e-6) cur.pop();
        cur = null;
      }
    }
    // PostScript contours run counter-clockwise; TrueType expects clockwise outer contours
    g.contours = g.contours.filter((c) => c.length > 1).map((c) => [c[0], ...c.slice(1).reverse()] as Point[]);
    g.contours = g.contours.map((c) => c.map((p) => ({ x: Math.round(p.x), y: Math.round(p.y), on: p.on })));
    glyphs.push(g);
  }
  return { glyphs, names };
}

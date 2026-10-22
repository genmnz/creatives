// SVG path data -> the subset Alight Motion writes itself: absolute M, L, C, Z.
// Every <path d> in the app's own exports uses only these commands, so any
// path an AI writes (relative commands, H/V, Q/T, S, A) is normalized first.

const NUM = /[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?/y;

function tokenize(d) {
  const out = [];
  let i = 0, cmd = "", n = 0;
  while (i < d.length) {
    const c = d[i];
    if (/[MmLlHhVvCcSsQqTtAaZz]/.test(c)) { out.push(c); cmd = c; n = 0; i++; continue; }
    if (/[\s,]/.test(c)) { i++; continue; }
    // Arc flags are single digits and may be written without separators ("a5 5 0 017.07 0").
    if ((cmd === "a" || cmd === "A") && (n % 7 === 3 || n % 7 === 4) && (c === "0" || c === "1")) { out.push(Number(c)); n++; i++; continue; }
    n++;
    NUM.lastIndex = i;
    const m = NUM.exec(d);
    if (!m) throw new Error(`bad path data near "${d.slice(i, i + 12)}"`);
    out.push(Number(m[0]));
    i = NUM.lastIndex;
  }
  return out;
}

function arcToCubics(x1, y1, rx, ry, phi, fa, fs, x2, y2) {
  // SVG arc implementation notes F.6, converted to cubic segments.
  if (rx === 0 || ry === 0) return [[x1, y1, x2, y2, x2, y2]];
  const rad = (phi * Math.PI) / 180, cos = Math.cos(rad), sin = Math.sin(rad);
  const dx = (x1 - x2) / 2, dy = (y1 - y2) / 2;
  const xp = cos * dx + sin * dy, yp = -sin * dx + cos * dy;
  rx = Math.abs(rx); ry = Math.abs(ry);
  const lam = (xp * xp) / (rx * rx) + (yp * yp) / (ry * ry);
  if (lam > 1) { rx *= Math.sqrt(lam); ry *= Math.sqrt(lam); }
  const sign = fa === fs ? -1 : 1;
  const num = rx * rx * ry * ry - rx * rx * yp * yp - ry * ry * xp * xp;
  const co = sign * Math.sqrt(Math.max(0, num / (rx * rx * yp * yp + ry * ry * xp * xp)));
  const cxp = (co * rx * yp) / ry, cyp = (-co * ry * xp) / rx;
  const cx = cos * cxp - sin * cyp + (x1 + x2) / 2, cy = sin * cxp + cos * cyp + (y1 + y2) / 2;
  const ang = (ux, uy, vx, vy) => {
    const a = Math.atan2(ux * vy - uy * vx, ux * vx + uy * vy);
    return a;
  };
  const t1 = ang(1, 0, (xp - cxp) / rx, (yp - cyp) / ry);
  let dt = ang((xp - cxp) / rx, (yp - cyp) / ry, (-xp - cxp) / rx, (-yp - cyp) / ry);
  if (!fs && dt > 0) dt -= 2 * Math.PI;
  if (fs && dt < 0) dt += 2 * Math.PI;
  const n = Math.ceil(Math.abs(dt) / (Math.PI / 2));
  const step = dt / n, k = (4 / 3) * Math.tan(step / 4);
  const pt = (t) => [cx + rx * Math.cos(t) * cos - ry * Math.sin(t) * sin, cy + rx * Math.cos(t) * sin + ry * Math.sin(t) * cos];
  const der = (t) => [-rx * Math.sin(t) * cos - ry * Math.cos(t) * sin, -rx * Math.sin(t) * sin + ry * Math.cos(t) * cos];
  const segs = [];
  for (let i = 0; i < n; i++) {
    const a = t1 + step * i, b = a + step;
    const [ax, ay] = pt(a), [bx, by] = pt(b), [dax, day] = der(a), [dbx, dby] = der(b);
    segs.push([ax + k * dax, ay + k * day, bx - k * dbx, by - k * dby, bx, by]);
  }
  return segs;
}

/** Parse any SVG path into absolute segments: {c:'M'|'L'|'C'|'Z', p:[...]} */
export function parsePath(d) {
  const t = tokenize(String(d));
  const segs = [];
  let i = 0, cmd = null, x = 0, y = 0, sx = 0, sy = 0, lc = null, lq = null;
  const num = () => {
    if (typeof t[i] !== "number") throw new Error(`path: expected number after ${cmd}`);
    return t[i++];
  };
  while (i < t.length) {
    if (typeof t[i] === "string") cmd = t[i++];
    else if (cmd === null) throw new Error("path must start with M");
    else if (cmd === "M") cmd = "L";
    else if (cmd === "m") cmd = "l";
    const rel = cmd === cmd.toLowerCase();
    const C = cmd.toUpperCase();
    const ox = rel ? x : 0, oy = rel ? y : 0;
    let nlc = null, nlq = null;
    switch (C) {
      case "M": x = ox + num(); y = oy + num(); sx = x; sy = y; segs.push({ c: "M", p: [x, y] }); break;
      case "L": x = ox + num(); y = oy + num(); segs.push({ c: "L", p: [x, y] }); break;
      case "H": x = ox + num(); segs.push({ c: "L", p: [x, y] }); break;
      case "V": y = (rel ? y : 0) + num(); segs.push({ c: "L", p: [x, y] }); break;
      case "C": {
        const a = [ox + num(), oy + num(), ox + num(), oy + num(), ox + num(), oy + num()];
        segs.push({ c: "C", p: a }); nlc = [a[2], a[3]]; x = a[4]; y = a[5]; break;
      }
      case "S": {
        const r = lc ? [2 * x - lc[0], 2 * y - lc[1]] : [x, y];
        const a = [...r, ox + num(), oy + num(), ox + num(), oy + num()];
        segs.push({ c: "C", p: a }); nlc = [a[2], a[3]]; x = a[4]; y = a[5]; break;
      }
      case "Q": case "T": {
        const q = C === "Q" ? [ox + num(), oy + num()] : lq ? [2 * x - lq[0], 2 * y - lq[1]] : [x, y];
        const ex = ox + num(), ey = oy + num();
        segs.push({ c: "C", p: [x + (2 / 3) * (q[0] - x), y + (2 / 3) * (q[1] - y), ex + (2 / 3) * (q[0] - ex), ey + (2 / 3) * (q[1] - ey), ex, ey] });
        nlq = q; x = ex; y = ey; break;
      }
      case "A": {
        const rx = num(), ry = num(), phi = num(), fa = num(), fs = num();
        const ex = ox + num(), ey = oy + num();
        for (const s of arcToCubics(x, y, rx, ry, phi, !!fa, !!fs, ex, ey)) segs.push({ c: "C", p: s });
        x = ex; y = ey; break;
      }
      case "Z": segs.push({ c: "Z", p: [] }); x = sx; y = sy; break;
      default: throw new Error(`path: unsupported command ${cmd}`);
    }
    lc = nlc; lq = nlq;
  }
  return segs;
}

const f = (n) => {
  const v = Math.round(n * 1000) / 1000;
  return (Object.is(v, -0) ? 0 : v).toFixed(Number.isInteger(v) ? 1 : 3).replace(/(\.\d*?)0+$/, "$1").replace(/\.$/, ".0");
};

export function formatPath(segs) {
  let s = "";
  for (const g of segs) {
    if (g.c === "Z") s += "Z";
    else if (g.c === "C") s += `C ${f(g.p[0])} ${f(g.p[1])}, ${f(g.p[2])} ${f(g.p[3])}, ${f(g.p[4])} ${f(g.p[5])}`;
    else s += `${g.c} ${f(g.p[0])} ${f(g.p[1])}`;
  }
  return s;
}

export function mapPath(segs, fn) {
  return segs.map((g) => {
    const p = [];
    for (let i = 0; i < g.p.length; i += 2) p.push(...fn(g.p[i], g.p[i + 1]));
    return { c: g.c, p };
  });
}

export function pathBounds(segs) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const g of segs) for (let i = 0; i < g.p.length; i += 2) {
    minX = Math.min(minX, g.p[i]); maxX = Math.max(maxX, g.p[i]);
    minY = Math.min(minY, g.p[i + 1]); maxY = Math.max(maxY, g.p[i + 1]);
  }
  return { minX, minY, maxX, maxY, cx: (minX + maxX) / 2, cy: (minY + maxY) / 2, w: maxX - minX, h: maxY - minY };
}

/** Normalize any SVG path to Alight Motion's absolute M/L/C/Z form. */
export function normalizePath(d) {
  return formatPath(parsePath(d));
}

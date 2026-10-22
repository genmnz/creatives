// Preview geometry for Alight Motion's built-in shape templates (s=".rect" etc).
// Coordinates are layer-local pixels, origin at the layer's location, y down.
// "size" parameters are half-extents: size="540,540" is a 1080x1080 square.
// These are independent re-implementations for previewing, not the app's code.

const K = 0.5522847498;
const P = (x, y) => ({ p: [x, y] });
const C = (x, y, inp, out) => ({ p: [x, y], in: inp, out });

function polar(r, angle) {
  return [r * Math.cos(angle), -r * Math.sin(angle)];
}

function arcNodes(r, a0, a1) {
  // Approximate a circular arc (radians, y up) with cubic segments.
  const nodes = [];
  const n = Math.max(1, Math.ceil(Math.abs(a1 - a0) / (Math.PI / 2)));
  const step = (a1 - a0) / n;
  const h = (4 / 3) * Math.tan(step / 4) * r;
  for (let i = 0; i <= n; i++) {
    const a = a0 + step * i;
    const [x, y] = polar(r, a);
    const tx = -Math.sin(a), ty = -Math.cos(a); // tangent in y-down space
    nodes.push(C(x, y, i > 0 ? [x - tx * h, y - ty * h] : undefined, i < n ? [x + tx * h, y + ty * h] : undefined));
  }
  return nodes;
}

const GEOMETRY = {
  rect: ({ size: [w, h] }) => ({ nodes: [P(-w, -h), P(w, -h), P(w, h), P(-w, h)], closed: true }),
  circle: ({ size: [w, h] }) => ({
    nodes: [
      C(0, -h, [-K * w, -h], [K * w, -h]), C(w, 0, [w, -K * h], [w, K * h]),
      C(0, h, [K * w, h], [-K * w, h]), C(-w, 0, [-w, K * h], [-w, -K * h]),
    ], closed: true,
  }),
  roundrect: ({ size: [w, h], cornerRadius }) => {
    const r = Math.min(Math.max(0, cornerRadius), Math.min(w, h)), o = r * (1 - K);
    return {
      nodes: [
        C(-w + r, -h, [-w + o, -h]), C(w - r, -h, undefined, [w - o, -h]),
        C(w, -h + r, [w, -h + o]), C(w, h - r, undefined, [w, h - o]),
        C(w - r, h, [w - o, h]), C(-w + r, h, undefined, [-w + o, h]),
        C(-w, h - r, [-w, h - o]), C(-w, -h + r, undefined, [-w, -h + o]),
      ], closed: true,
    };
  },
  triangle: ({ p1, p2, p3, closed }) => ({ nodes: [p1, p2, p3].map(([x, y]) => P(x, y)), closed }),
  quad: ({ p1, p2, p3, p4, closed }) => ({ nodes: [p1, p2, p3, p4].map(([x, y]) => P(x, y)), closed }),
  penta: ({ p1, p2, p3, p4, p5, closed }) => ({ nodes: [p1, p2, p3, p4, p5].map(([x, y]) => P(x, y)), closed }),
  line: ({ p1, p2 }) => ({ nodes: [P(...p1), P(...p2)], closed: false }),
  poly: ({ sideCount, radius, offsetAngle }) => {
    const n = Math.max(3, Math.round(sideCount)), nodes = [];
    for (let i = 0; i < n; i++) nodes.push(P(...polar(radius, (2 * Math.PI * i) / n + Math.PI / 2 + (offsetAngle * Math.PI) / 180)));
    return { nodes, closed: true };
  },
  star: ({ pointCount, outerRadius, innerRadius, offsetAngle }) => {
    const n = Math.max(3, Math.round(pointCount)), nodes = [];
    for (let i = 0; i < n; i++) {
      const a = (2 * Math.PI * i) / n + Math.PI / 2 + (offsetAngle * Math.PI) / 180;
      nodes.push(P(...polar(outerRadius, a)), P(...polar(innerRadius, a + Math.PI / n)));
    }
    return { nodes, closed: true };
  },
  multifoil: ({ pointCount, outerRadius, innerRadius, offsetAngle }) => {
    const n = Math.max(3, Math.round(pointCount)), nodes = [];
    const pw = (innerRadius * Math.PI) / n;
    for (let i = 0; i < n; i++) {
      const a = (2 * Math.PI * i) / n + Math.PI / 2 + (offsetAngle * Math.PI) / 180;
      const [x, y] = polar(outerRadius, a);
      const tx = -Math.sin(a), ty = -Math.cos(a);
      nodes.push(C(x, y, [x - tx * pw, y - ty * pw], [x + tx * pw, y + ty * pw]));
      const [ix, iy] = polar(innerRadius, a + Math.PI / n);
      nodes.push(P(ix, iy));
    }
    return { nodes, closed: true };
  },
  plus: ({ size: [w, h], stemSize }) => {
    const s = stemSize / 2;
    return { nodes: [[-s, -h], [s, -h], [s, -s], [w, -s], [w, s], [s, s], [s, h], [-s, h], [-s, s], [-w, s], [-w, -s], [-s, -s]].map(([x, y]) => P(x, y)), closed: true };
  },
  wideline: ({ start, end, lineWidth }) => {
    const [dx, dy] = [end[0] - start[0], end[1] - start[1]], l = Math.hypot(dx, dy) || 1;
    const [cx, cy] = [(-dy / l) * lineWidth, (dx / l) * lineWidth];
    return { nodes: [P(start[0] + cx, start[1] + cy), P(start[0] - cx, start[1] - cy), P(end[0] - cx, end[1] - cy), P(end[0] + cx, end[1] + cy)], closed: true };
  },
  arrow: ({ start, end, lineWidth, headWidth, headLength }) => {
    const [dx, dy] = [end[0] - start[0], end[1] - start[1]], l = Math.hypot(dx, dy) || 1;
    const [nx, ny] = [dx / l, dy / l], lw = Math.min(headWidth, lineWidth), tail = l - headLength;
    const at = (side, w, along) => P(start[0] + side * (-ny) * w + nx * along, start[1] + side * nx * w + ny * along);
    return { nodes: [at(1, lw, 0), at(-1, lw, 0), at(-1, lw, tail), at(-1, headWidth, tail), P(end[0], end[1]), at(1, headWidth, tail), at(1, lw, tail)], closed: true };
  },
  pie: ({ startAngle, endAngle, radius }) => {
    const nodes = arcNodes(radius, (startAngle * Math.PI) / 180, (endAngle * Math.PI) / 180);
    return { nodes: [...nodes, P(0, 0)], closed: true };
  },
  arc: ({ startAngle, endAngle, radius, closed }) => ({ nodes: arcNodes(radius, (startAngle * Math.PI) / 180, (endAngle * Math.PI) / 180), closed: !!closed }),
  moon: ({ radius, offset }) => {
    // Crescent: outer circle minus an offset circle, drawn as two arcs.
    const d = Math.min(Math.max(offset, 1), radius * 2 - 1) * (radius / 250);
    const ang = Math.acos(Math.min(1, d / (2 * radius)));
    const outer = arcNodes(radius, ang, 2 * Math.PI - ang);
    return { nodes: outer, closed: true };
  },
  teardrop: ({ radius, tail }) => {
    const nodes = arcNodes(radius, -Math.PI / 6, Math.PI + Math.PI / 6);
    return { nodes: [...nodes, P(0, Math.min(tail, radius * 4))], closed: true };
  },
  "callout.roundrect": (p) => GEOMETRY.roundrect(p),
  stamp: ({ size, cornerRadius }) => GEOMETRY.roundrect({ size, cornerRadius }),
  testshape: (p) => GEOMETRY.rect(p),
};

const fmt = (n) => +n.toFixed(3);

export function nodesToD({ nodes, closed }) {
  if (!nodes.length) return "";
  let d = `M ${fmt(nodes[0].p[0])} ${fmt(nodes[0].p[1])}`;
  const seg = (a, b) => {
    if (a.out || b.in) {
      const c1 = a.out ?? a.p, c2 = b.in ?? b.p;
      return ` C ${fmt(c1[0])} ${fmt(c1[1])}, ${fmt(c2[0])} ${fmt(c2[1])}, ${fmt(b.p[0])} ${fmt(b.p[1])}`;
    }
    return ` L ${fmt(b.p[0])} ${fmt(b.p[1])}`;
  };
  for (let i = 1; i < nodes.length; i++) d += seg(nodes[i - 1], nodes[i]);
  if (closed) d += seg(nodes[nodes.length - 1], nodes[0]) + " Z";
  return d;
}

/** SVG path data for a template ref like ".rect" with resolved params. */
export function templatePath(ref, params) {
  const key = ref.replace(/^\./, "");
  const g = GEOMETRY[key];
  if (!g) return null;
  try {
    return nodesToD(g(params));
  } catch {
    return null;
  }
}

export const TEMPLATE_KEYS = Object.keys(GEOMETRY);

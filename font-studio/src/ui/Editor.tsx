import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { studio, useStudio, glyphPath } from '../store.ts';
import { cloneGlyph, contoursToPath, type Glyph, type Point } from '../font/glyf.ts';
import {
  transformGlyph, translate, splitSegment, deletePoints, rectContour, ellipseContour,
  pointInPolygon, signedArea, reverseContour, decompose,
} from '../font/ops.ts';
import type { AnchorRef } from '../font/otl.ts';
import { hex, parseCodepoints } from './common.tsx';

type Tool = 'select' | 'pen' | 'rect' | 'ellipse' | 'hand';
interface View { scale: number; ox: number; oy: number; }

interface Drag {
  mode: 'points' | 'anchor' | 'component' | 'marquee' | 'pan' | 'shape';
  sx: number; sy: number;          // screen start
  fx: number; fy: number;          // font start
  orig?: Glyph;
  moving?: Set<string>;
  anchors?: { ref: AnchorRef; x: number; y: number }[];
  comp?: number;
  view?: View;
  cur?: { fx: number; fy: number };
}

/** anchors of a glyph grouped by what they look like on screen (kind + position) */
export function anchorGroups(refs: AnchorRef[], value: (a: AnchorRef) => { x: number; y: number }) {
  const groups = new Map<string, { kind: string; cls: number; x: number; y: number; refs: AnchorRef[] }>();
  for (const a of refs) {
    const v = value(a);
    const key = `${a.kind}:${a.component ?? ''}:${v.x}:${v.y}`;
    if (!groups.has(key)) groups.set(key, { kind: a.kind, cls: a.cls, x: v.x, y: v.y, refs: [] });
    groups.get(key)!.refs.push(a);
  }
  return [...groups.values()];
}

export function Editor() {
  const s = useStudio();
  const p = s.project!;
  const gid = s.gid;
  const glyph = p.glyphs[gid];
  const isComposite = glyph.components.length > 0;
  const svgRef = useRef<SVGSVGElement>(null);
  const [size, setSize] = useState({ w: 800, h: 600 });
  const [view, setView] = useState<View>({ scale: 0.2, ox: 400, oy: 400 });
  const [tool, setTool] = useState<Tool>('select');
  const [show, setShow] = useState({ fill: true, points: true, metrics: true, anchors: true, coords: false });
  const [bgName, setBgName] = useState('');
  const [penContour, setPenContour] = useState<number | null>(null);
  const [marquee, setMarquee] = useState<{ x0: number; y0: number; x1: number; y1: number } | null>(null);
  const [shapePreview, setShapePreview] = useState<{ x0: number; y0: number; x1: number; y1: number } | null>(null);
  const [space, setSpace] = useState(false);
  const drag = useRef<Drag | null>(null);

  const asc = p.hhea.ascender, desc = p.hhea.descender;
  const xh = p.os2.sxHeight, cap = p.os2.sCapHeight;
  const adv = p.adv[gid];

  const toFont = useCallback((sx: number, sy: number) => ({ x: (sx - view.ox) / view.scale, y: (view.oy - sy) / view.scale }), [view]);
  const toScreen = (x: number, y: number) => ({ x: x * view.scale + view.ox, y: view.oy - y * view.scale });

  const fit = useCallback(() => {
    const b = p.bounds(gid);
    const x0 = Math.min(0, b?.xMin ?? 0), x1 = Math.max(p.adv[gid], b?.xMax ?? 0, p.upm * 0.3);
    const y0 = Math.min(desc, b?.yMin ?? 0), y1 = Math.max(asc, b?.yMax ?? 0);
    const scale = Math.min(size.w / ((x1 - x0) * 1.3), size.h / ((y1 - y0) * 1.15));
    setView({ scale, ox: size.w / 2 - scale * (x0 + x1) / 2, oy: size.h / 2 + scale * (y0 + y1) / 2 });
  }, [p, gid, size, asc, desc]);

  useLayoutEffect(() => {
    const el = svgRef.current!.parentElement!;
    const ro = new ResizeObserver(() => setSize({ w: el.clientWidth, h: el.clientHeight }));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  useEffect(() => { fit(); setPenContour(null); }, [gid, p, size.w > 0 && size.h > 0]);

  const commitGlyph = (label: string, g: Glyph) => studio.commit(label, { glyphs: [gid] }, (proj) => proj.setGlyph(gid, g));

  // ---------------------------------------------------------- keyboard
  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement)?.closest('input, textarea, select')) return;
      const mod = e.metaKey || e.ctrlKey;
      if (e.key === ' ') { setSpace(true); e.preventDefault(); return; }
      if (mod && e.key.toLowerCase() === 'a') {
        e.preventDefault();
        const sel = new Set<string>();
        glyph.contours.forEach((c, ci) => c.forEach((_, pi) => sel.add(`${ci}:${pi}`)));
        studio.points = sel; studio.notify(); return;
      }
      if (mod) return;
      const k = e.key.toLowerCase();
      if (k === 'v') setTool('select');
      else if (k === 'p') setTool('pen');
      else if (k === 'r') setTool('rect');
      else if (k === 'e') setTool('ellipse');
      else if (k === 'h') setTool('hand');
      else if (k === 'f') fit();
      else if (e.key === '[') studio.selectGlyph(gid - 1);
      else if (e.key === ']') studio.selectGlyph(gid + 1);
      else if (e.key === 'Escape') { setPenContour(null); studio.points.clear(); studio.notify(); }
      else if (e.key === 'Enter') setPenContour(null);
      else if ((e.key === 'Delete' || e.key === 'Backspace') && studio.points.size) {
        e.preventDefault();
        commitGlyph(`Delete ${studio.points.size} points`, deletePoints(glyph, studio.points));
        studio.points.clear();
      } else if (e.key.startsWith('Arrow') && studio.points.size) {
        e.preventDefault();
        const d = e.shiftKey ? 10 : 1;
        const dx = e.key === 'ArrowLeft' ? -d : e.key === 'ArrowRight' ? d : 0;
        const dy = e.key === 'ArrowDown' ? -d : e.key === 'ArrowUp' ? d : 0;
        commitGlyph('Nudge points', transformGlyph(glyph, translate(dx, dy), withHandles(glyph, studio.points)));
      }
    };
    const up = (e: KeyboardEvent) => { if (e.key === ' ') setSpace(false); };
    window.addEventListener('keydown', down);
    window.addEventListener('keyup', up);
    return () => { window.removeEventListener('keydown', down); window.removeEventListener('keyup', up); };
  }, [glyph, gid, fit]);

  // ---------------------------------------------------------- pointer
  const local = (e: React.PointerEvent | React.WheelEvent | React.MouseEvent) => {
    const r = svgRef.current!.getBoundingClientRect();
    return { sx: e.clientX - r.left, sy: e.clientY - r.top };
  };

  const onWheel = (e: React.WheelEvent) => {
    const { sx, sy } = local(e);
    const f = Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.0015));
    const scale = Math.min(20, Math.max(0.005, view.scale * f));
    const k = scale / view.scale;
    setView({ scale, ox: sx - (sx - view.ox) * k, oy: sy - (sy - view.oy) * k });
  };

  const onPointerDown = (e: React.PointerEvent) => {
    (e.target as Element).setPointerCapture?.(e.pointerId);
    const { sx, sy } = local(e);
    const f = toFont(sx, sy);
    const base: Drag = { mode: 'pan', sx, sy, fx: f.x, fy: f.y, view };
    const t = e.target as SVGElement;
    if (e.button === 1 || tool === 'hand' || space) { drag.current = base; return; }

    const anchorKey = t.dataset.anchor;
    if (anchorKey !== undefined && p.gpos) {
      const group = groups[Number(anchorKey)];
      studio.begin({ gpos: true });
      drag.current = { ...base, mode: 'anchor', anchors: group.refs.map((ref) => ({ ref, ...p.anchorValue(ref) })) };
      return;
    }
    if (tool === 'pen') { penClick(f, e.shiftKey); return; }
    if (tool === 'rect' || tool === 'ellipse') {
      drag.current = { ...base, mode: 'shape', cur: { fx: f.x, fy: f.y } };
      return;
    }
    const pt = t.dataset.pt;
    if (pt !== undefined && !isComposite) {
      const sel = new Set(studio.points);
      if (e.shiftKey) { sel.has(pt) ? sel.delete(pt) : sel.add(pt); }
      else if (!sel.has(pt)) { sel.clear(); sel.add(pt); }
      studio.points = sel;
      studio.begin({ glyphs: [gid] });
      drag.current = { ...base, mode: 'points', orig: cloneGlyph(glyph), moving: e.altKey ? sel : withHandles(glyph, sel) };
      studio.notify();
      return;
    }
    const comp = t.dataset.comp;
    if (comp !== undefined) {
      studio.begin({ glyphs: [gid] });
      drag.current = { ...base, mode: 'component', comp: Number(comp), orig: cloneGlyph(glyph) };
      return;
    }
    if (!e.shiftKey && studio.points.size) { studio.points = new Set(); studio.notify(); }
    drag.current = { ...base, mode: 'marquee' };
  };

  const onPointerMove = (e: React.PointerEvent) => {
    const d = drag.current;
    if (!d) return;
    const { sx, sy } = local(e);
    const f = toFont(sx, sy);
    let dx = Math.round(f.x - d.fx), dy = Math.round(f.y - d.fy);
    if (e.shiftKey && (d.mode === 'points' || d.mode === 'component' || d.mode === 'anchor')) {
      if (Math.abs(dx) > Math.abs(dy)) dy = 0; else dx = 0; // constrain to an axis
    }
    if (d.mode === 'pan') {
      setView({ ...d.view!, ox: d.view!.ox + sx - d.sx, oy: d.view!.oy + sy - d.sy });
    } else if (d.mode === 'points') {
      p.setGlyph(gid, transformGlyph(d.orig!, translate(dx, dy), d.moving), { keepInstructions: false });
      studio.notify();
    } else if (d.mode === 'component') {
      const g = cloneGlyph(d.orig!);
      const c = g.components[d.comp!];
      c.dx += dx; c.dy += dy;
      p.setGlyph(gid, g, { keepInstructions: false });
      studio.notify();
    } else if (d.mode === 'anchor') {
      for (const a of d.anchors!) p.setAnchor(a.ref, a.x + dx, a.y + dy, true);
      studio.notify();
    } else if (d.mode === 'marquee') {
      setMarquee({ x0: d.fx, y0: d.fy, x1: f.x, y1: f.y });
    } else if (d.mode === 'shape') {
      setShapePreview({ x0: Math.round(d.fx), y0: Math.round(d.fy), x1: Math.round(f.x), y1: Math.round(f.y) });
    }
  };

  const onPointerUp = () => {
    const d = drag.current;
    drag.current = null;
    if (!d) return;
    if (d.mode === 'points') studio.end('Move points');
    else if (d.mode === 'component') studio.end('Move component');
    else if (d.mode === 'anchor') studio.end('Move anchor');
    else if (d.mode === 'marquee' && marquee) {
      const x0 = Math.min(marquee.x0, marquee.x1), x1 = Math.max(marquee.x0, marquee.x1);
      const y0 = Math.min(marquee.y0, marquee.y1), y1 = Math.max(marquee.y0, marquee.y1);
      const sel = new Set(studio.points);
      glyph.contours.forEach((c, ci) => c.forEach((pt, pi) => { if (pt.x >= x0 && pt.x <= x1 && pt.y >= y0 && pt.y <= y1) sel.add(`${ci}:${pi}`); }));
      studio.points = sel;
      setMarquee(null);
      studio.notify();
    } else if (d.mode === 'shape' && shapePreview) {
      const { x0, y0, x1, y1 } = shapePreview;
      setShapePreview(null);
      if (Math.abs(x1 - x0) < 2 || Math.abs(y1 - y0) < 2) return;
      const xa = Math.min(x0, x1), xb = Math.max(x0, x1), ya = Math.min(y0, y1), yb = Math.max(y0, y1);
      const c = tool === 'rect' ? rectContour(xa, ya, xb, yb) : ellipseContour((xa + xb) / 2, (ya + yb) / 2, (xb - xa) / 2, (yb - ya) / 2).map((q) => ({ ...q, x: Math.round(q.x), y: Math.round(q.y) }));
      const g = isComposite ? decompose(glyph, p.lookup) : cloneGlyph(glyph);
      g.contours.push(orient(c, g.contours));
      commitGlyph(tool === 'rect' ? 'Add rectangle' : 'Add ellipse', g);
    }
  };

  const onDoubleClick = (e: React.MouseEvent) => {
    if (tool !== 'select' || isComposite) return;
    const { sx, sy } = local(e);
    const f = toFont(sx, sy);
    const hit = nearestSegment(glyph, f, 10 / view.scale);
    if (hit) commitGlyph('Add point', splitSegment(glyph, hit.ci, hit.pi, hit.t));
  };

  const penClick = (f: { x: number; y: number }, off: boolean) => {
    const pt: Point = { x: Math.round(f.x), y: Math.round(f.y), on: !off };
    const g = isComposite ? decompose(glyph, p.lookup) : cloneGlyph(glyph);
    if (penContour === null || !g.contours[penContour]) {
      g.contours.push([pt]);
      setPenContour(g.contours.length - 1);
      commitGlyph('Start contour', g);
      return;
    }
    const c = g.contours[penContour];
    const first = c[0];
    if (c.length >= 3 && Math.hypot(first.x - pt.x, first.y - pt.y) * view.scale < 8) {
      g.contours[penContour] = orient(c, g.contours.filter((_, i) => i !== penContour));
      setPenContour(null);
      commitGlyph('Close contour', g);
      return;
    }
    c.push(pt);
    commitGlyph(off ? 'Add off-curve point' : 'Add point', g);
  };

  // ---------------------------------------------------------- data for drawing
  const refs = p.pos.byGlyph.get(gid)?.anchors ?? [];
  const groups = useMemo(() => anchorGroups(refs, (a) => p.anchorValue(a)), [refs, p.version, s.tick]);
  const bgGid = useMemo(() => {
    if (!bgName) return -1;
    const byName = p.glyphByName(bgName);
    if (byName >= 0) return byName;
    const cp = parseCodepoints(bgName)[0];
    return cp !== undefined ? p.cmap.get(cp) ?? -1 : -1;
  }, [bgName, p]);

  const m = `matrix(${view.scale} 0 0 ${-view.scale} ${view.ox} ${view.oy})`;
  const hline = (y: number, cls: string, label: string) => {
    const sy = view.oy - y * view.scale;
    return (
      <g key={label} className={cls}>
        <line x1={0} x2={size.w} y1={sy} y2={sy} />
        <text x={6} y={sy - 4}>{label} {y}</text>
      </g>
    );
  };
  const cursor = space || tool === 'hand' ? 'grab' : tool === 'select' ? 'default' : 'crosshair';

  return (
    <div className="editor">
      <div className="editor-toolbar">
        {([['select', 'Select (V)'], ['pen', 'Pen (P)'], ['rect', 'Rectangle (R)'], ['ellipse', 'Ellipse (E)'], ['hand', 'Pan (H / Space)']] as [Tool, string][]).map(([t, l]) => (
          <button key={t} className={tool === t ? 'on' : ''} onClick={() => setTool(t)} title={l}>{l.split(' (')[0]}</button>
        ))}
        <span className="sep" />
        <button onClick={() => studio.selectGlyph(gid - 1)} title="Previous glyph ([)">‹</button>
        <span className="glyph-title">
          <b>{p.names[gid]}</b> <span className="muted">GID {gid}{p.unicodesOf(gid).length ? ' · ' + p.unicodesOf(gid).map((c) => `${String.fromCodePoint(c)} U+${hex(c)}`).join(', ') : ''}</span>
        </span>
        <button onClick={() => studio.selectGlyph(gid + 1)} title="Next glyph (])">›</button>
        <span className="sep" />
        <button onClick={fit} title="Fit (F)">Fit</button>
        <span className="muted">{Math.round(view.scale * p.upm)} px/em</span>
        <span className="grow" />
        {(['fill', 'points', 'metrics', 'anchors', 'coords'] as const).map((k) => (
          <label key={k} className="check small"><input type="checkbox" checked={show[k]} onChange={(e) => setShow({ ...show, [k]: e.target.checked })} />{k}</label>
        ))}
        <input className="bg-input" placeholder="Background glyph" value={bgName} onChange={(e) => setBgName(e.target.value)} title="Show another glyph behind this one (name or character)" />
      </div>
      <div className="canvas-wrap">
        {isComposite && (
          <div className="banner">
            Composite glyph built from {glyph.components.map((c) => p.names[c.gid]).join(' + ')}: drag a component to move it, or
            <button onClick={() => commitGlyph('Decompose', decompose(glyph, p.lookup))}>Decompose to edit points</button>
          </div>
        )}
        {s.buildError && <div className="banner error">{s.buildError}</div>}
        <svg ref={svgRef} width={size.w} height={size.h} style={{ cursor }}
          onWheel={onWheel} onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerUp}
          onDoubleClick={onDoubleClick}>
          {show.metrics && (
            <g className="metrics">
              {hline(0, 'baseline', 'baseline')}
              {hline(asc, 'asc', 'ascender')}
              {hline(desc, 'desc', 'descender')}
              {xh ? hline(xh, 'xh', 'x-height') : null}
              {cap ? hline(cap, 'cap', 'cap height') : null}
              <line className="adv" x1={view.ox} x2={view.ox} y1={0} y2={size.h} />
              <line className="adv" x1={view.ox + adv * view.scale} x2={view.ox + adv * view.scale} y1={0} y2={size.h} />
              <text className="adv-label" x={view.ox + adv * view.scale / 2} y={16} textAnchor="middle">advance {adv}</text>
            </g>
          )}
          {bgGid >= 0 && <path className="bg-glyph" transform={m} d={glyphPath(p, bgGid)} />}
          {isComposite ? (
            glyph.components.map((c, i) => (
              <path key={i} data-comp={i} className={`component c${i % 4}`} transform={m}
                d={contoursToPath(p.contours(c.gid).map((con) => con.map((q) => ({ x: c.m[0] * q.x + c.m[2] * q.y + c.dx, y: c.m[1] * q.x + c.m[3] * q.y + c.dy, on: q.on }))))} />
            ))
          ) : (
            <path className={show.fill ? 'glyph-fill' : 'glyph-outline'} transform={m} d={contoursToPath(glyph.contours)} />
          )}
          {show.points && !isComposite && glyph.contours.map((c, ci) => (
            <g key={ci}>
              {c.map((pt, pi) => {
                if (pt.on) return null;
                const a = toScreen(pt.x, pt.y);
                const prev = c[(pi - 1 + c.length) % c.length], next = c[(pi + 1) % c.length];
                const pa = toScreen(prev.x, prev.y), pb = toScreen(next.x, next.y);
                return <g key={pi} className="handle"><line x1={a.x} y1={a.y} x2={pa.x} y2={pa.y} /><line x1={a.x} y1={a.y} x2={pb.x} y2={pb.y} /></g>;
              })}
              {c.map((pt, pi) => {
                const a = toScreen(pt.x, pt.y);
                const key = `${ci}:${pi}`;
                const sel = s.points.has(key);
                const cls = `pt ${pt.on ? 'on' : 'off'}${sel ? ' sel' : ''}${pi === 0 ? ' start' : ''}`;
                return (
                  <g key={key}>
                    {pt.on
                      ? <rect data-pt={key} className={cls} x={a.x - 4} y={a.y - 4} width={8} height={8} />
                      : <circle data-pt={key} className={cls} cx={a.x} cy={a.y} r={4} />}
                    {(show.coords || (sel && s.points.size === 1)) && <text className="coord" x={a.x + 7} y={a.y - 7}>{pt.x}, {pt.y}</text>}
                  </g>
                );
              })}
            </g>
          ))}
          {show.anchors && groups.map((gr, i) => {
            const a = toScreen(gr.x, gr.y);
            const shared = gr.refs.some((r) => p.pos.anchors.some((o) => o.anchorPos === r.anchorPos && o.gid !== gid));
            return (
              <g key={i} className={`anchor ${gr.kind}`}>
                <path data-anchor={i} d={`M${a.x} ${a.y - 7}L${a.x + 7} ${a.y}L${a.x} ${a.y + 7}L${a.x - 7} ${a.y}Z`} />
                <text x={a.x + 10} y={a.y + 4}>{gr.kind}{gr.kind === 'mark' || gr.kind === 'base' || gr.kind === 'mark2' || gr.kind === 'ligature' ? ` #${gr.cls}` : ''}{shared ? ' ⇄' : ''}</text>
              </g>
            );
          })}
          {marquee && (() => {
            const a = toScreen(marquee.x0, marquee.y0), b = toScreen(marquee.x1, marquee.y1);
            return <rect className="marquee" x={Math.min(a.x, b.x)} y={Math.min(a.y, b.y)} width={Math.abs(b.x - a.x)} height={Math.abs(b.y - a.y)} />;
          })()}
          {shapePreview && (() => {
            const a = toScreen(shapePreview.x0, shapePreview.y0), b = toScreen(shapePreview.x1, shapePreview.y1);
            const x = Math.min(a.x, b.x), y = Math.min(a.y, b.y), w = Math.abs(b.x - a.x), h = Math.abs(b.y - a.y);
            return tool === 'rect' ? <rect className="marquee" x={x} y={y} width={w} height={h} /> : <ellipse className="marquee" cx={x + w / 2} cy={y + h / 2} rx={w / 2} ry={h / 2} />;
          })()}
        </svg>
        <div className="canvas-help muted">
          {tool === 'pen' ? 'Click to add on-curve points, Shift+click for off-curve, click the first point to close, Enter to stop.'
            : tool === 'select' ? 'Drag points (Alt: without handles, Shift: constrain) · double-click an outline to add a point · drag ◆ anchors · arrows nudge · Delete removes · wheel zooms · Space pans'
            : tool === 'hand' ? 'Drag to pan, wheel to zoom.' : 'Drag to draw.'}
        </div>
      </div>
    </div>
  );
}

/** When on-curve points move, their neighbouring off-curve handles move with them. */
function withHandles(g: Glyph, sel: Set<string>): Set<string> {
  const out = new Set(sel);
  for (const key of sel) {
    const [ci, pi] = key.split(':').map(Number);
    const c = g.contours[ci];
    if (!c?.[pi]?.on) continue;
    for (const d of [-1, 1]) {
      const j = (pi + d + c.length) % c.length;
      if (!c[j].on) out.add(`${ci}:${j}`);
    }
  }
  return out;
}

/** Orient a new contour clockwise (outer) or counter-clockwise (inside another contour). */
function orient(c: Point[], others: Point[][]): Point[] {
  const inside = others.filter((o) => pointInPolygon(c[0], o)).length % 2 === 1;
  const clockwise = signedArea(c) < 0;
  return inside === clockwise ? reverseContour(c) : c;
}

function nearestSegment(g: Glyph, f: { x: number; y: number }, tol: number) {
  let best = null as { ci: number; pi: number; t: number; d: number } | null;
  g.contours.forEach((c, ci) => {
    const n = c.length;
    for (let pi = 0; pi < n; pi++) {
      const a = c[pi], b = c[(pi + 1) % n];
      let at: (t: number) => { x: number; y: number };
      if (a.on && b.on) at = (t) => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
      else if (!b.on) {
        const nx = c[(pi + 2) % n];
        const s0 = a.on ? a : { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
        const e0 = nx.on ? nx : { x: (b.x + nx.x) / 2, y: (b.y + nx.y) / 2 };
        at = (t) => { const u = 1 - t; return { x: u * u * s0.x + 2 * u * t * b.x + t * t * e0.x, y: u * u * s0.y + 2 * u * t * b.y + t * t * e0.y }; };
      } else continue;
      for (let k = 1; k < 20; k++) {
        const t = k / 20, q = at(t);
        const d = Math.hypot(q.x - f.x, q.y - f.y);
        if (d < tol && (!best || d < best.d)) best = { ci, pi, t, d };
      }
    }
  });
  return best;
}

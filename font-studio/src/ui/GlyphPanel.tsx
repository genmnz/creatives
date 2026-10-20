import { useState } from 'react';
import { studio, useStudio } from '../store.ts';
import { cloneGlyph, type Glyph } from '../font/glyf.ts';
import {
  transformGlyph, translate, scaleAbout, rotateAbout, skewAbout, emboldenGlyph, roundGlyph, decompose,
  reverseContour, correctDirection, toggleOnCurve, deletePoints, setStartPoint, rectContour, ellipseContour,
  apply, type Matrix,
} from '../font/ops.ts';
import { Num, Row, Section, Text, hex, parseCodepoints } from './common.tsx';

const GDEF_CLASSES: Record<number, string> = { 1: 'base', 2: 'ligature', 3: 'mark', 4: 'component' };

export function GlyphPanel() {
  const s = useStudio();
  const p = s.project!;
  const gid = s.gid;
  const g = p.glyphs[gid];
  const b = p.bounds(gid);
  const adv = p.adv[gid];
  const sel = s.points;
  const [moveAnchors, setMoveAnchors] = useState(true);
  const [origin, setOrigin] = useState<'center' | 'baseline' | 'selection'>('center');
  const [t, setT] = useState({ dx: 0, dy: 0, sx: 100, sy: 100, rot: 0, skew: 0, bx: 20, by: 20 });

  const edit = (label: string, fn: (g: Glyph) => Glyph, extra: { gpos?: boolean } = {}) =>
    studio.commit(label, { glyphs: [gid], ...extra }, (proj) => proj.setGlyph(gid, fn(proj.glyphs[gid])));

  const selected = [...sel].map((k) => { const [ci, pi] = k.split(':').map(Number); return { ci, pi, pt: g.contours[ci]?.[pi] }; }).filter((x) => x.pt);
  const one = selected.length === 1 ? selected[0] : null;

  const pivot = () => {
    if (origin === 'baseline' || !b) return { x: 0, y: 0 };
    if (origin === 'selection' && selected.length) {
      const xs = selected.map((x) => x.pt.x), ys = selected.map((x) => x.pt.y);
      return { x: (Math.min(...xs) + Math.max(...xs)) / 2, y: (Math.min(...ys) + Math.max(...ys)) / 2 };
    }
    return { x: (b.xMin + b.xMax) / 2, y: (b.yMin + b.yMax) / 2 };
  };

  /** Apply a matrix to the selection (or glyph), optionally carrying this glyph's anchors along. */
  const applyMatrix = (label: string, m: Matrix, post: (g: Glyph) => Glyph = (x) => x) => {
    const onlySel = selected.length ? sel : undefined;
    studio.commit(label, { glyphs: [gid], gpos: moveAnchors && !onlySel }, (proj) => {
      proj.setGlyph(gid, post(transformGlyph(proj.glyphs[gid], m, onlySel)));
      if (moveAnchors && !onlySel) moveGlyphAnchors(gid, m);
    });
  };

  const moveGlyphAnchors = (g0: number, m: Matrix) => {
    const done = new Set<number>();
    for (const a of p.pos.byGlyph.get(g0)?.anchors ?? []) {
      if (done.has(a.anchorPos)) continue;
      const v = p.anchorValue(a);
      const n = apply(m, v);
      const before = a.anchorPos;
      p.setAnchor(a, n.x, n.y, true);
      done.add(before); done.add(a.anchorPos);
    }
  };

  const setLsb = (v: number) => {
    if (!b) return;
    const d = v - b.xMin;
    studio.commit('Set left side bearing', { glyphs: [gid], gpos: true }, (proj) => {
      proj.setGlyph(gid, transformGlyph(proj.glyphs[gid], translate(d, 0)));
      proj.setAdvance(gid, proj.adv[gid] + d);
      moveGlyphAnchors(gid, translate(d, 0));
    });
  };

  return (
    <div>
      <Section title="Glyph">
        <Row label="Name"><Text value={p.names[gid]} onCommit={(v) => studio.commit('Rename glyph', { glyphs: [gid] }, (proj) => proj.renameGlyph(gid, v))} mono /></Row>
        <Row label="Characters" hint="Unicode code points that type this glyph, e.g. U+0628 or the character itself">
          <Text mono value={p.unicodesOf(gid).map((c) => `U+${hex(c)}`).join(' ')} placeholder="none (reached through features)"
            onCommit={(v) => studio.commit('Change characters', { glyphs: [gid] }, (proj) => {
              const cps = parseCodepoints(v);
              for (const cp of cps) { const other = proj.cmap.get(cp); if (other !== undefined && other !== gid) throw new Error(`U+${hex(cp)} already belongs to ${proj.names[other]}. Remove it there first.`); }
              proj.setUnicodes(gid, cps);
            })} />
        </Row>
        <Row label="Glyph ID">{gid}{p.gdefClass.has(gid) && <span className="muted"> · GDEF {GDEF_CLASSES[p.gdefClass.get(gid)!] ?? p.gdefClass.get(gid)}</span>}{p.edited.has(gid) && <span className="pill">edited</span>}</Row>
      </Section>

      <Section title="Metrics">
        <Row label="Advance"><Num value={adv} min={0} onCommit={(v) => studio.commit('Set advance', { glyphs: [gid] }, (proj) => proj.setAdvance(gid, v))} /></Row>
        <Row label="Left bearing" hint="Moves the outline (and anchors) and keeps the right bearing"><Num value={b?.xMin ?? 0} disabled={!b} onCommit={setLsb} /></Row>
        <Row label="Right bearing"><Num value={b ? adv - b.xMax : adv} disabled={!b} onCommit={(v) => studio.commit('Set right side bearing', { glyphs: [gid] }, (proj) => proj.setAdvance(gid, (b?.xMax ?? 0) + v))} /></Row>
        {b && <Row label="Bounds"><span className="mono muted">x {b.xMin}…{b.xMax} · y {b.yMin}…{b.yMax}</span></Row>}
        <div className="btns">
          <button disabled={!b} onClick={() => b && setLsb(Math.round((adv - (b.xMax - b.xMin)) / 2))}>Center in advance</button>
        </div>
      </Section>

      {!g.components.length && (
        <Section title={selected.length ? `Selection (${selected.length} point${selected.length > 1 ? 's' : ''})` : 'Points'}>
          {one && <>
            <Row label="X"><Num value={one.pt.x} onCommit={(v) => edit('Move point', (gl) => { const c = cloneGlyph(gl); c.contours[one.ci][one.pi].x = v; return c; })} /></Row>
            <Row label="Y"><Num value={one.pt.y} onCommit={(v) => edit('Move point', (gl) => { const c = cloneGlyph(gl); c.contours[one.ci][one.pi].y = v; return c; })} /></Row>
            <Row label="Type">{one.pt.on ? 'on-curve' : 'off-curve (quadratic control)'} · contour {one.ci} · point {one.pi}</Row>
          </>}
          {!selected.length && <p className="muted">{g.contours.length} contours, {g.contours.reduce((n, c) => n + c.length, 0)} points. Click or drag-select points in the canvas.</p>}
          <div className="btns">
            <button disabled={!selected.length} onClick={() => edit('Toggle on/off-curve', (gl) => toggleOnCurve(gl, sel))}>Toggle on/off-curve</button>
            <button disabled={!one} onClick={() => one && edit('Set start point', (gl) => setStartPoint(gl, one.ci, one.pi))}>Make start point</button>
            <button disabled={!selected.length} onClick={() => { edit('Delete points', (gl) => deletePoints(gl, sel)); studio.points.clear(); }}>Delete points</button>
            <button disabled={!selected.length} onClick={() => {
              const cis = new Set(selected.map((x) => x.ci));
              edit('Delete contours', (gl) => ({ ...cloneGlyph(gl), contours: gl.contours.filter((_, i) => !cis.has(i)) }));
              studio.points.clear();
            }}>Delete contour</button>
            <button disabled={!selected.length} onClick={() => {
              const cis = new Set(selected.map((x) => x.ci));
              edit('Reverse contour', (gl) => ({ ...cloneGlyph(gl), contours: gl.contours.map((c, i) => (cis.has(i) ? reverseContour(c) : c)) }));
              studio.points.clear();
            }}>Reverse contour</button>
          </div>
        </Section>
      )}

      <Section title="Outline">
        <div className="btns">
          <button onClick={() => edit('Correct contour directions', correctDirection)} title="Outer contours clockwise, counters counter-clockwise">Correct directions</button>
          <button onClick={() => edit('Round coordinates', roundGlyph)}>Round to integers</button>
          {g.components.length > 0 && <button onClick={() => edit('Decompose', (gl) => decompose(gl, p.lookup))}>Decompose</button>}
          <button onClick={() => edit('Add rectangle', (gl) => ({ ...decompose(gl, p.lookup), contours: [...decompose(gl, p.lookup).contours, rectContour(Math.round(adv * 0.2), 0, Math.round(adv * 0.8), Math.round(p.os2.sxHeight || p.upm / 2))] }))}>+ Rectangle</button>
          <button onClick={() => edit('Add ellipse', (gl) => ({ ...decompose(gl, p.lookup), contours: [...decompose(gl, p.lookup).contours, ellipseContour(adv / 2, (p.os2.sxHeight || p.upm / 2) / 2, adv * 0.3, (p.os2.sxHeight || p.upm / 2) / 2).map((q) => ({ ...q, x: Math.round(q.x), y: Math.round(q.y) }))] }))}>+ Ellipse</button>
          <button onClick={() => { edit('Clear outline', () => ({ contours: [], components: [], instructions: new Uint8Array(0), overlap: false })); studio.points.clear(); }}>Clear</button>
        </div>
        <label className="check"><input type="checkbox" checked={g.overlap} onChange={(e) => studio.commit('Overlap flag', { glyphs: [gid] }, (proj) => proj.setGlyph(gid, { ...cloneGlyph(proj.glyphs[gid]), overlap: e.target.checked }, { keepInstructions: true }))} />
          Overlapping contours flag (OVERLAP_SIMPLE/COMPOUND)</label>
      </Section>

      <Section title="Transform">
        <Row label="Applies to"><span>{selected.length ? `${selected.length} selected points` : 'whole glyph'}</span></Row>
        <Row label="Origin">
          <select value={origin} onChange={(e) => setOrigin(e.target.value as typeof origin)}>
            <option value="center">glyph center</option><option value="baseline">baseline origin (0,0)</option><option value="selection">selection center</option>
          </select>
        </Row>
        <label className="check"><input type="checkbox" checked={moveAnchors} onChange={(e) => setMoveAnchors(e.target.checked)} /> Move this glyph's anchors too</label>
        <Row label="Move"><Num value={t.dx} onCommit={(v) => setT({ ...t, dx: v })} width={56} /><Num value={t.dy} onCommit={(v) => setT({ ...t, dy: v })} width={56} />
          <button onClick={() => applyMatrix('Move', translate(t.dx, t.dy))}>Apply</button></Row>
        <Row label="Scale %"><Num value={t.sx} onCommit={(v) => setT({ ...t, sx: v })} width={56} /><Num value={t.sy} onCommit={(v) => setT({ ...t, sy: v })} width={56} />
          <button onClick={() => { const o = pivot(); applyMatrix('Scale', scaleAbout(t.sx / 100, t.sy / 100, o.x, o.y)); }}>Apply</button></Row>
        <Row label="Rotate °"><Num value={t.rot} onCommit={(v) => setT({ ...t, rot: v })} width={56} />
          <button onClick={() => { const o = pivot(); applyMatrix('Rotate', rotateAbout(t.rot, o.x, o.y)); }}>Apply</button></Row>
        <Row label="Slant °"><Num value={t.skew} onCommit={(v) => setT({ ...t, skew: v })} width={56} />
          <button onClick={() => { const o = pivot(); applyMatrix('Slant', skewAbout(t.skew, o.x, o.y)); }}>Apply</button></Row>
        <div className="btns">
          <button onClick={() => { const o = pivot(); applyMatrix('Flip horizontal', scaleAbout(-1, 1, o.x, o.y), correctDirection); }}>Flip ↔</button>
          <button onClick={() => { const o = pivot(); applyMatrix('Flip vertical', scaleAbout(1, -1, o.x, o.y), correctDirection); }}>Flip ↕</button>
        </div>
        <Row label="Weight ±" hint="Grows (or with negative values thins) the outline on every side; point structure is kept">
          <Num value={t.bx} onCommit={(v) => setT({ ...t, bx: v })} width={56} /><Num value={t.by} onCommit={(v) => setT({ ...t, by: v })} width={56} />
          <button onClick={() => edit('Change weight', (gl) => roundGlyph(emboldenGlyph(gl, t.bx, t.by, p.lookup)))}>Apply</button>
        </Row>
      </Section>

      {(g.components.length > 0 || g.contours.length === 0) && <ComponentsSection />}
    </div>
  );
}

function ComponentsSection() {
  const s = useStudio();
  const [compName, setCompName] = useState('');
  const p = s.project!;
  const gid = s.gid;
  const g = p.glyphs[gid];
  const editComp = (i: number, fn: (c: Glyph['components'][number]) => void, label = 'Edit component') =>
    studio.commit(label, { glyphs: [gid] }, (proj) => {
      const ng = cloneGlyph(proj.glyphs[gid]);
      fn(ng.components[i]);
      proj.setGlyph(gid, ng);
    });
  return (
    <Section title="Components">
      {!g.components.length && <p className="muted">Empty glyph: build it from other glyphs (a composite), or draw contours in the canvas.</p>}
      {g.components.length > 0 && <table className="table">
        <thead><tr><th>Glyph</th><th>x</th><th>y</th><th>scale x</th><th>scale y</th><th /></tr></thead>
        <tbody>
          {g.components.map((c, i) => (
            <tr key={i}>
              <td><button className="link" onClick={() => studio.selectGlyph(c.gid)}>{p.names[c.gid]}</button></td>
              <td><Num value={c.dx} width={50} onCommit={(v) => editComp(i, (cc) => { cc.dx = v; })} /></td>
              <td><Num value={c.dy} width={50} onCommit={(v) => editComp(i, (cc) => { cc.dy = v; })} /></td>
              <td><Num value={Math.round(c.m[0] * 1000) / 10} width={50} onCommit={(v) => editComp(i, (cc) => { cc.m = [v / 100, cc.m[1], cc.m[2], cc.m[3]]; })} /></td>
              <td><Num value={Math.round(c.m[3] * 1000) / 10} width={50} onCommit={(v) => editComp(i, (cc) => { cc.m = [cc.m[0], cc.m[1], cc.m[2], v / 100]; })} /></td>
              <td><button title="Remove component" onClick={() => studio.commit('Remove component', { glyphs: [gid] }, (proj) => {
                const ng = cloneGlyph(proj.glyphs[gid]); ng.components.splice(i, 1); proj.setGlyph(gid, ng);
              })}>✕</button></td>
            </tr>
          ))}
        </tbody>
      </table>}
      <div className="btns">
        <input id="component-name" className="mono" placeholder="glyph name or character" value={compName} onChange={(e) => setCompName(e.target.value)} style={{ width: 160 }} />
        <button disabled={!compName.trim()} onClick={() => {
          const q = compName.trim();
          let cg = p.glyphByName(q);
          if (cg < 0) { const cp = parseCodepoints(q)[0]; if (cp !== undefined) cg = p.cmap.get(cp) ?? -1; }
          if (cg < 0) { studio.toast(`No glyph named ${q}.`, 'error'); return; }
          if (cg === gid || p.dependents(gid).includes(cg)) { studio.toast('A glyph cannot contain itself.', 'error'); return; }
          studio.commit('Add component', { glyphs: [gid] }, (proj) => {
            const ng = cloneGlyph(proj.glyphs[gid]);
            ng.components.push({ gid: cg, dx: 0, dy: 0, m: [1, 0, 0, 1], flags: 0 });
            proj.setGlyph(gid, ng);
          });
          setCompName('');
        }}>+ Component</button>
      </div>
    </Section>
  );
}

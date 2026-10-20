import { useState } from 'react';
import { studio, useStudio } from '../store.ts';
import type { FontProject } from '../font/font.ts';
import { cloneGlyph, type Glyph } from '../font/glyf.ts';
import {
  transformGlyph, scaleAbout, translate, emboldenGlyph, roundGlyph, decompose, correctDirection, apply, type Matrix,
} from '../font/ops.ts';
import { Num, Row, Section } from './common.tsx';

type Target = 'selected' | 'all' | 'pattern';

export function BatchPanel() {
  const s = useStudio();
  const p = s.project!;
  const [target, setTarget] = useState<Target>(s.multi.size ? 'selected' : 'all');
  const [pattern, setPattern] = useState('');
  const [o, setO] = useState({ sx: 100, sy: 100, dx: 0, dy: 0, bx: 20, by: 20, adv: 0, lsb: 0, rsb: 0 });
  const [carry, setCarry] = useState(true);

  const targets = (): number[] => {
    if (target === 'selected') return [...s.multi].sort((a, b) => a - b);
    if (target === 'all') return [...Array(p.numGlyphs).keys()];
    try { const re = new RegExp(pattern, 'i'); return [...Array(p.numGlyphs).keys()].filter((g) => re.test(p.names[g])); }
    catch { return []; }
  };
  const ids = targets();

  const run = (label: string, perGlyph: (p: FontProject, g: number, set: Set<number>) => void, gpos = false) => {
    if (!ids.length) { studio.toast('No glyphs targeted.', 'error'); return; }
    const set = new Set(ids);
    studio.commit(`${label} (${ids.length} glyphs)`, { glyphs: ids, gpos }, (proj) => { for (const g of ids) perGlyph(proj, g, set); });
    studio.toast(`${label}: ${ids.length} glyphs`, 'ok');
  };

  /** Transform a glyph; components whose base glyphs are also transformed only get their offsets moved. */
  const transformOne = (proj: FontProject, g: number, m: Matrix, set: Set<number>) => {
    const gl = proj.glyphs[g];
    let out: Glyph;
    if (gl.components.length) {
      out = cloneGlyph(gl);
      out.components = out.components.map((c) => {
        if (set.has(c.gid) && !c.match) { const o2 = apply(m, { x: c.dx, y: c.dy }); return { ...c, dx: Math.round(o2.x), dy: Math.round(o2.y) }; }
        return transformGlyph({ ...gl, components: [c], contours: [] }, m).components[0];
      });
    } else out = roundGlyph(transformGlyph(gl, m));
    proj.setGlyph(g, out);
  };

  const carryAnchors = (proj: FontProject, g: number, m: Matrix, done: Set<number>) => {
    for (const a of proj.pos.byGlyph.get(g)?.anchors ?? []) {
      if (done.has(a.anchorPos)) continue;
      const v = proj.anchorValue(a), n = apply(m, v);
      // a table shared only within the batch moves once, in place
      const sharers = proj.pos.anchors.filter((b) => b.anchorPos === a.anchorPos);
      const inside = sharers.every((b) => ids.includes(b.gid));
      const before = a.anchorPos;
      proj.setAnchor(a, n.x, n.y, !inside);
      done.add(before); done.add(a.anchorPos);
    }
  };

  return (
    <div>
      <Section title="Target">
        <label className="check"><input type="radio" checked={target === 'selected'} onChange={() => setTarget('selected')} /> Glyphs selected in the grid ({s.multi.size}) <span className="muted small">Ctrl/Shift+click cells</span></label>
        <label className="check"><input type="radio" checked={target === 'all'} onChange={() => setTarget('all')} /> All glyphs ({p.numGlyphs})</label>
        <label className="check"><input type="radio" checked={target === 'pattern'} onChange={() => setTarget('pattern')} /> Names matching
          <input className="mono" value={pattern} placeholder="e.g. \.fina$ or ^uni06" onChange={(e) => { setPattern(e.target.value); setTarget('pattern'); }} style={{ width: 150, marginLeft: 6 }} />
          {target === 'pattern' && <span className="muted"> ({ids.length})</span>}</label>
        <div className="btns">
          <button onClick={() => { s.multi = new Set(ids); studio.notify(); }}>Select these in the grid</button>
          <button onClick={() => { s.multi.clear(); studio.notify(); }}>Clear grid selection</button>
        </div>
      </Section>

      <Section title="Shape">
        <label className="check"><input type="checkbox" checked={carry} onChange={(e) => setCarry(e.target.checked)} /> Carry anchors, advances and kerning along with scale/move</label>
        <Row label="Scale %" hint="About the baseline origin (0,0); advance widths scale with x">
          <Num value={o.sx} width={56} onCommit={(v) => setO({ ...o, sx: v })} /><Num value={o.sy} width={56} onCommit={(v) => setO({ ...o, sy: v })} />
          <button onClick={() => {
            const m = scaleAbout(o.sx / 100, o.sy / 100);
            const done = new Set<number>();
            run('Scale', (proj, g, set) => {
              transformOne(proj, g, m, set);
              if (carry) { proj.adv[g] = Math.round(proj.adv[g] * o.sx / 100); carryAnchors(proj, g, m, done); }
            }, carry);
            if (carry && o.sx !== 100) scaleKerning(ids, o.sx / 100);
          }}>Apply</button>
        </Row>
        <Row label="Move">
          <Num value={o.dx} width={56} onCommit={(v) => setO({ ...o, dx: v })} /><Num value={o.dy} width={56} onCommit={(v) => setO({ ...o, dy: v })} />
          <button onClick={() => { const m = translate(o.dx, o.dy); const done = new Set<number>(); run('Move', (proj, g, set) => { transformOne(proj, g, m, set); if (carry) carryAnchors(proj, g, m, done); }, carry); }}>Apply</button>
        </Row>
        <Row label="Weight ±" hint="Point-preserving outline offset per side; composites are decomposed first">
          <Num value={o.bx} width={56} onCommit={(v) => setO({ ...o, bx: v })} /><Num value={o.by} width={56} onCommit={(v) => setO({ ...o, by: v })} />
          <button onClick={() => run('Change weight', (proj, g) => {
            const gl = proj.glyphs[g];
            if (!gl.contours.length && !gl.components.length) return;
            proj.setGlyph(g, roundGlyph(emboldenGlyph(gl, o.bx, o.by, proj.lookup)));
          })}>Apply</button>
        </Row>
      </Section>

      <Section title="Spacing">
        <Row label="Advance +"><Num value={o.adv} width={56} onCommit={(v) => setO({ ...o, adv: v })} />
          <button onClick={() => run('Adjust advance', (proj, g) => { if (proj.adv[g] > 0) proj.setAdvance(g, proj.adv[g] + o.adv); })}>Apply</button></Row>
        <Row label="Left bearing +" hint="Shifts outlines and anchors right and widens the advance">
          <Num value={o.lsb} width={56} onCommit={(v) => setO({ ...o, lsb: v })} />
          <button onClick={() => { const m = translate(o.lsb, 0); const done = new Set<number>(); run('Adjust left bearing', (proj, g, set) => {
            if (proj.adv[g] <= 0) return;
            transformOne(proj, g, m, set); proj.setAdvance(g, proj.adv[g] + o.lsb); carryAnchors(proj, g, m, done);
          }, true); }}>Apply</button></Row>
        <Row label="Right bearing +"><Num value={o.rsb} width={56} onCommit={(v) => setO({ ...o, rsb: v })} />
          <button onClick={() => run('Adjust right bearing', (proj, g) => { if (proj.adv[g] > 0) proj.setAdvance(g, proj.adv[g] + o.rsb); })}>Apply</button></Row>
      </Section>

      <Section title="Clean-up">
        <div className="btns">
          <button onClick={() => run('Round coordinates', (proj, g) => proj.setGlyph(g, roundGlyph(proj.glyphs[g]), { keepInstructions: true }))}>Round coordinates</button>
          <button onClick={() => run('Decompose', (proj, g) => { if (proj.glyphs[g].components.length) proj.setGlyph(g, decompose(proj.glyphs[g], proj.lookup)); })}>Decompose composites</button>
          <button onClick={() => run('Correct directions', (proj, g) => { if (proj.glyphs[g].contours.length) proj.setGlyph(g, correctDirection(proj.glyphs[g])); })}>Correct contour directions</button>
          <button onClick={() => run('Remove glyph hinting', (proj, g) => { if (proj.glyphs[g].instructions.length) proj.setGlyph(g, proj.glyphs[g]); })}>Remove glyph instructions</button>
          <button onClick={() => run('Clear overlap flags', (proj, g) => { if (proj.glyphs[g].overlap) proj.setGlyph(g, { ...cloneGlyph(proj.glyphs[g]), overlap: false }, { keepInstructions: true }); })}>Clear overlap flags</button>
        </div>
      </Section>
    </div>
  );
}

/** Scale pair kerning and x-adjustments that involve the targeted glyphs (one undo step). */
function scaleKerning(ids: number[], k: number) {
  const set = new Set(ids);
  studio.commit('Scale kerning', { gpos: true }, (proj) => {
    const done = new Set<number>();
    for (const v of proj.pos.values) {
      if (!set.has(v.gid) && !(v.gid2 !== undefined && set.has(v.gid2))) continue;
      for (const f of ['XPlacement', 'XAdvance'] as const) {
        const pos = v.fields[f];
        if (pos === undefined || done.has(pos)) continue;
        done.add(pos);
        proj.setValue(v, f, proj.valueOf(v, f) * k);
      }
    }
  });
}

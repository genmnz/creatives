import { useMemo, useState } from 'react';
import { studio, useStudio } from '../store.ts';
import type { ValueRef } from '../font/otl.ts';
import { anchorGroups } from './Editor.tsx';
import { GlyphThumb, Num, Section } from './common.tsx';

const FIELDS: (keyof ValueRef['fields'])[] = ['XPlacement', 'YPlacement', 'XAdvance', 'YAdvance'];
const SHORT: Record<string, string> = { XPlacement: 'x', YPlacement: 'y', XAdvance: 'adv', YAdvance: 'v.adv' };
const KIND_HELP: Record<string, string> = {
  mark: 'where this mark attaches', base: 'where marks attach to this letter', ligature: 'mark attachment on a ligature component',
  mark2: 'where marks stack on this mark', entry: 'cursive entry', exit: 'cursive exit',
};

export function PositioningPanel() {
  const s = useStudio();
  const p = s.project!;
  const gid = s.gid;
  const [filter, setFilter] = useState('');
  const data = p.pos.byGlyph.get(gid);
  const groups = useMemo(() => anchorGroups(data?.anchors ?? [], (a) => p.anchorValue(a)), [data, p.version, s.tick]);

  if (!p.gpos) return <p className="muted">This font has no GPOS table: no anchors or OpenType kerning to edit.</p>;

  const moveGroup = (i: number, x: number, y: number) => studio.commit('Move anchor', { gpos: true }, (proj) => {
    for (const r of groups[i].refs) proj.setAnchor(r, x, y, true);
  });

  const values = (data?.values ?? []).filter((v) => {
    if (!filter) return true;
    const partner = v.gid2 !== undefined ? p.names[v.gid === gid ? v.gid2 : v.gid] : '';
    return partner.toLowerCase().includes(filter.toLowerCase()) || String(v.lookup) === filter;
  });

  return (
    <div>
      <Section title={`Anchors (${groups.length})`}>
        {!groups.length && <p className="muted">No mark or cursive anchors for this glyph.</p>}
        <table className="table">
          <tbody>
            {groups.map((g, i) => {
              const others = new Set(g.refs.flatMap((r) => p.pos.anchors.filter((o) => o.anchorPos === r.anchorPos && o.gid !== gid).map((o) => o.gid)));
              return (
                <tr key={i}>
                  <td title={KIND_HELP[g.kind]}><b>{g.kind}</b>{['mark', 'base', 'mark2', 'ligature'].includes(g.kind) && ` #${g.cls}`}{g.refs[0].component !== undefined && ` comp ${g.refs[0].component}`}
                    <div className="tiny muted">lookup {[...new Set(g.refs.map((r) => r.lookup))].join(', ')}</div></td>
                  <td>x <Num value={g.x} width={56} onCommit={(v) => moveGroup(i, v, g.y)} /></td>
                  <td>y <Num value={g.y} width={56} onCommit={(v) => moveGroup(i, g.x, v)} /></td>
                  <td className="tiny muted">{others.size ? `shared with ${others.size} glyph${others.size > 1 ? 's' : ''}; edits here split it off` : 'own'}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
        <p className="muted small">You can also drag the ◆ anchors in the canvas. Edits apply only to this glyph: an anchor shared with other glyphs gets its own copy.</p>
      </Section>

      <Section title={`Kerning & adjustments (${data?.values.length ?? 0})`} right={<input placeholder="filter partner / lookup" value={filter} onChange={(e) => setFilter(e.target.value)} style={{ width: 150 }} />}>
        {!values.length && <p className="muted">No positioning values involve this glyph.</p>}
        <table className="table">
          <tbody>
            {values.slice(0, 300).map((v, i) => {
              const partner = v.kind === 'pair' ? (v.gid === gid ? v.gid2! : v.gid) : undefined;
              const desc = v.kind === 'single' ? 'adjustment' : v.kind === 'pair' ? (v.gid === gid ? 'pair → next' : 'pair ← previous') : `class kern ${v.class1}×${v.class2}`;
              return (
                <tr key={i}>
                  <td>
                    <div>{desc}{v.second ? ' (2nd glyph)' : ''}</div>
                    <div className="tiny muted">lookup {v.lookup}{v.sharedBy > 1 ? ` · applies to ${v.sharedBy} ${v.kind === 'single' ? 'glyphs' : 'pairs'}` : ''}</div>
                  </td>
                  <td>
                    {partner !== undefined && <GlyphThumb p={p} gid={partner} size={30} onClick={() => studio.selectGlyph(partner)} />}
                    {v.kind === 'pairClass' && <span className="tiny muted">{(v.class2Glyphs ?? []).slice(0, 4).map((g) => p.names[g]).join(' ') || 'all other glyphs'}{(v.class2Glyphs?.length ?? 0) > 4 ? ' …' : ''}</span>}
                  </td>
                  <td className="vals">
                    {FIELDS.filter((f) => v.fields[f] !== undefined).map((f) => (
                      <span key={f} className="val">{SHORT[f]} <Num value={p.valueOf(v, f)} width={52}
                        onCommit={(n) => studio.commit(`Edit ${f}`, { gpos: true }, (proj) => proj.setValue(v, f, n))} /></span>
                    ))}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        {values.length > 300 && <p className="muted">Showing 300 of {values.length}; use the filter.</p>}
      </Section>
    </div>
  );
}

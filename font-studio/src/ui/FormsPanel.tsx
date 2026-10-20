import { useMemo, useState } from 'react';
import { studio, useStudio } from '../store.ts';
import { formsOf, type Subst } from '../font/otl.ts';
import { joiningForms } from '../shaping.ts';
import { GlyphThumb, Section, hex } from './common.tsx';
import type { FontProject } from '../font/font.ts';

const TYPE_NAMES: Record<number, string> = { 1: 'single', 2: 'multiple', 3: 'alternate', 4: 'ligature', 8: 'reverse chaining' };

/** Walk substitutions backwards to the glyph(s) a character maps to. */
function roots(p: FontProject, gid: number): number[] {
  if (p.unicodesOf(gid).length) return [gid];
  const seen = new Set([gid]);
  let frontier = [gid];
  const found = new Set<number>();
  for (let depth = 0; depth < 8 && frontier.length && !found.size; depth++) {
    const next: number[] = [];
    for (const g of frontier) for (const s of p.gsub.in.get(g) ?? []) for (const f of s.from) {
      if (seen.has(f)) continue;
      seen.add(f);
      if (p.unicodesOf(f).length) found.add(f); else next.push(f);
    }
    frontier = next;
  }
  return [...found];
}

export function FormsPanel() {
  const s = useStudio();
  const p = s.project!;
  const gid = s.gid;
  const [ctx, setCtx] = useState('ـ{}ـ');
  const rootGlyphs = useMemo(() => roots(p, gid), [p, gid, p.version]);
  const chars = [...new Set(rootGlyphs.flatMap((g) => p.unicodesOf(g)))];
  const ch = chars.length ? String.fromCodePoint(chars[0]) : '';

  const joining = useMemo(() => (s.shaper && ch ? joiningForms(s.shaper, ch) : []), [s.shaper, ch]);
  const custom = useMemo(() => {
    if (!s.shaper || !ch || !ctx.includes('{}')) return [];
    return s.shaper.shape(ctx.replace('{}', ch));
  }, [s.shaper, ch, ctx]);

  const family = useMemo(() => {
    const all = new Map<number, Set<string>>();
    for (const r of rootGlyphs) for (const [g, tags] of formsOf(p.gsub, r)) {
      if (!all.has(g)) all.set(g, new Set());
      tags.forEach((t) => all.get(g)!.add(t));
    }
    return all;
  }, [p, rootGlyphs, p.version]);

  const into = p.gsub.out.get(gid) ?? [];
  const from = p.gsub.in.get(gid) ?? [];

  return (
    <div>
      <Section title="Typed as">
        {p.unicodesOf(gid).length
          ? <p>{p.unicodesOf(gid).map((c) => <span key={c} className="chip">{String.fromCodePoint(c)} U+{hex(c)}</span>)}</p>
          : <p className="muted">Not typed directly. {rootGlyphs.length ? <>It is a form of {rootGlyphs.map((r) => <button key={r} className="link" onClick={() => studio.selectGlyph(r)}>{p.names[r]}</button>)}.</> : 'No character reaches it through substitutions (it may be used only as a component, or be unused).'}</p>}
      </Section>

      {ch && (
        <Section title={`In text: ${ch}`}>
          {!s.shaper && <p className="muted">{s.shapingError || 'Shaping engine loading…'}</p>}
          <div className="forms-row">
            {joining.map((j) => (
              <div key={j.label} className="form-cell">
                {j.gid !== null ? <GlyphThumb p={p} gid={j.gid} size={56} active={j.gid === gid} onClick={() => studio.selectGlyph(j.gid!)} /> : <span className="muted">—</span>}
                <span className="muted">{j.label}</span>
                <span className="tiny">{j.gid !== null ? p.names[j.gid] : ''}</span>
              </div>
            ))}
          </div>
          <div className="row">
            <label title="{} is replaced by the character; ـ is the tatweel (joins on both sides)">Context</label>
            <input className="mono" value={ctx} onChange={(e) => setCtx(e.target.value)} style={{ width: 140 }} />
          </div>
          <div className="forms-row wrap">
            {custom.map((g, i) => (
              <GlyphThumb key={i} p={p} gid={g.gid} size={44} active={g.gid === gid} onClick={() => studio.selectGlyph(g.gid)} label={p.names[g.gid]} />
            ))}
          </div>
          <p className="muted small">Shaped by HarfBuzz on the live font, exactly as browsers do. Try contexts like <code>ل{'{}'}</code>, <code>{'{}'}ا</code> or a whole word.</p>
        </Section>
      )}

      {family.size > 1 && (
        <Section title={`All forms (${family.size})`}>
          <div className="forms-row wrap">
            {[...family].map(([g, tags]) => (
              <GlyphThumb key={g} p={p} gid={g} size={52} active={g === gid} onClick={() => studio.selectGlyph(g)}
                label={[...tags].filter((t) => t !== 'base').join(' ') || 'character'} title={p.names[g]} />
            ))}
          </div>
        </Section>
      )}

      <Section title={`Produced from (${from.length})`}>
        {from.length ? <SubstList p={p} list={from} side="from" /> : <p className="muted">No substitution produces this glyph.</p>}
      </Section>
      <Section title={`Turns into (${into.length})`}>
        {into.length ? <SubstList p={p} list={into} side="to" /> : <p className="muted">No substitution starts from this glyph.</p>}
      </Section>
      <p className="muted small">Substitution rules (GSUB) are kept exactly as in the original font. Edit any glyph above to change that form.</p>
    </div>
  );
}

function SubstList({ p, list, side }: { p: FontProject; list: Subst[]; side: 'from' | 'to' }) {
  return (
    <ul className="subst-list">
      {list.slice(0, 80).map((s, i) => (
        <li key={i}>
          <span className="tags">{s.tags.join(' ') || `lookup ${s.lookup}`}</span>
          <span className="muted"> {TYPE_NAMES[s.type] ?? s.type} · lookup {s.lookup}</span>
          <div className="forms-row wrap">
            {(side === 'from' ? s.from : s.to).map((g, k) => (
              <GlyphThumb key={k} p={p} gid={g} size={36} onClick={() => studio.selectGlyph(g)} title={p.names[g]} />
            ))}
            {side === 'from' && s.type === 4 && <span className="muted"> → ligature</span>}
          </div>
        </li>
      ))}
      {list.length > 80 && <li className="muted">… {list.length - 80} more</li>}
    </ul>
  );
}

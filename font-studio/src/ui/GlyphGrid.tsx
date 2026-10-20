import { useEffect, useMemo, useRef, useState } from 'react';
import { studio, useStudio } from '../store.ts';
import { formsOf } from '../font/otl.ts';
import { GlyphThumb, hex, parseCodepoints } from './common.tsx';
import type { FontProject } from '../font/font.ts';

type Filter = 'all' | 'mapped' | 'arabic' | 'latin' | 'marks' | 'composite' | 'edited' | 'unmapped';
const FILTERS: [Filter, string][] = [
  ['all', 'All glyphs'], ['mapped', 'Characters'], ['arabic', 'Arabic + all its forms'], ['latin', 'Latin'],
  ['marks', 'Marks'], ['composite', 'Composites'], ['edited', 'Edited'], ['unmapped', 'Unmapped (forms, ligatures, alternates)'],
];
const CELL = 68;

const isArabic = (c: number) => (c >= 0x600 && c <= 0x6ff) || (c >= 0x750 && c <= 0x77f) || (c >= 0x8a0 && c <= 0x8ff) || (c >= 0xfb50 && c <= 0xfdff) || (c >= 0xfe70 && c <= 0xfeff);
const isLatin = (c: number) => c < 0x250 || (c >= 0x1e00 && c <= 0x1eff);

function filtered(p: FontProject, f: Filter, q: string): number[] {
  let ids = [...Array(p.numGlyphs).keys()];
  if (f === 'mapped') ids = ids.filter((g) => p.unicodesOf(g).length);
  else if (f === 'unmapped') ids = ids.filter((g) => !p.unicodesOf(g).length);
  else if (f === 'marks') ids = ids.filter((g) => p.gdefClass.get(g) === 3);
  else if (f === 'composite') ids = ids.filter((g) => p.glyphs[g].components.length);
  else if (f === 'edited') ids = ids.filter((g) => p.edited.has(g));
  else if (f === 'latin') ids = ids.filter((g) => p.unicodesOf(g).some(isLatin));
  else if (f === 'arabic') {
    const set = new Set<number>();
    for (const [cp, g] of p.cmap) if (isArabic(cp)) for (const fg of formsOf(p.gsub, g).keys()) set.add(fg);
    ids = [...set].sort((a, b) => a - b);
  }
  q = q.trim();
  if (q) {
    const cps = new Set(parseCodepoints(q));
    const ql = q.toLowerCase();
    ids = ids.filter((g) => p.names[g].toLowerCase().includes(ql) || p.unicodesOf(g).some((c) => cps.has(c)) || String(g) === q);
  }
  return ids;
}

export function GlyphGrid() {
  const s = useStudio();
  const p = s.project!;
  const [filter, setFilter] = useState<Filter>('all');
  const [query, setQuery] = useState('');
  const [scroll, setScroll] = useState(0);
  const [size, setSize] = useState({ w: 300, h: 600 });
  const box = useRef<HTMLDivElement>(null);
  const ids = useMemo(() => filtered(p, filter, query), [p, filter, query, p.numGlyphs, filter === 'edited' ? p.version : 0]);

  useEffect(() => {
    const el = box.current!;
    const ro = new ResizeObserver(() => setSize({ w: el.clientWidth, h: el.clientHeight }));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // keep the current glyph visible when it changes from elsewhere
  useEffect(() => {
    const i = ids.indexOf(s.gid);
    const el = box.current;
    if (i < 0 || !el) return;
    const cols = Math.max(1, Math.floor(size.w / CELL));
    const top = Math.floor(i / cols) * CELL;
    if (top < el.scrollTop || top > el.scrollTop + el.clientHeight - CELL) el.scrollTop = top - el.clientHeight / 2;
  }, [s.gid]);

  const cols = Math.max(1, Math.floor(size.w / CELL));
  const rows = Math.ceil(ids.length / cols);
  const first = Math.max(0, Math.floor(scroll / CELL) - 2);
  const last = Math.min(rows, Math.ceil((scroll + size.h) / CELL) + 2);
  const visible = ids.slice(first * cols, last * cols);

  const click = (g: number, e: React.MouseEvent) => {
    if (e.shiftKey && s.multi.size) {
      const a = ids.indexOf([...s.multi].pop()!), b = ids.indexOf(g);
      for (let i = Math.min(a, b); i <= Math.max(a, b); i++) s.multi.add(ids[i]);
    } else if (e.metaKey || e.ctrlKey || e.shiftKey) {
      s.multi.has(g) ? s.multi.delete(g) : s.multi.add(g);
    } else {
      s.multi.clear();
    }
    studio.selectGlyph(g);
  };

  const [adding, setAdding] = useState(false);
  const [newName, setNewName] = useState('');
  const [newChars, setNewChars] = useState('');
  const addGlyph = () => {
    const name = newName.trim();
    if (!name) return;
    const cps = parseCodepoints(newChars);
    for (const cp of cps) if (p.cmap.has(cp)) { studio.toast(`That character already belongs to ${p.names[p.cmap.get(cp)!]}.`, 'error'); return; }
    let gid = -1;
    studio.commit(`Add glyph ${name}`, { glyphs: [] }, (proj) => {
      gid = proj.addGlyph(name, { unicode: cps[0] });
      if (cps.length > 1) proj.setUnicodes(gid, cps);
    });
    if (gid >= 0) { studio.selectGlyph(gid); setAdding(false); setNewName(''); setNewChars(''); }
  };

  const duplicate = () => {
    let gid = -1;
    studio.commit(`Duplicate ${p.names[s.gid]}`, { glyphs: [] }, (proj) => { gid = proj.addGlyph(`${proj.names[s.gid]}.alt`, { from: s.gid }); });
    if (gid >= 0) studio.selectGlyph(gid);
  };

  return (
    <aside className="grid-panel">
      <div className="grid-tools">
        <input placeholder="Search: ب, U+0628, uni0628, name…" value={query} onChange={(e) => setQuery(e.target.value)} />
        <select value={filter} onChange={(e) => setFilter(e.target.value as Filter)}>
          {FILTERS.map(([id, l]) => <option key={id} value={id}>{l}</option>)}
        </select>
        <div className="grid-actions">
          <span className="muted">{ids.length} shown{s.multi.size ? ` · ${s.multi.size} selected` : ''}</span>
          <button onClick={() => setAdding(!adding)} title="Add a new empty glyph" className={adding ? 'on' : ''}>+ Glyph</button>
          <button onClick={duplicate} title="Copy the current glyph into a new glyph">Duplicate</button>
        </div>
        {adding && (
          <form className="inline-form" onSubmit={(e) => { e.preventDefault(); addGlyph(); }}>
            <input id="new-glyph-name" autoFocus placeholder="Glyph name, e.g. A, uni0628.alt" value={newName} onChange={(e) => setNewName(e.target.value)} />
            <input id="new-glyph-chars" placeholder="Typed with (optional): A or U+0628" value={newChars} onChange={(e) => setNewChars(e.target.value)} />
            <div className="inline-form-actions">
              <button type="button" onClick={() => setAdding(false)}>Cancel</button>
              <button type="submit" className="primary" disabled={!newName.trim()}>Add glyph</button>
            </div>
          </form>
        )}
      </div>
      <div className="grid-scroll" ref={box} onScroll={(e) => setScroll((e.target as HTMLDivElement).scrollTop)}>
        <div style={{ height: rows * CELL, position: 'relative' }}>
          {visible.map((g, i) => {
            const idx = first * cols + i;
            const cp = p.unicodesOf(g)[0];
            return (
              <div key={g} className={`cell${g === s.gid ? ' current' : ''}${s.multi.has(g) ? ' multi' : ''}${p.edited.has(g) ? ' edited' : ''}`}
                style={{ left: (idx % cols) * CELL, top: Math.floor(idx / cols) * CELL, width: CELL, height: CELL }}
                onClick={(e) => click(g, e)}
                title={`${p.names[g]} · GID ${g}${cp !== undefined ? ` · U+${hex(cp)}` : ''}`}>
                <GlyphThumb p={p} gid={g} size={44} />
                <span className="cell-label">{cp !== undefined && cp > 0x20 ? String.fromCodePoint(cp) : p.names[g]}</span>
              </div>
            );
          })}
        </div>
      </div>
    </aside>
  );
}

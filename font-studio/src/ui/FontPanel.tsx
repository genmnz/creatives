import { useState } from 'react';
import { studio, useStudio } from '../store.ts';
import { NAME_IDS } from '../font/tables.ts';
import { Num, Row, Section, Text } from './common.tsx';
import type { FontProject } from '../font/font.ts';

const FS_SELECTION: [number, string][] = [
  [0, 'Italic'], [5, 'Bold'], [6, 'Regular'], [7, 'Use typo metrics'], [8, 'WWS'], [9, 'Oblique'],
  [1, 'Underscore'], [2, 'Negative'], [3, 'Outlined'], [4, 'Strikeout'],
];
const FS_TYPE: [number, string][] = [[0, 'Installable (no restrictions)'], [2, 'Restricted license'], [4, 'Preview & print'], [8, 'Editable']];
const WEIGHTS = [100, 200, 300, 400, 500, 600, 700, 800, 900];

function set(label: string, fn: (p: FontProject) => void) {
  studio.commit(label, { info: true }, (p) => { fn(p); p.version++; });
}

export function FontPanel() {
  const s = useStudio();
  const p = s.project!;
  const [newId, setNewId] = useState(10);
  const ids = [...new Set([...p.nameRecords.map((r) => r.nameID), 1, 2, 3, 4, 5, 6])].sort((a, b) => a - b);
  const metric = (obj: 'hhea' | 'os2' | 'post' | 'head', key: string, label: string, hint?: string) => (
    <Row label={label} hint={hint}>
      <Num value={(p as any)[obj][key] ?? 0} onCommit={(v) => set(`Set ${label}`, (pp) => { (pp as any)[obj][key] = v; })} />
    </Row>
  );
  return (
    <div>
      <Section title="Names">
        {ids.map((id) => (
          <Row key={id} label={<span title={`nameID ${id}`}>{NAME_IDS[id] ?? `Name ${id}`}</span>}>
            <Text value={p.getName(id)} width="100%" onCommit={(v) => set(`Set ${NAME_IDS[id] ?? 'name ' + id}`, (pp) => pp.setName(id, v))} />
          </Row>
        ))}
        <div className="row">
          <select value={newId} onChange={(e) => setNewId(Number(e.target.value))}>
            {Object.entries(NAME_IDS).filter(([k]) => !ids.includes(Number(k))).map(([k, v]) => <option key={k} value={k}>{k} · {v}</option>)}
          </select>
          <button onClick={() => set('Add name', (pp) => pp.setName(newId, NAME_IDS[newId] ?? ''))}>Add name</button>
        </div>
        <p className="muted small">Edits the Windows (English) record and keeps matching Mac/Unicode records in sync. Clearing a field removes it.</p>
      </Section>

      <Section title="Vertical metrics (line box)">
        <Row label="Units per em">{p.upm}</Row>
        {metric('hhea', 'ascender', 'hhea ascender', 'Line box top used by Mac and by browsers')}
        {metric('hhea', 'descender', 'hhea descender')}
        {metric('hhea', 'lineGap', 'hhea line gap')}
        {metric('os2', 'sTypoAscender', 'Typo ascender', 'Used by browsers on Windows when "Use typo metrics" is on')}
        {metric('os2', 'sTypoDescender', 'Typo descender')}
        {metric('os2', 'sTypoLineGap', 'Typo line gap')}
        {metric('os2', 'usWinAscent', 'Win ascent', 'Clipping box on Windows: keep at or above the tallest glyph')}
        {metric('os2', 'usWinDescent', 'Win descent', 'Positive number: depth below baseline')}
        {metric('os2', 'sxHeight', 'x-height')}
        {metric('os2', 'sCapHeight', 'Cap height')}
        <div className="btns">
          <button onClick={() => set('Fit win metrics to glyphs', (pp) => {
            let hi = 0, lo = 0;
            for (let g = 0; g < pp.numGlyphs; g++) { const b = pp.bounds(g); if (b) { hi = Math.max(hi, b.yMax); lo = Math.min(lo, b.yMin); } }
            pp.os2.usWinAscent = hi; pp.os2.usWinDescent = -lo;
          })}>Fit win metrics to tallest/deepest glyph</button>
          <button onClick={() => set('Copy hhea to typo', (pp) => {
            pp.os2.sTypoAscender = pp.hhea.ascender; pp.os2.sTypoDescender = pp.hhea.descender; pp.os2.sTypoLineGap = pp.hhea.lineGap;
          })}>Typo = hhea</button>
        </div>
      </Section>

      <Section title="Style & classification (OS/2)">
        <Row label="Weight class">
          <select value={p.os2.usWeightClass} onChange={(e) => set('Set weight class', (pp) => { pp.os2.usWeightClass = Number(e.target.value); })}>
            {[...new Set([...WEIGHTS, p.os2.usWeightClass])].sort((a, b) => a - b).map((w) => <option key={w} value={w}>{w}</option>)}
          </select>
        </Row>
        <Row label="Width class">
          <select value={p.os2.usWidthClass} onChange={(e) => set('Set width class', (pp) => { pp.os2.usWidthClass = Number(e.target.value); })}>
            {['', 'Ultra-condensed', 'Extra-condensed', 'Condensed', 'Semi-condensed', 'Normal', 'Semi-expanded', 'Expanded', 'Extra-expanded', 'Ultra-expanded'].map((n, i) => i ? <option key={i} value={i}>{i} · {n}</option> : null)}
          </select>
        </Row>
        <Row label="Embedding">
          <select value={p.os2.fsType & 0xe} onChange={(e) => set('Set embedding', (pp) => { pp.os2.fsType = Number(e.target.value); })}>
            {FS_TYPE.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
          </select>
        </Row>
        <Row label="Vendor ID"><Text value={p.os2.achVendID ?? ''} width={70} onCommit={(v) => set('Set vendor', (pp) => { pp.os2.achVendID = v.slice(0, 4).padEnd(4, ' '); })} mono /></Row>
        <div className="checks-grid">
          {FS_SELECTION.map(([bit, label]) => (
            <label key={bit} className="check small">
              <input type="checkbox" checked={!!(p.os2.fsSelection & (1 << bit))}
                onChange={(e) => set(`fsSelection ${label}`, (pp) => { pp.os2.fsSelection = e.target.checked ? pp.os2.fsSelection | (1 << bit) : pp.os2.fsSelection & ~(1 << bit); })} />
              {label}
            </label>
          ))}
        </div>
        <Row label="Mac style">
          {(['Bold', 'Italic'] as const).map((l, bit) => (
            <label key={l} className="check small"><input type="checkbox" checked={!!(p.head.macStyle & (1 << bit))}
              onChange={(e) => set(`macStyle ${l}`, (pp) => { pp.head.macStyle = e.target.checked ? pp.head.macStyle | (1 << bit) : pp.head.macStyle & ~(1 << bit); })} />{l}</label>
          ))}
        </Row>
      </Section>

      <Section title="Version, slant, underline">
        <Row label="Font revision"><Num value={Math.round((p.head.fontRevision / 65536) * 1000) / 1000} step={0.001} onCommit={(v) => set('Set revision', (pp) => {
          pp.head.fontRevision = Math.round(v * 65536);
          pp.setName(5, `Version ${v.toFixed(3)}`);
        })} /></Row>
        {metric('post', 'italicAngle', 'Italic angle °', 'Negative leans right')}
        {metric('post', 'underlinePosition', 'Underline position')}
        {metric('post', 'underlineThickness', 'Underline thickness')}
        {metric('head', 'lowestRecPPEM', 'Smallest readable size (ppem)')}
      </Section>

      <Section title="Tables in this font">
        <p className="mono small">{[...p.tables.keys()].sort().join(' ')}</p>
        <p className="muted small">GSUB features: {p.gsub.features.join(' ') || 'none'}<br />GPOS features: {p.pos.features.join(' ') || 'none'}</p>
        <p className="muted small">Rebuilt on save: glyf, loca, hmtx, hhea, maxp, head, OS/2, name, post, cmap (and GPOS values you edit). Everything else is kept byte for byte.
          {p.isVariable && ' Variable font: saved as its default instance.'}</p>
      </Section>
    </div>
  );
}

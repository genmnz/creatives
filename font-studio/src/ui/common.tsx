// Small shared UI pieces.
import { useEffect, useState, type ReactNode } from 'react';
import type { FontProject } from '../font/font.ts';
import { glyphPath } from '../store.ts';

/** Numeric input that commits on Enter/blur (so typing doesn't create an undo step per key). */
export function Num({ value, onCommit, step = 1, min, max, width = 64, disabled, title, suffix }: {
  value: number; onCommit: (v: number) => void; step?: number; min?: number; max?: number;
  width?: number; disabled?: boolean; title?: string; suffix?: string;
}) {
  const [text, setText] = useState(String(value));
  useEffect(() => setText(fmt(value)), [value]);
  const commit = () => {
    const v = Number(text);
    if (Number.isFinite(v) && v !== value) onCommit(clamp(v, min, max));
    else setText(fmt(value));
  };
  return (
    <span className="num">
      <input
        type="number" value={text} step={step} min={min} max={max} disabled={disabled} title={title}
        style={{ width }}
        onChange={(e) => setText(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') { commit(); (e.target as HTMLInputElement).blur(); }
          if (e.key === 'Escape') { setText(fmt(value)); (e.target as HTMLInputElement).blur(); }
          e.stopPropagation();
        }}
      />
      {suffix && <span className="suffix">{suffix}</span>}
    </span>
  );
}

const fmt = (v: number) => String(Math.round(v * 1000) / 1000);
const clamp = (v: number, a?: number, b?: number) => Math.min(b ?? Infinity, Math.max(a ?? -Infinity, v));

export function Text({ value, onCommit, width = 160, placeholder, mono }: {
  value: string; onCommit: (v: string) => void; width?: number | string; placeholder?: string; mono?: boolean;
}) {
  const [text, setText] = useState(value);
  useEffect(() => setText(value), [value]);
  return (
    <input
      className={mono ? 'mono' : ''} value={text} placeholder={placeholder} style={{ width }}
      onChange={(e) => setText(e.target.value)}
      onBlur={() => text !== value && onCommit(text)}
      onKeyDown={(e) => {
        if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
        if (e.key === 'Escape') { setText(value); (e.target as HTMLInputElement).blur(); }
        e.stopPropagation();
      }}
    />
  );
}

export function Row({ label, children, hint }: { label: ReactNode; children: ReactNode; hint?: string }) {
  return (
    <div className="row" title={hint}>
      <label>{label}</label>
      <div className="row-body">{children}</div>
    </div>
  );
}

export function Section({ title, children, right }: { title: string; children: ReactNode; right?: ReactNode }) {
  return (
    <section className="section">
      <header><h3>{title}</h3>{right}</header>
      {children}
    </section>
  );
}

/** A glyph drawn inside the font's vertical metrics box. */
export function GlyphThumb({ p, gid, size = 48, onClick, active, label, title }: {
  p: FontProject; gid: number; size?: number; onClick?: () => void; active?: boolean; label?: ReactNode; title?: string;
}) {
  if (gid < 0 || gid >= p.numGlyphs) return null;
  const asc = Math.max(p.hhea.ascender, p.os2.sTypoAscender ?? 0);
  const desc = Math.min(p.hhea.descender, p.os2.sTypoDescender ?? 0);
  const h = asc - desc;
  const b = p.bounds(gid);
  const x0 = Math.min(0, b?.xMin ?? 0), x1 = Math.max(p.adv[gid] ?? 0, b?.xMax ?? 0, 1);
  const w = Math.max(x1 - x0, h * 0.4);
  const cx = (x0 + x1) / 2;
  return (
    <button className={`thumb${active ? ' active' : ''}`} onClick={onClick} title={title ?? p.names[gid]} type="button">
      <svg width={size} height={size} viewBox={`${cx - Math.max(w, h) / 2} ${-asc} ${Math.max(w, h)} ${h}`}>
        <path d={glyphPath(p, gid)} transform="scale(1,-1)" />
      </svg>
      {label !== undefined && <span className="thumb-label">{label}</span>}
    </button>
  );
}

export function Tabs<T extends string>({ tabs, value, onChange }: { tabs: [T, string][]; value: T; onChange: (t: T) => void }) {
  return (
    <div className="tabs">
      {tabs.map(([id, label]) => (
        <button key={id} className={id === value ? 'on' : ''} onClick={() => onChange(id)} type="button">{label}</button>
      ))}
    </div>
  );
}

export const hex = (cp: number) => cp.toString(16).toUpperCase().padStart(4, '0');

export function parseCodepoints(s: string): number[] {
  const out: number[] = [];
  for (const tok of s.split(/[\s,]+/).filter(Boolean)) {
    // "U+0628", "0x628", "uni0628" or a bare 4-6 digit hex number; anything else is literal text
    const m = tok.match(/^(?:U\+|u|0x|uni)([0-9a-fA-F]{2,6})$/i) ?? tok.match(/^([0-9a-fA-F]{4,6})$/);
    if (m) out.push(parseInt(m[1], 16));
    else for (const ch of tok) out.push(ch.codePointAt(0)!);
  }
  return [...new Set(out)];
}

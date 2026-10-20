import { useMemo, useState } from 'react';
import { studio, useStudio } from '../store.ts';
import { GlyphThumb } from './common.tsx';

const PRESETS: { name: string; bg: string; fg: string }[] = [
  { name: 'Paper', bg: '#ffffff', fg: '#111111' },
  { name: 'Green', bg: '#8DB73F', fg: '#000000' },
  { name: 'Cream', bg: '#F3E9D6', fg: '#C0302B' },
  { name: 'Night', bg: '#151515', fg: '#f2f2f2' },
];
const DEFAULT_TEXT = 'إنهـــــــا تتخفّـــى\nأكبر من الفستـــان · زرّ، رزق، لا، لأ، ١٠٠٪\nHamburgefonstiv 0123456789';

export function PreviewBar() {
  const s = useStudio();
  const p = s.project!;
  const [text, setText] = useState(() => { try { return localStorage.getItem('studio.preview') ?? DEFAULT_TEXT; } catch { return DEFAULT_TEXT; } });
  const [size, setSize] = useState(64);
  const [lh, setLh] = useState(1.1);
  const [dir, setDir] = useState<'auto' | 'rtl' | 'ltr'>('auto');
  const [preset, setPreset] = useState(0);
  const [shadow, setShadow] = useState(false);
  const [waterfall, setWaterfall] = useState(false);
  const [open, setOpen] = useState(true);
  const [feats, setFeats] = useState<Record<string, boolean>>({});
  const [height, setHeight] = useState(260);

  const allFeatures = useMemo(() => [...new Set([...p.gsub.features, ...p.pos.features])].sort(), [p]);
  const ffs = Object.entries(feats).map(([t, on]) => `"${t}" ${on ? 1 : 0}`).join(', ') || 'normal';
  const firstLine = text.split('\n')[0] ?? '';
  const run = useMemo(() => (s.shaper ? s.shaper.shape(firstLine, feats, dir === 'auto' ? undefined : dir) : []), [s.shaper, firstLine, feats, dir]);

  const cycle = (t: string) => {
    const cur = feats[t];
    const next = { ...feats };
    if (cur === undefined) next[t] = true; else if (cur) next[t] = false; else delete next[t];
    setFeats(next);
  };

  const style: React.CSSProperties = {
    fontFamily: s.previewFamily ? `"${s.previewFamily}", sans-serif` : 'sans-serif',
    fontSize: size, lineHeight: lh, background: PRESETS[preset].bg, color: PRESETS[preset].fg,
    fontFeatureSettings: ffs, direction: dir === 'auto' ? undefined : dir, unicodeBidi: 'plaintext',
    textShadow: shadow ? Array.from({ length: 8 }, (_, i) => `${i + 1}px ${i + 1}px 0 #000`).join(',') : undefined,
  };

  return (
    <div className={`preview ${open ? '' : 'collapsed'}`} style={{ height: open ? height : 34 }}>
      <div className="preview-resize" onPointerDown={(e) => {
        const y0 = e.clientY, h0 = height;
        const move = (ev: PointerEvent) => setHeight(Math.max(120, Math.min(window.innerHeight - 200, h0 + y0 - ev.clientY)));
        const up = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); };
        window.addEventListener('pointermove', move); window.addEventListener('pointerup', up);
      }} />
      <div className="preview-tools">
        <button onClick={() => setOpen(!open)}>{open ? '▾' : '▸'} Preview</button>
        {open && <>
          <label>Size <input type="range" min={12} max={400} value={size} onChange={(e) => setSize(Number(e.target.value))} /> {size}px</label>
          <label>Line <input type="number" step={0.01} min={0.5} max={3} value={lh} onChange={(e) => setLh(Number(e.target.value))} style={{ width: 56 }} /></label>
          <select value={dir} onChange={(e) => setDir(e.target.value as typeof dir)}><option value="auto">auto direction</option><option value="rtl">RTL</option><option value="ltr">LTR</option></select>
          <select value={preset} onChange={(e) => setPreset(Number(e.target.value))}>{PRESETS.map((pr, i) => <option key={i} value={i}>{pr.name}</option>)}</select>
          <label className="check small"><input type="checkbox" checked={shadow} onChange={(e) => setShadow(e.target.checked)} />8-step shadow</label>
          <label className="check small"><input type="checkbox" checked={waterfall} onChange={(e) => setWaterfall(e.target.checked)} />waterfall</label>
          <span className="feats" title="Click: on → off → default">
            {allFeatures.map((t) => (
              <button key={t} className={`feat ${feats[t] === true ? 'on' : feats[t] === false ? 'off' : ''}`} onClick={() => cycle(t)}>{t}</button>
            ))}
          </span>
        </>}
      </div>
      {open && (
        <div className="preview-body">
          <textarea value={text} dir="auto" onChange={(e) => { setText(e.target.value); try { localStorage.setItem('studio.preview', e.target.value); } catch { /* storage unavailable */ } }} />
          <div className="preview-render" style={{ background: PRESETS[preset].bg }}>
            {waterfall
              ? [24, 36, 48, 64, 96, 150, 220].map((sz) => <div key={sz} style={{ ...style, fontSize: sz, whiteSpace: 'nowrap' }}>{firstLine}</div>)
              : text.split('\n').map((line, i) => <div key={i} style={style} dir="auto">{line || ' '}</div>)}
          </div>
          <div className="glyph-run" title="Glyphs HarfBuzz uses for the first line, in visual order. Click one to edit it.">
            {run.map((g, i) => (
              <GlyphThumb key={i} p={p} gid={g.gid} size={34} active={g.gid === s.gid} onClick={() => studio.selectGlyph(g.gid)} label={p.names[g.gid]} />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

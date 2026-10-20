import { useState } from 'react';
import { studio } from '../store.ts';
import { encodeWoff } from '../font/sfnt.ts';
import { validateFont, type Check } from '../validate.ts';
import { saveFiles, type OutFile } from '../save.ts';

type Fmt = 'ttf' | 'woff' | 'woff2';

export function ExportDialog({ onClose }: { onClose: () => void }) {
  const p = studio.project!;
  const base = (p.getName(6) || studio.fileName.replace(/\.[^.]+$/, '') || 'font').replace(/[^A-Za-z0-9._-]/g, '');
  const [name, setName] = useState(base);
  const [formats, setFormats] = useState<Record<Fmt, boolean>>({ ttf: true, woff: false, woff2: true });
  const [dropHinting, setDropHinting] = useState(false);
  const [busy, setBusy] = useState(false);
  const [checks, setChecks] = useState<Check[] | null>(null);
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);

  const encode = async (ttf: Uint8Array, out: Check[]): Promise<OutFile[]> => {
    const files: OutFile[] = [];
    if (formats.ttf) files.push({ name: `${name}.ttf`, bytes: ttf });
    if (formats.woff) files.push({ name: `${name}.woff`, bytes: await encodeWoff(ttf) });
    if (formats.woff2) {
      try {
        const { compressWoff2 } = await import('../font/woff2.ts');
        files.push({ name: `${name}.woff2`, bytes: await compressWoff2(ttf) });
      } catch (e: any) {
        out.push({ ok: false, text: `WOFF2 is unavailable here (${e?.message ?? e}); the other formats are still saved.` });
      }
    }
    return files;
  };

  const run = async (force = false) => {
    setBusy(true); setResult(null);
    try {
      const ttf = p.build({ dropHinting });
      const results = force ? [] : await validateFont(ttf, p);
      if (!force && results.some((c) => !c.ok)) { setChecks(results); setBusy(false); return; }
      const files = await encode(ttf, results);
      setChecks(results);
      if (!files.length) throw new Error('No format could be produced.');
      const msg = await saveFiles(files, `${name}.zip`);
      setResult({ ok: true, text: msg });
      studio.toast(msg, 'ok');
    } catch (e: any) {
      setResult({ ok: false, text: e?.message ?? String(e) });
    }
    setBusy(false);
  };

  return (
    <div className="modal-back" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h2>Save font</h2>
        <label className="form-row"><span>File name</span><input id="export-name" value={name} onChange={(e) => setName(e.target.value)} /></label>
        <div className="form-row"><span>Formats</span>
          <div>
            {(['ttf', 'woff', 'woff2'] as Fmt[]).map((f) => (
              <label key={f} className="check">
                <input id={`export-${f}`} type="checkbox" checked={formats[f]} onChange={(e) => setFormats({ ...formats, [f]: e.target.checked })} /> .{f}
              </label>
            ))}
          </div>
        </div>
        <label className="check"><input id="export-hinting" type="checkbox" checked={dropHinting} onChange={(e) => setDropHinting(e.target.checked)} />
          Remove TrueType hinting (fpgm/prep/cvt and glyph instructions). Edited glyphs lose their instructions either way.</label>
        <p className="muted small">More than one file, or a web format, is saved as one .zip when this page runs inside Claude.</p>
        {p.isVariable && <p className="warn">This is a variable font. It is saved as a static font of its default instance.</p>}
        {p.wasCFF && <p className="warn">PostScript outlines were converted, so this saves as TrueType.</p>}
        {checks && checks.length > 0 && (
          <ul className="checks">
            {checks.map((c, i) => <li key={i} className={c.ok ? 'ok' : 'bad'}>{c.ok ? '✓' : '✗'} {c.text}</li>)}
          </ul>
        )}
        {result && <p className={result.ok ? 'ok-text' : 'warn'}>{result.text}</p>}
        <div className="modal-actions">
          {checks?.some((c) => !c.ok) && !result?.ok && <button onClick={() => run(true)} title="Save even though a check failed">Save anyway</button>}
          <button onClick={onClose}>Close</button>
          <button className="primary" disabled={busy || !Object.values(formats).some(Boolean)} onClick={() => run()}>
            {busy ? 'Building and checking…' : 'Validate and save'}
          </button>
        </div>
      </div>
    </div>
  );
}

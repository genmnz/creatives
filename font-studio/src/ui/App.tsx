import { useEffect, useRef, useState } from 'react';
import { studio, useStudio } from '../store.ts';
import { loadAutosave, type SavedSession } from '../persist.ts';
import { downloadsCapability } from '../save.ts';
import { GlyphGrid } from './GlyphGrid.tsx';
import { Editor } from './Editor.tsx';
import { Inspector } from './Inspector.tsx';
import { PreviewBar } from './PreviewBar.tsx';
import { ExportDialog } from './ExportDialog.tsx';
import { NewFontForm } from './NewFontForm.tsx';

export function App() {
  const s = useStudio();
  const [exporting, setExporting] = useState(false);
  const [creating, setCreating] = useState(false);
  const [dragging, setDragging] = useState(false);

  useEffect(() => { downloadsCapability(); }, []);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement)?.closest('input, textarea, select')) return;
      const mod = e.metaKey || e.ctrlKey;
      if (mod && e.key.toLowerCase() === 'z') { e.preventDefault(); e.shiftKey ? studio.redo() : studio.undo(); }
      else if (mod && e.key.toLowerCase() === 'y') { e.preventDefault(); studio.redo(); }
      else if (mod && e.key.toLowerCase() === 's') { e.preventDefault(); if (studio.project) setExporting(true); }
      else if (mod && e.key.toLowerCase() === 'o') { e.preventDefault(); document.getElementById('open-file')?.click(); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const onDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setDragging(false);
    const f = e.dataTransfer.files[0];
    if (f) studio.openFile(f);
  };

  return (
    <div className="app" onDragOver={(e) => { e.preventDefault(); setDragging(true); }} onDragLeave={() => setDragging(false)} onDrop={onDrop}>
      <TopBar onExport={() => setExporting(true)} onNew={() => setCreating(true)} />
      {s.project ? (
        <div className="workspace">
          <GlyphGrid />
          <main className="center">
            <Editor />
            <PreviewBar />
          </main>
          <Inspector />
        </div>
      ) : (
        <Welcome onNew={() => setCreating(true)} />
      )}
      {exporting && s.project && <ExportDialog onClose={() => setExporting(false)} />}
      {creating && <NewFontForm onClose={() => setCreating(false)} />}
      {dragging && <div className="drop-hint">Drop a TTF, OTF, WOFF or WOFF2 to open it</div>}
      <div className="toasts">
        {s.toasts.map((t) => <div key={t.id} className={`toast ${t.kind}`}>{t.text}</div>)}
      </div>
    </div>
  );
}

function TopBar({ onExport, onNew }: { onExport: () => void; onNew: () => void }) {
  const s = useStudio();
  const fileRef = useRef<HTMLInputElement>(null);
  const p = s.project;
  return (
    <header className="topbar">
      <strong className="brand">Melad Font Studio</strong>
      <input id="open-file" ref={fileRef} type="file" accept=".ttf,.otf,.woff,.woff2,.ttc" hidden
        onChange={(e) => { const f = e.target.files?.[0]; if (f) studio.openFile(f); e.target.value = ''; }} />
      <button onClick={() => fileRef.current?.click()} title="Open a font (Ctrl+O)">Open…</button>
      <button onClick={onNew}>New font…</button>
      {p && <>
        <span className="sep" />
        <button onClick={() => studio.undo()} disabled={!s.past.length} title={s.past.length ? `Undo ${s.past[s.past.length - 1].label} (Ctrl+Z)` : 'Nothing to undo'}>Undo</button>
        <button onClick={() => studio.redo()} disabled={!s.future.length} title="Redo (Ctrl+Shift+Z)">Redo</button>
        <span className="sep" />
        <span className="docname" title={s.fileName}>{p.getName(4) || p.getName(1) || s.fileName}</span>
        <span className="muted">{p.numGlyphs} glyphs · {p.cmap.size} characters · {p.upm} UPM{p.edited.size ? ` · ${p.edited.size} edited` : ''}</span>
        {s.buildError && <span className="error-pill" title={s.buildError}>build error</span>}
        <span className="grow" />
        <button className="primary" onClick={onExport} title="Save as TTF, WOFF or WOFF2 (Ctrl+S)">Save font…</button>
      </>}
    </header>
  );
}

function Welcome({ onNew }: { onNew: () => void }) {
  const [saved, setSaved] = useState<SavedSession | undefined>();
  useEffect(() => { loadAutosave().then(setSaved); }, []);
  const openSample = async (file: string) => {
    const { SAMPLES } = await import('../samples/index.ts');
    studio.openBytes(SAMPLES[file](), file);
  };
  return (
    <div className="welcome">
      <div className="welcome-card">
        <h1>Melad Font Studio</h1>
        <p>Open a font to edit it, or start a new one. Every glyph, every form it takes in text, its metrics,
          anchors, kerning and the font's names and vertical metrics are editable. Saving writes a valid TTF, WOFF or WOFF2.</p>
        <div className="welcome-actions">
          <button className="primary big" onClick={() => document.getElementById('open-file')?.click()}>Open a font…</button>
          <button className="big" onClick={onNew}>Start a new font…</button>
        </div>
        <p className="muted">Or drop a .ttf / .otf / .woff / .woff2 anywhere on this page. Files stay in your browser.</p>
        {saved && (
          <div className="restore">
            <span>Unsaved work found: <b>{saved.fileName}</b> ({new Date(saved.time).toLocaleString()})</span>
            <button className="primary" onClick={() => studio.openBytes(saved.bytes, saved.fileName)}>Resume</button>
          </div>
        )}
        <div className="samples">
          <span className="muted">Samples:</span>
          <button onClick={() => openSample('MeladDisplay-Black.ttf')}>Melad Display</button>
          <button onClick={() => openSample('Jomhuria-Regular.ttf')}>Jomhuria</button>
        </div>
      </div>
    </div>
  );
}

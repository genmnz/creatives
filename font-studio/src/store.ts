// App state: the open font, selection, undo history, live preview build and autosave.
import { useSyncExternalStore } from 'react';
import { FontProject, type Snapshot } from './font/font.ts';
import { newFont, type NewFontOptions } from './font/newfont.ts';
import { contoursToPath } from './font/glyf.ts';
import { Shaper } from './shaping.ts';
import { autosave, clearAutosave } from './persist.ts';

interface HistoryEntry { label: string; before: Snapshot; after: Snapshot; }
type Scope = { glyphs?: number[]; gpos?: boolean; info?: boolean };

export interface Toast { id: number; text: string; kind: 'info' | 'error' | 'ok'; }

class Studio {
  project: FontProject | null = null;
  fileName = '';
  gid = 0;
  /** selected points in the editor, keys "contour:point" */
  points = new Set<string>();
  /** glyphs selected in the grid (batch target) */
  multi = new Set<number>();
  past: HistoryEntry[] = [];
  future: HistoryEntry[] = [];
  tick = 0;
  previewFamily = '';
  previewBytes: Uint8Array | null = null;
  shaper: Shaper | null = null;
  buildError = '';
  shapingError = '';
  toasts: Toast[] = [];
  private listeners = new Set<() => void>();
  private buildTimer: ReturnType<typeof setTimeout> | null = null;
  private saveTimer: ReturnType<typeof setTimeout> | null = null;
  private builtVersion = -1;
  private previewFace: FontFace | null = null;
  private faceCounter = 0;
  private pending: { before: Snapshot; scope: Scope } | null = null;

  subscribe = (fn: () => void) => { this.listeners.add(fn); return () => this.listeners.delete(fn); };
  notify() {
    this.tick++;
    for (const l of this.listeners) l();
    if (this.project && this.project.version !== this.builtVersion) this.scheduleBuild();
  }

  toast(text: string, kind: Toast['kind'] = 'info') {
    const t = { id: Date.now() + Math.random(), text, kind };
    this.toasts = [...this.toasts, t];
    this.notify();
    setTimeout(() => { this.toasts = this.toasts.filter((x) => x !== t); this.notify(); }, kind === 'error' ? 8000 : 4000);
  }

  // ----------------------------------------------------------- documents

  async openFile(file: File) { await this.openBytes(new Uint8Array(await file.arrayBuffer()), file.name); }

  async openBytes(bytes: Uint8Array, name: string) {
    try {
      const p = await FontProject.open(bytes);
      this.setProject(p, name);
      for (const w of p.warnings) this.toast(w, 'info');
    } catch (e: any) {
      this.toast(`Could not open ${name}: ${e?.message ?? e}`, 'error');
    }
  }

  createFont(o: NewFontOptions) {
    this.setProject(newFont(o), `${o.family.replace(/\s+/g, '')}-${(o.style || 'Regular').replace(/\s+/g, '')}.ttf`);
  }

  setProject(p: FontProject, name: string) {
    this.project = p;
    this.fileName = name;
    this.past = []; this.future = [];
    this.points.clear(); this.multi.clear();
    const firstMapped = [...p.cmap.entries()].sort((a, b) => a[0] - b[0]).find(([cp]) => cp > 0x20)?.[1];
    this.gid = firstMapped ?? Math.min(1, p.numGlyphs - 1);
    this.builtVersion = -1;
    // the old font's shaper and preview must not be used with the new glyph IDs
    this.shaper = null;
    this.previewBytes = null;
    this.buildError = '';
    pathCache.clear();
    this.notify();
  }

  async closeFont() {
    this.project = null; this.fileName = '';
    await clearAutosave();
    this.notify();
  }

  selectGlyph(gid: number) {
    if (!this.project || gid < 0 || gid >= this.project.numGlyphs) return;
    this.gid = gid;
    this.points.clear();
    this.notify();
  }

  // ----------------------------------------------------------- history

  /** Run an edit as one undoable step. */
  commit(label: string, scope: Scope, fn: (p: FontProject) => void) {
    const p = this.project;
    if (!p) return;
    const before = p.snapshot(scope);
    try { fn(p); }
    catch (e: any) { p.restore(before); this.toast(e?.message ?? String(e), 'error'); this.notify(); return; }
    this.record(label, before, scope);
    this.notify();
  }

  /** Start a continuous edit (dragging); call end() when the pointer is released. */
  begin(scope: Scope) {
    if (!this.project) return;
    this.pending = { before: this.project.snapshot(scope), scope };
  }
  end(label: string) {
    if (!this.pending || !this.project) return;
    this.record(label, this.pending.before, this.pending.scope);
    this.pending = null;
    this.notify();
  }

  private record(label: string, before: Snapshot, scope: Scope) {
    const p = this.project!;
    const grown = [];
    for (let g = before.numGlyphs ?? p.numGlyphs; g < p.numGlyphs; g++) grown.push(g);
    const after = p.snapshot({ ...scope, glyphs: [...(scope.glyphs ?? []), ...grown] });
    this.past.push({ label, before, after });
    if (this.past.length > 200) this.past.shift();
    this.future = [];
  }

  undo() {
    const e = this.past.pop();
    if (!e || !this.project) return;
    this.project.restore(e.before);
    this.future.push(e);
    if (this.gid >= this.project.numGlyphs) this.gid = 0;
    this.points.clear();
    this.toast(`Undid: ${e.label}`);
  }
  redo() {
    const e = this.future.pop();
    if (!e || !this.project) return;
    this.project.restore(e.after);
    this.past.push(e);
    this.points.clear();
    this.toast(`Redid: ${e.label}`);
  }

  // ----------------------------------------------------------- live build

  private scheduleBuild() {
    if (this.buildTimer) clearTimeout(this.buildTimer);
    this.buildTimer = setTimeout(() => this.buildPreview(), this.pending ? 400 : 150);
  }

  private async buildPreview() {
    const p = this.project;
    if (!p) return;
    const version = p.version;
    try {
      const bytes = p.build();
      this.builtVersion = version;
      const family = `StudioPreview${++this.faceCounter}`;
      const face = new FontFace(family, bytes);
      await face.load();
      document.fonts.add(face);
      if (this.previewFace) document.fonts.delete(this.previewFace);
      this.previewFace = face;
      this.previewFamily = family;
      this.previewBytes = bytes;
      if (this.project !== p) return; // a different font was opened meanwhile
      try {
        this.shaper = await Shaper.create(bytes);
        this.shapingError = '';
      } catch (e: any) {
        this.shaper = null;
        this.shapingError = `Text shaping is unavailable here (${e?.message ?? e}). Editing and saving still work.`;
      }
      this.buildError = '';
      this.scheduleSave();
    } catch (e: any) {
      this.builtVersion = version;
      this.buildError = `The browser rejected the rebuilt font: ${e?.message ?? e}`;
    }
    this.tick++;
    for (const l of this.listeners) l();
  }

  private scheduleSave() {
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => {
      if (this.previewBytes) autosave(this.previewBytes, this.fileName).catch(() => {});
    }, 1500);
  }
}

export const studio = new Studio();
(globalThis as any).studio = studio; // handy for debugging in the console

export function useStudio() {
  useSyncExternalStore(studio.subscribe, () => studio.tick);
  return studio;
}

// --------------------------------------------------------------- paths

const pathCache = new Map<number, { v: number; d: string }>();

/** SVG path (font units, y-up) of a glyph, composites resolved; cached per glyph version. */
export function glyphPath(p: FontProject, gid: number): string {
  const v = p.glyphVersion[gid] ?? 0;
  const c = pathCache.get(gid);
  if (c && c.v === v) return c.d;
  const d = contoursToPath(p.contours(gid));
  pathCache.set(gid, { v, d });
  return d;
}

export function charLabel(cp: number) {
  return `U+${cp.toString(16).toUpperCase().padStart(4, '0')}`;
}

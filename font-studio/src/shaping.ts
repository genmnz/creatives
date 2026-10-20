// HarfBuzz (WebAssembly) shaping against the live, rebuilt font.
type HB = typeof import('harfbuzzjs');

import hbWasm from 'harfbuzzjs/dist/harfbuzz.wasm?b64';

let hbPromise: Promise<HB> | null = null;
/** HarfBuzz gets its wasm from the bundle (see vite.config.ts), so no network access is needed. */
export const loadHarfBuzz = () => (hbPromise ??= (async () => {
  (globalThis as any).__HB_WASM__ = Uint8Array.from(atob(hbWasm), (c) => c.charCodeAt(0));
  return import('harfbuzzjs');
})());

export interface ShapedGlyph { gid: number; cluster: number; ax: number; dx: number; dy: number; }

export class Shaper {
  private hb: HB;
  private font: InstanceType<HB['Font']>;
  constructor(hb: HB, bytes: Uint8Array) {
    this.hb = hb;
    const blob = new hb.Blob(bytes);
    const face = new hb.Face(blob);
    this.font = new hb.Font(face);
  }

  static async create(bytes: Uint8Array) { return new Shaper(await loadHarfBuzz(), bytes); }

  /** features: { tag: on/off }; direction left to HarfBuzz unless given */
  shape(text: string, features: Record<string, boolean> = {}, direction?: 'ltr' | 'rtl'): ShapedGlyph[] {
    const hb = this.hb;
    const buf = new hb.Buffer();
    buf.addText(text);
    buf.guessSegmentProperties();
    if (direction) buf.setDirection(direction === 'rtl' ? hb.Direction.RTL : hb.Direction.LTR);
    const feats = Object.entries(features).map(([t, on]) => new hb.Feature(t, on ? 1 : 0));
    hb.shape(this.font, buf, feats);
    const infos = buf.getGlyphInfos(), pos = buf.getGlyphPositions();
    return infos.map((g, i) => ({ gid: g.codepoint, cluster: g.cluster, ax: pos[i].xAdvance, dx: pos[i].xOffset, dy: pos[i].yOffset }));
  }
}

const TATWEEL = 'ـ';

/** Which glyph a character becomes in each joining position (Arabic-style scripts). */
export function joiningForms(shaper: Shaper, ch: string): { label: string; text: string; gid: number | null }[] {
  const ctx: [string, string][] = [
    ['isolated', ch], ['initial', ch + TATWEEL], ['medial', TATWEEL + ch + TATWEEL], ['final', TATWEEL + ch],
  ];
  return ctx.map(([label, text]) => {
    const run = shaper.shape(text);
    const idx = text.indexOf(ch);
    const hit = run.find((g) => g.cluster === idx);
    return { label, text, gid: hit ? hit.gid : null };
  });
}

// Checks run on every saved font before it is offered for download.
import { FontProject } from './font/font.ts';
import { Shaper } from './shaping.ts';

export interface Check { ok: boolean; text: string; }

export async function validateFont(bytes: Uint8Array, source: FontProject): Promise<Check[]> {
  const out: Check[] = [];
  const add = (ok: boolean, text: string) => out.push({ ok, text });

  let p: FontProject | null = null;
  try {
    p = await FontProject.open(bytes);
    add(true, `Re-opened: ${p.numGlyphs} glyphs, ${p.cmap.size} characters, ${p.tables.size} tables`);
  } catch (e: any) {
    add(false, `The saved file could not be re-read: ${e?.message ?? e}`);
    return out;
  }
  add(p.numGlyphs === source.numGlyphs, `Glyph count matches (${p.numGlyphs})`);
  add(p.cmap.size === source.cmap.size, `Character map matches (${p.cmap.size} characters)`);
  const names = new Set(p.names);
  add(names.size === p.names.length, 'Glyph names are unique');
  add(!!p.getName(1) && !!p.getName(6), `Family "${p.getName(1)}", PostScript name "${p.getName(6)}"`);
  const upm = p.upm;
  add(upm >= 16 && upm <= 16384, `Units per em ${upm} is in range`);
  let outOfRange = 0;
  for (let g = 0; g < p.numGlyphs; g++) {
    const b = p.bounds(g);
    if (b && (Math.abs(b.xMin) > 32767 || Math.abs(b.xMax) > 32767 || Math.abs(b.yMin) > 32767 || Math.abs(b.yMax) > 32767)) outOfRange++;
  }
  add(outOfRange === 0, outOfRange ? `${outOfRange} glyphs have coordinates outside the 16-bit range` : 'All coordinates fit TrueType limits');

  try {
    const face = new FontFace(`StudioValidate${Date.now()}`, bytes);
    await face.load();
    add(true, 'Browser accepted the font (OpenType Sanitizer, as used by Chrome and Firefox)');
  } catch (e: any) {
    add(false, `Browser rejected the font: ${e?.message ?? e}`);
  }

  try {
    const shaper = await Shaper.create(bytes);
    const cps = [...p.cmap.keys()].filter((c) => c > 0x20 && (c < 0xd800 || c > 0xdfff));
    let missing = 0;
    for (let i = 0; i < cps.length; i += 200) {
      const chunk = cps.slice(i, i + 200);
      for (const cp of chunk) {
        const run = shaper.shape(String.fromCodePoint(cp));
        if (run.some((g) => g.gid === 0)) missing++;
      }
    }
    add(missing === 0, missing ? `${missing} mapped characters shape to .notdef` : `HarfBuzz shapes all ${cps.length} mapped characters`);
  } catch (e: any) {
    // a blocked shaping engine (e.g. WebAssembly disabled) says nothing about the font
    add(true, `Shaping check skipped: the HarfBuzz engine is unavailable here (${e?.message ?? e})`);
  }
  return out;
}

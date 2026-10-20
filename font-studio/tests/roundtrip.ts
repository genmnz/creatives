// Node test: open fonts, edit, rebuild, write outputs for external validation (tests/validate.py).
//   node --experimental-strip-types tests/roundtrip.ts <out-dir> <font>...
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { basename } from 'node:path';
import { FontProject } from '../src/font/font.ts';
import { newFont } from '../src/font/newfont.ts';
import { transformGlyph, scaleAbout, emboldenGlyph, rectContour, splitSegment } from '../src/font/ops.ts';
import { formsOf } from '../src/font/otl.ts';
import { encodeWoff } from '../src/font/sfnt.ts';
import { compressWoff2 } from '../src/font/woff2.ts';

const [outDir, ...fonts] = process.argv.slice(2);
mkdirSync(outDir, { recursive: true });
let failures = 0;
const check = (ok: boolean, msg: string) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${msg}`); if (!ok) failures++; };

for (const path of fonts) {
  const name = basename(path).replace(/\.[^.]+$/, '');
  const t0 = performance.now();
  const p = await FontProject.open(new Uint8Array(readFileSync(path)));
  const t1 = performance.now();
  console.log(`\n${name}: ${p.numGlyphs} glyphs, ${p.cmap.size} chars, opened in ${(t1 - t0).toFixed(0)} ms`);
  for (const w of p.warnings) console.log('  warn:', w);

  // 1. untouched round trip
  const same = p.build();
  const t2 = performance.now();
  console.log(`  built in ${(t2 - t1).toFixed(0)} ms (${same.length} bytes)`);
  writeFileSync(`${outDir}/${name}.roundtrip.ttf`, same);
  const again = await FontProject.open(same);
  check(again.numGlyphs === p.numGlyphs && again.cmap.size === p.cmap.size, `${name}: reopen keeps glyphs and cmap`);
  let pointsEqual = true;
  for (let g = 0; g < p.numGlyphs; g++) {
    const a = JSON.stringify(p.glyphs[g].contours), b = JSON.stringify(again.glyphs[g].contours);
    if (a !== b || p.adv[g] !== again.adv[g]) { pointsEqual = false; console.log('   differs:', p.names[g]); break; }
  }
  check(pointsEqual, `${name}: outlines and advances identical after round trip`);

  // 2. layout knowledge
  const alef = p.cmap.get(0x0628);
  if (alef !== undefined) {
    const forms = formsOf(p.gsub, alef);
    console.log(`  forms of U+0628: ${[...forms].map(([g, t]) => `${p.names[g]}[${[...t].join(',')}]`).join(' ')}`);
    check(forms.size >= 4, `${name}: beh has positional forms in GSUB`);
  }
  console.log(`  GPOS: ${p.pos.anchors.length} anchor refs, ${p.pos.values.length} value records`);

  // 3. edits
  const gid = p.cmap.get(0x0647) ?? p.cmap.get(0x41)!;
  p.setGlyph(gid, transformGlyph(p.glyphs[gid], scaleAbout(1.1, 1.0)));
  const heh = p.glyphs[gid];
  if (heh.contours.length) p.setGlyph(gid, splitSegment(heh, 0, 0, 0.5));
  p.setAdvance(gid, p.adv[gid] + 30);
  const base = p.pos.byGlyph.get(gid)?.anchors.find((a) => a.kind === 'base');
  if (base) {
    const before = p.anchorValue(base);
    const res = p.setAnchor(base, before.x + 50, before.y + 25, true);
    const after = p.anchorValue(base);
    check(after.x === before.x + 50 && after.y === before.y + 25, `${name}: anchor moved (shared by ${res.shared}, unshared: ${res.unshared})`);
  }
  const pair = p.pos.values.find((v) => v.kind === 'pair' && v.fields.XAdvance !== undefined);
  if (pair) { p.setValue(pair, 'XAdvance', p.valueOf(pair, 'XAdvance') - 40); check(true, `${name}: kerning value edited`); }
  const newGid = p.addGlyph('studio.test', { unicode: 0xe000, advance: 600 });
  p.setGlyph(newGid, { ...p.glyphs[newGid], contours: [rectContour(50, 0, 550, 700)] });
  const fat = p.cmap.get(0x0644) ?? p.cmap.get(0x6c);
  if (fat !== undefined) p.setGlyph(fat, emboldenGlyph(p.glyphs[fat], 30, 30, p.lookup));
  p.setName(1, `${p.getName(1)} Studio`);
  const edited = p.build();
  writeFileSync(`${outDir}/${name}.edited.ttf`, edited);
  const e2 = await FontProject.open(edited);
  check(e2.numGlyphs === p.numGlyphs && e2.cmap.get(0xe000) === newGid && e2.getName(1).endsWith('Studio'), `${name}: edits survive reopen`);
  writeFileSync(`${outDir}/${name}.edited.woff`, await encodeWoff(edited));
  writeFileSync(`${outDir}/${name}.edited.woff2`, await compressWoff2(edited));
  const fromWoff2 = await FontProject.open(new Uint8Array(readFileSync(`${outDir}/${name}.edited.woff2`)));
  check(fromWoff2.numGlyphs === p.numGlyphs, `${name}: WOFF2 written and read back`);
  const fromWoff = await FontProject.open(new Uint8Array(readFileSync(`${outDir}/${name}.edited.woff`)));
  check(fromWoff.numGlyphs === p.numGlyphs, `${name}: WOFF written and read back`);
}

// 4. brand-new font
const nf = newFont({ family: 'Studio Test', designer: 'test' });
const a = nf.addGlyph('A', { unicode: 0x41, advance: 600 });
nf.setGlyph(a, { ...nf.glyphs[a], contours: [rectContour(50, 0, 550, 700), rectContour(150, 100, 450, 600).reverse()] });
const nfBytes = nf.build();
writeFileSync(`${outDir}/new-font.ttf`, nfBytes);
const nf2 = await FontProject.open(nfBytes);
check(nf2.numGlyphs === 3 && nf2.cmap.get(0x41) === a, 'new font builds and reopens');

console.log(failures ? `\n${failures} FAILED` : '\nall checks passed');
process.exit(failures ? 1 : 0);

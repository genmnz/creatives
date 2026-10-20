// Turn dist-single/index.html into page content for a claude.ai artifact (the host adds
// doctype/html/head/body itself): title and styles first, then the app root and its script.
//   node scripts/make-artifact.mjs dist-single/index.html out.html
import { readFileSync, writeFileSync } from 'node:fs';

const [src, out] = process.argv.slice(2);
const html = readFileSync(src, 'utf8');
const pick = (re) => [...html.matchAll(re)].map((m) => m[0]);
const title = pick(/<title>[\s\S]*?<\/title>/g);
const metas = pick(/<meta name="claude:[^>]*>/g);
const links = pick(/<link rel="(?:preconnect|stylesheet)"[^>]*>/g).filter((l) => l.includes('fonts.g'));
const styles = pick(/<style[^>]*>[\s\S]*?<\/style>/g);
const scripts = pick(/<script type="module"[^>]*>[\s\S]*?<\/script>/g);
if (!title.length || !scripts.length) throw new Error('unexpected build output');
writeFileSync(out, [...title, ...metas, ...links, ...styles, '<div id="root"></div>', ...scripts].join('\n'));
console.log(`${out}: ${(readFileSync(out).length / 1e6).toFixed(2)} MB, ${scripts.length} script(s), ${styles.length} style(s)`);

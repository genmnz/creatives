import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { viteSingleFile } from 'vite-plugin-singlefile';
import { readFileSync } from 'node:fs';

// `vite build` makes a normal static site in dist/;
// `vite build --mode single` makes one self-contained HTML file in dist-single/.
export default defineConfig(({ mode }) => ({
  base: './',
  plugins: [
    react(),
    {
      // `import data from './file.bin?b64'` gives the file as a base64 string (wasm, sample fonts)
      name: 'base64-import',
      enforce: 'pre',
      load(id) {
        if (!id.endsWith('?b64')) return null;
        return `export default ${JSON.stringify(readFileSync(id.slice(0, -4)).toString('base64'))};`;
      },
    },
    {
      // harfbuzzjs initialises itself on import and fetches harfbuzz.wasm; hand it the
      // bytes instead (set by src/shaping.ts) so it also works offline and from file://
      name: 'harfbuzz-embedded-wasm',
      enforce: 'pre',
      transform(code, id) {
        if (!/harfbuzzjs[\\/]dist[\\/]index\.mjs$/.test(id)) return null;
        const patched = code.replace('init(await createHarfBuzz());',
          'init(await createHarfBuzz(globalThis.__HB_WASM__ ? { wasmBinary: globalThis.__HB_WASM__ } : undefined));');
        if (patched === code) this.warn('harfbuzzjs init call not found; wasm will be fetched');
        return { code: patched, map: null };
      },
    },
    {
      // wawoff2's emscripten bindings are classic scripts; expose their Module as an ES module
      name: 'wawoff2-esm',
      enforce: 'pre',
      transform(code, id) {
        if (!/wawoff2[\\/]build[\\/](compress|decompress)_binding\.js$/.test(id)) return null;
        return { code: code.replace(/module\["exports"\]=Module/g, 'void 0') + '\nexport default Module;\n', map: null };
      },
    },
    ...(mode === 'single' ? [viteSingleFile()] : []),
  ],
  optimizeDeps: { exclude: ['harfbuzzjs', 'wawoff2'], include: ['opentype.js'] },
  build: {
    target: 'es2022',
    chunkSizeWarningLimit: 5000,
    outDir: mode === 'single' ? 'dist-single' : 'dist',
    assetsInlineLimit: mode === 'single' ? 100_000_000 : 4096,
  },
  esbuild: { target: 'es2022' },
}));

// WOFF2 via Google's woff2 compiled to WebAssembly (wawoff2's emscripten bindings), loaded on demand.
// The bindings are imported directly: wawoff2's own wrapper waits for onRuntimeInitialized,
// which never fires in browsers when the inlined wasm finishes initialising first.

type Binding = { calledRun?: boolean; onRuntimeInitialized?: () => void; compress(b: Uint8Array): Uint8Array | false; decompress(b: Uint8Array): Uint8Array | false };

async function ready(m: Binding): Promise<Binding> {
  // poll: depending on bundling, the init callback can fire before anyone listens
  for (let i = 0; i < 600; i++) {
    if (m.calledRun && typeof m.compress === 'function' || typeof m.decompress === 'function' && m.calledRun) return m;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error('The WOFF2 engine did not start.');
}

const load = async (which: 'compress' | 'decompress'): Promise<Binding> => {
  if (typeof window === 'undefined') {
    // Node (tests): the bindings are plain CommonJS there
    const { createRequire } = await import('node:module');
    return ready(createRequire(import.meta.url)(`wawoff2/build/${which}_binding.js`));
  }
  const mod: any = which === 'compress'
    ? await import('wawoff2/build/compress_binding.js')
    : await import('wawoff2/build/decompress_binding.js');
  const m = mod.default ?? mod;
  return ready(m);
};

export async function compressWoff2(sfnt: Uint8Array): Promise<Uint8Array> {
  const m = await load('compress');
  const out = m.compress(sfnt);
  if (out === false) throw new Error('WOFF2 compression failed.');
  return new Uint8Array(out);
}

export async function decompressWoff2(woff2: Uint8Array): Promise<Uint8Array> {
  const m = await load('decompress');
  const out = m.decompress(woff2);
  if (out === false) throw new Error('This WOFF2 file could not be decoded.');
  return new Uint8Array(out);
}

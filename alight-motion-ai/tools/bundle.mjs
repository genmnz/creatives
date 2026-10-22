// Bundle the browser-safe modules in src/ into one script that defines
// window.AMX. Each module keeps its own scope; imports become destructuring.
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const SRC = join(dirname(fileURLToPath(import.meta.url)), "..", "src");
const ORDER = ["xml", "anim", "catalog", "svgpath", "shapes", "presets", "svgimport", "builder", "validate", "fxpreview", "render", "ops"];

function convert(name) {
  let code = readFileSync(join(SRC, `${name}.mjs`), "utf8");
  const exported = new Set();
  code = code.replace(/^import\s*\{([^}]*)\}\s*from\s*"\.\/(\w+)\.mjs";?$/gm, (_, names, mod) =>
    `const {${names.replace(/\s+as\s+/g, ": ")}} = __m.${mod};`);
  code = code.replace(/^export\s*\{([^}]*)\};?$/gm, (_, names) => {
    for (const n of names.split(",")) if (n.trim()) exported.add(n.trim());
    return "";
  });
  code = code.replace(/^export\s+(async\s+function|function|class|const|let)\s+(\w+)/gm, (_, kw, id) => {
    exported.add(id);
    return `${kw} ${id}`;
  });
  return `__m.${name} = (() => {\n${code}\nreturn { ${[...exported].join(", ")} };\n})();\n`;
}

export function bundle() {
  let out = "(function(){\nconst __m = {};\n";
  for (const m of ORDER) out += convert(m);
  out += "const AMX = Object.assign({}, ...Object.values(__m));\nif (typeof window !== 'undefined') window.AMX = AMX;\nif (typeof globalThis !== 'undefined') globalThis.AMX = AMX;\n})();\n";
  return out;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) process.stdout.write(bundle());

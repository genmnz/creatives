// Minimal XML reader/writer for Alight Motion scene files.
// Nodes: { tag, attrs: {k: v}, children: [node | {text}] }. Attribute order is kept.

const ENT = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };

export function decodeEntities(s) {
  return s.replace(/&(#x[0-9a-fA-F]+|#\d+|\w+);/g, (m, e) => {
    if (e[0] === "#") return String.fromCodePoint(e[1] === "x" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10));
    return ENT[e] ?? m;
  });
}

export function escapeAttr(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/\n/g, "&#10;");
}

export function escapeText(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export function parseXml(src) {
  let i = 0;
  const root = { tag: "#document", attrs: {}, children: [] };
  const stack = [root];
  const top = () => stack[stack.length - 1];
  const err = (msg) => { throw new Error(`XML parse error at ${i}: ${msg}`); };
  if (src.charCodeAt(0) === 0xfeff) i = 1;
  while (i < src.length) {
    const lt = src.indexOf("<", i);
    if (lt === -1) { pushText(src.slice(i)); break; }
    if (lt > i) pushText(src.slice(i, lt));
    i = lt;
    if (src.startsWith("<!--", i)) {
      const end = src.indexOf("-->", i);
      if (end === -1) err("unterminated comment");
      i = end + 3;
    } else if (src.startsWith("<![CDATA[", i)) {
      const end = src.indexOf("]]>", i);
      if (end === -1) err("unterminated CDATA");
      top().children.push({ text: src.slice(i + 9, end) });
      i = end + 3;
    } else if (src.startsWith("<?", i)) {
      const end = src.indexOf("?>", i);
      if (end === -1) err("unterminated processing instruction");
      i = end + 2;
    } else if (src.startsWith("<!", i)) {
      const end = src.indexOf(">", i);
      i = end + 1;
    } else if (src[i + 1] === "/") {
      const end = src.indexOf(">", i);
      const name = src.slice(i + 2, end).trim();
      const node = stack.pop();
      if (!node || node.tag !== name) err(`unexpected </${name}>`);
      i = end + 1;
    } else {
      const m = /^<([A-Za-z_][\w.:-]*)/.exec(src.slice(i, i + 200));
      if (!m) err("bad tag");
      const node = { tag: m[1], attrs: {}, children: [] };
      i += m[0].length;
      const attrRe = /\s*([A-Za-z_][\w.:-]*)\s*=\s*("([^"]*)"|'([^']*)')|\s*(\/?>)/y;
      for (;;) {
        attrRe.lastIndex = i;
        const a = attrRe.exec(src);
        if (!a) err(`bad attribute in <${node.tag}>`);
        i = attrRe.lastIndex;
        if (a[5]) {
          top().children.push(node);
          if (a[5] === ">") stack.push(node);
          break;
        }
        node.attrs[a[1]] = decodeEntities(a[3] ?? a[4]);
      }
    }
  }
  if (stack.length !== 1) err(`unclosed <${top().tag}>`);
  const el = root.children.find((c) => c.tag);
  if (!el) err("no root element");
  return el;

  function pushText(t) {
    if (!t.trim()) {
      // Keep whitespace only inside text-bearing elements such as <content>.
      if (top().tag === "content" || top().tag === "property") top().children.push({ text: t });
      return;
    }
    top().children.push({ text: decodeEntities(t) });
  }
}

export function el(tag, attrs = {}, children = []) {
  const clean = {};
  for (const [k, v] of Object.entries(attrs)) if (v !== undefined && v !== null) clean[k] = String(v);
  return { tag, attrs: clean, children };
}

export const kids = (node, tag) => (node?.children ?? []).filter((c) => c.tag && (!tag || c.tag === tag));
export const kid = (node, tag) => (node?.children ?? []).find((c) => c.tag === tag);
export const textOf = (node) => (node?.children ?? []).map((c) => (c.tag ? textOf(c) : c.text)).join("");

export function serializeXml(node, { header = true, comment } = {}) {
  let out = header ? "<?xml version='1.0' encoding='UTF-8' ?>\n" : "";
  if (comment) out += `<!-- ${comment.replace(/--/g, "- -")} -->\n`;
  out += write(node, "");
  return out;

  function write(n, ind) {
    const attrs = Object.entries(n.attrs).map(([k, v]) => ` ${k}="${escapeAttr(v)}"`).join("");
    const ch = n.children ?? [];
    if (ch.length === 0) return `${ind}<${n.tag}${attrs}/>\n`;
    if (ch.every((c) => !c.tag)) return `${ind}<${n.tag}${attrs}>${escapeText(ch.map((c) => c.text).join(""))}</${n.tag}>\n`;
    let s = `${ind}<${n.tag}${attrs}>\n`;
    for (const c of ch) s += c.tag ? write(c, ind + "  ") : c.text.trim() ? `${ind}  ${escapeText(c.text.trim())}\n` : "";
    return s + `${ind}</${n.tag}>\n`;
  }
}

// Fill viewer/template.html into a self-contained HTML page (Node only).
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { kids } from "./xml.mjs";
import { ROOT } from "./node.mjs";
import { bundle } from "../tools/bundle.mjs";

const safeJson = (v) => JSON.stringify(v).replace(/</g, "\\u003c");

/** projects: [{name, xml, media: {uri|"file:name": dataUrl}}] */
export function viewerHtml({ title, projects, header = "", docs = "", extraCss = "", extraJs = "" }) {
  const tpl = readFileSync(join(ROOT, "viewer/template.html"), "utf8");
  const catalog = readFileSync(join(ROOT, "catalog/catalog.json"), "utf8");
  const parts = {
    __TITLE__: title, __HEADER__: header, __DOCS__: docs, __EXTRA_CSS__: extraCss, __EXTRA_JS__: extraJs,
    __BUNDLE__: bundle().replace(/<\/script/gi, "<\\/script"),
    __CATALOG__: catalog.replace(/</g, "\\u003c"),
    __PROJECTS__: safeJson(projects),
  };
  return tpl.replace(/__(TITLE|HEADER|DOCS|EXTRA_CSS|EXTRA_JS|BUNDLE|CATALOG|PROJECTS)__/g, (m) => parts[m]);
}

export function projectEntry(scene, mediaHref, name) {
  const media = {};
  for (const m of kids(scene.node, "media")) {
    const href = mediaHref(m.attrs.uri);
    if (href) media[m.attrs.uri] = href;
  }
  return { name: name ?? scene.node.attrs.title, xml: scene.toXML(), media };
}

export function previewHtml(scene, mediaHref) {
  const name = scene.node.attrs.title ?? "Project";
  const header = `<header class="top"><span class="eyebrow">Alight Motion project preview</span><h1>${name.replace(/</g, "&lt;")}</h1></header>`;
  return "<!doctype html><meta charset=utf-8><meta name=viewport content='width=device-width,initial-scale=1'>" +
    viewerHtml({ title: name, projects: [projectEntry(scene, mediaHref, name)], header });
}

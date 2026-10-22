#!/usr/bin/env python3
"""Build catalog/*.json from a decompiled Alight Motion APK (apktool output).

Usage: python3 tools/extract-catalog.py <decompiled_apk_dir> [out_dir]

Only facts needed for interoperability are kept: effect/shape ids, display
names, categories and parameter schemas. Shader and script code is not copied.
"""
import json, os, re, sys
import xml.etree.ElementTree as ET

src = sys.argv[1]
out = sys.argv[2] if len(sys.argv) > 2 else os.path.join(os.path.dirname(__file__), "..", "catalog")
os.makedirs(out, exist_ok=True)

strings = {}
for el in ET.parse(os.path.join(src, "res/values/strings.xml")).getroot():
    if el.tag == "string" and el.get("name"):
        strings[el.get("name")] = "".join(el.itertext()).strip().strip('"')

def s(v):
    if not v:
        return v
    m = re.match(r"@am:string/(.+)", v)
    return strings.get(m.group(1), m.group(1)) if m else v

# Parameter tag -> serialized <property type="...">
WIRE = {"spinner": "float", "slider": "float", "float": "float", "color": "color",
        "selector": "int", "switch": "bool", "point": "vec2", "xyz": "vec3",
        "orient": "quat", "hue-disc": "vec3"}

def params_of(params_el):
    res = []
    if params_el is None:
        return res
    section = None
    for p in params_el:
        if p.tag == "section":
            section = s(p.get("text"))
            continue
        if p.tag not in WIRE or not p.get("id"):
            continue
        d = {"id": p.get("id"), "control": p.tag, "type": WIRE[p.tag], "label": s(p.get("label")) or p.get("id")}
        for k in ("default", "min", "max", "step"):
            if p.get(k) is not None:
                d[k] = p.get(k)
        if p.get("type") and p.tag != "slider":
            d["unit"] = p.get("type")
        if p.tag == "selector":
            d["choices"] = [{"value": c.get("value"), "label": s(c.get("label"))} for c in p if c.tag == "choice"]
        if section:
            d["section"] = section
        res.append(d)
    return res

def load(path):
    txt = open(path, encoding="utf-8").read()
    txt = re.sub(r"<script.*?</script>|<shader.*?</shader>", "", txt, flags=re.S)
    return ET.fromstring(txt.encode("utf-8"))

effects = []
edir = os.path.join(src, "assets/effects")
for f in sorted(os.listdir(edir)):
    if not f.endswith(".xml"):
        continue
    try:
        root = load(os.path.join(edir, f))
    except ET.ParseError as e:
        print("skip", f, e, file=sys.stderr)
        continue
    if root.tag != "effect":
        continue
    tags = [t for t in (root.get("tags") or "").split(",") if t]
    effects.append({
        "id": root.get("id"),
        "file": f,
        "name": s(root.get("name")),
        "desc": s(root.get("desc")),
        "category": root.get("category") or "other",
        "tags": [t for t in tags if t != "membersOnly"],
        "membersOnly": "membersOnly" in tags,
        "deprecated": root.get("deprecated") == "true",
        "internal": root.get("internal") == "true",
        "experimental": root.get("experimental") == "true",
        "affinity": root.get("affinity"),
        "params": params_of(root.find("params")),
    })

shapes = []
sdir = os.path.join(src, "assets/shapes")
for f in sorted(os.listdir(sdir)):
    if not f.endswith(".xml"):
        continue
    root = load(os.path.join(sdir, f))
    sid = root.get("id")
    shapes.append({
        "id": sid,
        "ref": "." + sid.replace("com.alightcreative.shapes.", ""),
        "name": s(root.get("name")),
        "deprecated": root.get("deprecated") == "true",
        "params": params_of(root.find("params")),
    })

version = None
yml = os.path.join(src, "apktool.yml")
if os.path.exists(yml):
    m = re.search(r"versionName:\s*(\S+)", open(yml).read())
    version = m.group(1) if m else None

def slim(p):
    d = {k: p[k] for k in ("id", "type", "label", "default", "min", "max", "unit") if k in p}
    if "choices" in p:
        d["choices"] = [[c["value"], c["label"]] for c in p["choices"]]
    return d

def prune(d):
    return {k: v for k, v in d.items() if v not in (None, False)}

catalog = {
    "source": "Alight Motion " + (version or "?") + " APK assets",
    "effects": [prune({**{k: e[k] for k in ("id", "name", "category", "desc", "membersOnly", "deprecated", "experimental", "affinity")},
                       "params": [slim(p) for p in e["params"]]}) for e in effects if not e["internal"]],
    "shapes": [prune({"id": x["id"], "ref": x["ref"], "name": x["name"], "deprecated": x["deprecated"],
                      "params": [slim(p) for p in x["params"]]}) for x in shapes],
}
with open(os.path.join(out, "catalog.json"), "w", encoding="utf-8") as fh:
    json.dump(catalog, fh, ensure_ascii=False, separators=(",", ":"))
print(len(catalog["effects"]), "effects,", len(shapes), "shapes ->", out)

"""Puts the Arabic from arabic.py into the UFO: glyphs, anchors, features."""

import math
import os

from fontTools.misc.transform import Transform

import arabic as AR
from geometry import band_extent, path_of, polygon, set_outline, transformed, union

ARABIC_STYLE = os.environ.get("NYMPH_ARABIC", "sahel")

LAM_ALEF = {  # ligature suffix -> alef codepoint
    "": 0x0627, "Madda": 0x0622, "HamzaAbove": 0x0623, "HamzaBelow": 0x0625,
}


def gname(cp, form=None):
    return "uni%04X" % cp + ("." + form if form and form != "isol" else "")


def _ink_top(font, name, x, span=220):
    lo = None
    hi = None
    from geometry import runs_at_x
    for dx in range(-span, span + 1, 40):
        for a, b in runs_at_x(font, name, x + dx):
            lo = a if lo is None else min(lo, a)
            hi = b if hi is None else max(hi, b)
    return lo, hi


def build_arabic(font, new_glyph, set_anchor, style=None):
    style = style or ARABIC_STYLE
    glyphs, marks, digits, S = AR.build(style)
    features = {"init": [], "medi": [], "fina": []}
    names = {}
    for key, info in glyphs.items():
        base, form = info["base"], info["form"]
        if base.startswith("lam_alef"):
            alef_cp = LAM_ALEF[base[len("lam_alef"):]]
            name = "uni0644_" + gname(alef_cp) + ("" if form == "isol" else ".fina")
        else:
            cp = AR.LETTERS[base][0]
            name = gname(cp, form)
            if form != "isol":
                features[form].append((gname(cp), name))
        g = new_glyph(font, name, info["width"], [info["unicode"]] if info["unicode"] else [])
        set_outline(g, info["path"])
        names[key] = name
        lo, hi = _ink_top(font, name, info["top_x"])
        set_anchor(g, "top", info["top_x"], (hi if hi is not None else 600) + 110)
        lo, _ = _ink_top(font, name, info["bottom_x"])
        set_anchor(g, "bottom", info["bottom_x"], (lo if lo is not None else 0) - 110)

    # harakat
    for mname, path in marks.items():
        cp, pos = AR.MARKS[mname]
        g = new_glyph(font, gname(cp), 0, [cp])
        b = path.bounds
        cx = (b[0] + b[2]) / 2
        set_outline(g, transformed(path, Transform().translate(-cx - 300, 0)))
        b = g.getBounds(font)
        x = (b.xMin + b.xMax) / 2
        if pos == "top":
            set_anchor(g, "_top", x, b.yMin - 70)
            set_anchor(g, "top", x, b.yMax + 50)
        else:
            set_anchor(g, "_bottom", x, b.yMax + 70)
            set_anchor(g, "bottom", x, b.yMin - 50)

    # digits
    for cp, (path, width) in digits.items():
        g = new_glyph(font, gname(cp), width, [cp])
        set_outline(g, path)

    # punctuation
    def turned(src, name, cp, dy=0):
        b = path_of(font, src).bounds
        p = transformed(path_of(font, src),
                        Transform(-1, 0, 0, -1, b[0] + b[2], b[1] + b[3] + dy))
        g = new_glyph(font, name, font[src].width, [cp])
        set_outline(g, p)

    cb = path_of(font, "comma").bounds
    turned("comma", "uni060C", 0x060C, dy=cb[3] - cb[1] - 120 + 260)
    turned("semicolon", "uni061B", 0x061B, dy=0)
    qb = path_of(font, "question").bounds
    g = new_glyph(font, "uni061F", font["question"].width, [0x061F])
    qw = font["question"].width
    set_outline(g, transformed(path_of(font, "question"),
                               Transform().translate(qw * 0.41, 0).scale(-0.82, 0.82).translate(-qw / 2, 0)))
    g.width = round(qw * 0.82)
    # percent: slash with two dots
    sl = path_of(font, "slash")
    sb = sl.bounds
    slash = transformed(sl, Transform().translate(450, 0).scale(0.6, 0.62).translate(-(sb[0] + sb[2]) / 2, 0))
    r = S.dot_size / 2
    from strokes import blob, ellipse_sk, rounded_rect

    def dot(x, y):
        if S.dot == "square":
            return rounded_rect(x - r, y - r, x + r, y + r, r * 0.25)
        if S.dot == "diamond":
            return polygon([(x, y + r * 1.1), (x + r * 1.1, y), (x, y - r * 1.1), (x - r * 1.1, y)])
        return blob(ellipse_sk(x, y, r, r))
    g = new_glyph(font, "uni066A", 900, [0x066A])
    set_outline(g, union(slash, dot(250, 820), dot(650, 160)))
    # decimal and thousands separators
    reh = path_of(font, "uni0631")
    rb = reh.bounds
    g = new_glyph(font, "uni066B", 420, [0x066B])
    set_outline(g, transformed(reh, Transform().translate(210, -20).scale(0.42).translate(-(rb[0] + rb[2]) / 2, -rb[1])))
    g = new_glyph(font, "uni066C", 380, [0x066C])
    set_outline(g, transformed(path_of(font, "comma"), Transform().translate(190, 700).scale(0.62)
                               .translate(-(cb[0] + cb[2]) / 2, -cb[1])))
    # zero-width controls
    for cp in (0x200C, 0x200D, 0x200E, 0x200F, 0x061C):
        new_glyph(font, gname(cp), 0, [cp])

    # features
    lig = []
    for suffix, alef_cp in LAM_ALEF.items():
        a = gname(alef_cp) + ".fina"
        lig.append("    sub uni0644.init %s by uni0644_%s;" % (a, gname(alef_cp)))
        lig.append("    sub uni0644.medi %s by uni0644_%s.fina;" % (a, gname(alef_cp)))
    fea = ""
    for form in ("init", "medi", "fina"):
        pairs = sorted(features[form])
        fea += "\nfeature %s {\n    script arab;\n    lookupflag IgnoreMarks;\n" % form
        fea += "\n".join("    sub %s by %s;" % p for p in pairs)
        fea += "\n} %s;\n" % form
    fea += "\nfeature rlig {\n    script arab;\n    lookupflag IgnoreMarks;\n" + "\n".join(lig) + "\n} rlig;\n"
    prefix = "languagesystem arab dflt;\nlanguagesystem arab URD;\nlanguagesystem arab FAR;\n"
    mark_names = [gname(cp) for cp, _ in AR.MARKS.values()]
    return prefix, fea, mark_names, S

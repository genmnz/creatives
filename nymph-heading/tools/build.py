#!/usr/bin/env python3
"""Build Nymph Heading from the caps-only original.

    python3 tools/build.py

Reads  source/NymphHeading-Original.ttf
Writes source/NymphHeading-Regular.ufo   (editable source, TrueType curves)
       fonts/ttf/  fonts/otf/  fonts/webfonts/

What it does
------------
* The original's a-z were byte-for-byte copies of A-Z.  They are replaced by
  real small-cap lowercase drawn from the capitals: scaled to the x-height and
  re-weighted (emboldened on both axes) so stems and hairlines match the caps.
* Adds the marks, constructed letters, symbols and composites needed for every
  Latin-script European language (Latin-1, Latin Extended-A, the Latin
  Extended-B / Additional letters European languages use).
* Writes kerning, mark/mkmk positioning, ligatures, ss01, c2sc, locl
  (Turkish/Azeri/Crimean Tatar dotted i, Romanian/Moldovan comma accents),
  fractions, superiors/inferiors, ordinals and case-sensitive forms.
"""

import math
import shutil
import subprocess
import sys
import unicodedata
from pathlib import Path

import extractor
import ufoLib2
from fontTools import agl
from fontTools.misc.transform import Transform
from fontTools.pens.pointPen import SegmentToPointPen
from fontTools.pens.basePen import BasePen
from fontTools.pens.recordingPen import DecomposingRecordingPen
from fontTools.pens.reverseContourPen import ReverseContourPen
from fontTools.ttLib import TTFont

sys.path.insert(0, str(Path(__file__).resolve().parent))
import lowercase as LC  # noqa: E402
from geometry import (  # noqa: E402
    band_extent, difference, ellipse, embolden, intersection, path_of,
    polygon, rect, runs_at_x, runs_at_y, set_outline, transform_glyph,
    transformed, union,
)

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / "source" / "NymphHeading-Original.ttf"
UFO = ROOT / "source" / "NymphHeading-Regular.ufo"
OUT = ROOT / "fonts"

FAMILY = "Nymph Heading"
PS_NAME = "NymphHeading-Regular"
VERSION = (2, 0)

CAP = 1573          # cap height of the original
SC = 1150           # small-cap height (smcp / c2sc)
LX = 1010           # x-height of the drawn lowercase
STEM = 197          # vertical stem of the caps (I, H, L ...)
THIN = 111          # horizontal hairline of the caps (E, F, H bars)

# Lowercase: scale caps, then embolden so stems are 92% / hairlines 90% of caps.
SC_SX = 0.80
SC_SY = (SC - 0.90 * THIN) / (CAP - THIN)
SC_EX = (0.92 * STEM - STEM * SC_SX) / 2
SC_EY = (0.90 * THIN - THIN * SC_SY) / 2
SC_TRACK = 14       # small caps get a touch more air per side

# Superior / inferior / fraction figures and ordinals.
FIG_H = 900
SUP_SY = (FIG_H - 0.75 * THIN) / (CAP - THIN)
SUP_SX = 0.62
SUP_EX = (0.75 * STEM - STEM * SUP_SX) / 2
SUP_EY = (0.75 * THIN - THIN * SUP_SY) / 2
SUP_TRACK = 10

MARK_GAP_TOP = 113  # original gap between cap height and accents


# ---------------------------------------------------------------------------
# small utilities

def uni_name(cp):
    return agl.UV2AGL.get(cp) or ("uni%04X" % cp)


def new_glyph(font, name, width=0, unicodes=()):
    if name in font:
        del font[name]
    g = font.newGlyph(name)
    g.width = round(width)
    g.unicodes = list(unicodes)
    return g


def copy_outline(font, src, dst_glyph, transform=None):
    """Draw src (decomposed) into dst_glyph, optionally transformed."""
    rec = DecomposingRecordingPen(font)
    font[src].draw(rec)
    pen = dst_glyph.getPen()
    if transform is not None:
        from fontTools.pens.transformPen import TransformPen
        pen = TransformPen(pen, transform)
    rec.replay(pen)


def bbox(font, name):
    from fontTools.pens.boundsPen import BoundsPen
    bp = BoundsPen(font)
    font[name].draw(bp)
    return bp.bounds


def derive(font, src, dst, sx, sy, ex, ey, track=0, dy=0, unicodes=()):
    """Scaled + weight-compensated copy of a glyph (small caps, superiors)."""
    g = new_glyph(font, dst, unicodes=unicodes)
    copy_outline(font, src, g, Transform(sx, 0, 0, sy, 0, 0))
    embolden(g, ex, ey)
    transform_glyph(g, Transform(1, 0, 0, 1, ex + track, ey + dy))
    _round(g)
    g.width = round(font[src].width * sx + 2 * ex + 2 * track)
    return g


def _round(g):
    for c in g.contours:
        for p in c.points:
            p.x, p.y = round(p.x), round(p.y)


def add_component(glyph, base, dx=0, dy=0):
    glyph.components.append(
        ufoLib2.objects.Component(baseGlyph=base,
                                  transformation=(1, 0, 0, 1, round(dx), round(dy))))


def anchor(glyph, name):
    for a in glyph.anchors:
        if a.name == name:
            return a.x, a.y
    return None


def set_anchor(glyph, name, x, y):
    glyph.anchors[:] = [a for a in glyph.anchors if a.name != name]
    glyph.appendAnchor({"name": name, "x": round(x), "y": round(y)})


def outline_glyph(font, name, path, width, unicodes=()):
    g = new_glyph(font, name, width, unicodes)
    set_outline(g, path)
    return g


# ---------------------------------------------------------------------------
# 1. load and clean the original

def load_original():
    font = ufoLib2.Font()
    extractor.extractUFO(str(SRC), font)
    # The original drew ß as a capital double-S; keep that as capital ẞ.
    sharp = font.newGlyph("uni1E9E")
    sharp.width = font["germandbls"].width
    sharp.unicodes = [0x1E9E]
    copy_outline(font, "germandbls", sharp)
    # remove the fake lowercase (duplicates of the caps) and junk glyphs
    for name in list(font.keys()):
        g = font[name]
        lower = any(unicodedata.category(chr(u)) == "Ll" for u in g.unicodes)
        if lower or name in ("glyph1", "glyph2"):
            del font[name]
    font.kerning.clear()
    font.groups.clear()
    font.features.text = ""
    # the original's ttfautohint bytecode no longer matches; we re-hint
    for key in [k for k in font.lib if "truetype" in k or "opentype" in k.lower()]:
        del font.lib[key]
    for g in font:
        for key in [k for k in g.lib if "truetype" in k]:
            del g.lib[key]
    return font


ORIG_KERNING = {}
ORIG_GROUPS = {}


def read_original_kerning():
    f = ufoLib2.Font()
    extractor.extractUFO(str(SRC), f)
    ORIG_GROUPS.update({k: list(v) for k, v in f.groups.items()})
    ORIG_KERNING.update(dict(f.kerning))


# ---------------------------------------------------------------------------
# 2. marks

TOP_MARKS = {
    0x0300: "gravecomb", 0x0301: "acutecomb", 0x0302: "circumflexcomb",
    0x0303: "tildecomb", 0x0304: "macroncomb", 0x0306: "brevecomb",
    0x0307: "dotaccentcomb", 0x0308: "dieresiscomb", 0x030A: "ringcomb",
    0x030B: "hungarumlautcomb", 0x030C: "caroncomb", 0x0312: "commaturnedabovecomb",
}
BOTTOM_MARKS = {0x0326: "commaaccentcomb", 0x0327: "cedillacomb"}
OGONEK_MARKS = {0x0328: "ogonekcomb"}
MARK_NAMES = {**TOP_MARKS, **BOTTOM_MARKS, **OGONEK_MARKS}

COMB_X = -460       # combining marks hang to the left of the origin


def build_marks(font):
    """Create combining marks (zero width) and missing spacing accents."""
    paths = {}
    # From the original spacing accents (all centred on x=512).
    for comb, spacing in [("gravecomb", "grave"), ("acutecomb", "acute"),
                          ("circumflexcomb", "circumflex"), ("tildecomb", "tilde"),
                          ("dieresiscomb", "dieresis"), ("macroncomb", "macron"),
                          ("cedillacomb", "cedilla")]:
        paths[comb] = path_of(font, spacing)

    # caron: the circumflex turned upside down about its own middle
    x0, y0, x1, y1 = bbox(font, "circumflex")
    paths["caroncomb"] = transformed(path_of(font, "circumflex"),
                                     Transform(1, 0, 0, -1, 0, y0 + y1))

    # dot accent: one of the dieresis dots, centred
    dots = font["dieresis"].contours
    left = min(dots, key=lambda c: c.getBounds()[0])
    lb = left.getBounds()
    g = new_glyph(font, "_tmpdot")
    left.draw(g.getPen())
    paths["dotaccentcomb"] = transformed(path_of(font, "_tmpdot"),
                                         Transform().translate(512 - (lb[0] + lb[2]) / 2, 0))
    del font["_tmpdot"]

    # ring: lifted out of Aring
    ring = intersection(path_of(font, "Aring"), rect(-500, CAP + 40, 3000, 3000))
    rb = ring.bounds
    paths["ringcomb"] = transformed(ring, Transform().translate(512 - (rb[0] + rb[2]) / 2, 0))

    # hungarumlaut: two slightly smaller acutes
    ac = path_of(font, "acute")
    ab = ac.bounds
    acx = (ab[0] + ab[2]) / 2
    pieces = []
    for dx in (-165, 165):
        t = (Transform().translate(512 + dx, ab[1])
             .scale(0.84, 0.92).translate(-acx, -ab[1]))
        pieces.append(transformed(ac, t))
    paths["hungarumlautcomb"] = union(*pieces)

    # breve: crescent with the font's contrast (heavy bottom, fine tips)
    cx, base = 512, 1690
    rx, ry = 270, 250
    outer = ellipse(cx, base + ry, rx, ry)
    inner = ellipse(cx, base + ry + 112, rx - 42, ry - 6)
    cup = difference(outer, inner)
    paths["brevecomb"] = intersection(cup, rect(0, 0, 1100, base + ry - 25))

    # commaaccent: a smaller comma hung below the baseline
    cb = bbox(font, "comma")
    t = (Transform().translate(512, -80)
         .scale(0.72).translate(-(cb[0] + cb[2]) / 2, -cb[3]))
    g = new_glyph(font, "_tmpcomma")
    copy_outline(font, "comma", g, t)
    embolden(g, 9, 9)
    paths["commaaccentcomb"] = path_of(font, "_tmpcomma")
    del font["_tmpcomma"]

    # turned comma above (Latvian ģ)
    ca = paths["commaaccentcomb"]
    cab = ca.bounds
    paths["commaturnedabovecomb"] = transformed(
        ca, Transform().translate(512, 1690).rotate(math.pi).translate(-(cab[0] + cab[2]) / 2, -cab[3]))

    # ogonek: the cedilla mirrored, so its hook sweeps the other way
    cb = bbox(font, "cedilla")
    paths["ogonekcomb"] = transformed(path_of(font, "cedilla"),
                                      Transform(-1, 0, 0, 1, cb[0] + cb[2], 0)
                                      .translate(0, 0).scale(1, 0.86))

    # caron used after L/l (Slovak ľ Ľ): a short vertical apostrophe
    qb = bbox(font, "quoteright")
    paths["caroncomb.alt"] = transformed(
        path_of(font, "quoteright"),
        Transform().translate(0, CAP).scale(0.82).translate(-qb[0], -qb[3]))

    # --- write combining glyphs with anchors
    for name, path in paths.items():
        b = path.bounds
        cx = (b[0] + b[2]) / 2
        g = outline_glyph(font, name, transformed(path, Transform().translate(COMB_X - cx, 0)), 0)
        cp = {v: k for k, v in MARK_NAMES.items()}.get(name)
        if cp:
            g.unicodes = [cp]
        b = g.getBounds(font)
        if name in BOTTOM_MARKS.values():
            set_anchor(g, "_bottom", COMB_X, 0)
            set_anchor(g, "bottom", COMB_X, b.yMin - 40)
        elif name == "ogonekcomb":
            # attach at the top of the hook's stem
            top = band_extent(font, name, -60, -5)
            set_anchor(g, "_ogonek", (top[0] + top[1]) / 2, 0)
        elif name == "caroncomb.alt":
            set_anchor(g, "_topright", b.xMin, CAP)
        else:
            set_anchor(g, "_top", COMB_X, CAP)
            set_anchor(g, "top", COMB_X, b.yMax - 40)

    # cedilla's hook is off-centre: attach it by its stem, as the designer did
    ced = band_extent(font, "cedillacomb", -60, -5)
    set_anchor(font["cedillacomb"], "_bottom", (ced[0] + ced[1]) / 2, 0)

    # spacing accents that were missing
    for spacing, comb, cp in [("caron", "caroncomb", 0x02C7), ("breve", "brevecomb", 0x02D8),
                              ("dotaccent", "dotaccentcomb", 0x02D9), ("ring", "ringcomb", 0x02DA),
                              ("ogonek", "ogonekcomb", 0x02DB),
                              ("hungarumlaut", "hungarumlautcomb", 0x02DD)]:
        g = new_glyph(font, spacing, 1024, [cp])
        add_component(g, comb, 512 - COMB_X, 0)
        if spacing == "ogonek":
            b = font[comb].getBounds(font)
            g.components[0].transformation = (1, 0, 0, 1, round(512 - (b.xMin + b.xMax) / 2), 0)


# ---------------------------------------------------------------------------
# 3. constructed capitals and symbols

def build_constructed(font):
    hy = path_of(font, "hyphen")
    hb = hy.bounds

    def bar(x0, x1, yc, thick=0.9, angle=0):
        """The hyphen, stretched to [x0, x1] and centred on yc."""
        sx = (x1 - x0) / (hb[2] - hb[0])
        t = (Transform().translate((x0 + x1) / 2, yc).rotate(math.radians(angle))
             .scale(sx, thick).translate(-(hb[0] + hb[2]) / 2, -(hb[1] + hb[3]) / 2))
        return transformed(hy, t)

    # Eth / D with stroke
    shift = 70
    d = transformed(path_of(font, "D"), Transform().translate(shift, 0))
    outline_glyph(font, "Eth", union(d, bar(shift - 120, shift + 560, CAP * 0.48)),
                  font["D"].width + shift, [0x00D0])
    g = new_glyph(font, "Dcroat", font["Eth"].width, [0x0110])
    add_component(g, "Eth")

    # L with stroke
    l = transformed(path_of(font, "L"), Transform().translate(shift, 0))
    stem_c = shift + (143 + 340) / 2
    outline_glyph(font, "Lslash", union(l, bar(stem_c - 300, stem_c + 300, CAP * 0.47, 0.85, 32)),
                  font["L"].width + shift, [0x0141])

    # H with stroke
    outline_glyph(font, "Hbar", union(path_of(font, "H"), bar(40, font["H"].width - 40, CAP * 0.76)),
                  font["H"].width, [0x0126])

    # T with stroke
    tc = sum(runs_at_y(font, "T", 600)[0]) / 2
    outline_glyph(font, "Tbar", union(path_of(font, "T"), bar(tc - 300, tc + 300, CAP * 0.47)),
                  font["T"].width, [0x0166])

    # Thorn: the P bowl slid down to the middle of a full stem
    p = path_of(font, "P")
    stem_r = runs_at_y(font, "P", 300)[0][1]
    bowl_bottom = runs_at_x(font, "P", 600)[0][0]
    drop = (CAP - (CAP - bowl_bottom)) / 2 - 20
    stem = intersection(p, rect(-100, -100, stem_r + 1, 2000))
    bowl = intersection(transformed(p, Transform().translate(0, -drop)),
                        rect(stem_r - 20, 0, 3000, CAP))
    outline_glyph(font, "Thorn", union(stem, bowl), font["P"].width, [0x00DE])

    # Eng: N whose right stem runs on into the hook of J
    n_stem = runs_at_y(font, "N", 1200)[-1]
    j_stem = runs_at_y(font, "J", 800)[0]
    tail = intersection(path_of(font, "J"), rect(-500, -500, 3000, 700))
    sx = (n_stem[1] - n_stem[0]) / (j_stem[1] - j_stem[0])
    t = (Transform().translate(n_stem[1], -430).scale(sx, 1).translate(-j_stem[1], 0))
    eng = union(path_of(font, "N"), transformed(tail, t),
                rect(n_stem[0], -200, n_stem[1], 120))
    outline_glyph(font, "Eng", eng, font["N"].width, [0x014A])

    # Schwa: the C turned round, closed by a crossbar
    cbx = bbox(font, "C")
    turned = transformed(path_of(font, "C"),
                         Transform(-1, 0, 0, -1, cbx[0] + cbx[2], cbx[1] + cbx[3]))
    inner = runs_at_y(font, "O", CAP * 0.5)
    outline_glyph(font, "uni018F",
                  union(turned, bar(cbx[0] + 60, cbx[2] - 40, CAP * 0.5, 0.95)),
                  font["C"].width, [0x018F])

    # --- symbols ---------------------------------------------------------
    plus = path_of(font, "plus")
    pb = plus.bounds
    pcx, pcy = (pb[0] + pb[2]) / 2, (pb[1] + pb[3]) / 2
    eq = path_of(font, "equal")
    eq_bar = intersection(eq, rect(0, 0, 2000, 800))          # lower bar
    eqb = eq_bar.bounds
    eq_cy = (eqb[1] + eqb[3]) / 2
    w = font["plus"].width

    outline_glyph(font, "minus", transformed(eq_bar, Transform().translate(0, pcy - eq_cy)), w, [0x2212])
    outline_glyph(font, "multiply",
                  transformed(plus, Transform().translate(pcx, pcy).rotate(math.pi / 4)
                              .scale(0.82).translate(-pcx, -pcy)), w, [0x00D7])
    outline_glyph(font, "plusminus",
                  union(transformed(plus, Transform().translate(pcx, pcy + 150).scale(0.86)
                                    .translate(-pcx, -pcy)),
                        transformed(eq_bar, Transform().translate(0, 330 - eq_cy))), w, [0x00B1])
    # logical not: a bar with a short tick dropping from its right end
    vstem = intersection(plus, rect(0, -100, 2000, eqb[1] + 10))
    vb = vstem.bounds
    not_bar = transformed(eq_bar, Transform().translate(0, pcy + 60 - eq_cy))
    nb = not_bar.bounds
    tick = intersection(transformed(vstem, Transform().translate(nb[2] - vb[2], nb[1] + 30 - vb[3])),
                        rect(-100, nb[1] - 400, 2000, nb[3]))
    outline_glyph(font, "logicalnot", union(not_bar, tick), w, [0x00AC])
    sl = path_of(font, "slash")
    sb = sl.bounds
    eqfull = eq.bounds
    ecx, ecy = (eqfull[0] + eqfull[2]) / 2, (eqfull[1] + eqfull[3]) / 2
    outline_glyph(font, "notequal",
                  union(eq, transformed(sl, Transform().translate(ecx, ecy).scale(0.5, 0.56)
                                        .translate(-(sb[0] + sb[2]) / 2, -(sb[1] + sb[3]) / 2))),
                  w, [0x2260])
    tl = path_of(font, "asciitilde")
    tb = tl.bounds
    tcx, tcy = (tb[0] + tb[2]) / 2, (tb[1] + tb[3]) / 2
    approx = union(*[transformed(tl, Transform().translate(pcx, pcy + dy).scale(0.8)
                                 .translate(-tcx, -tcy)) for dy in (-150, 150)])
    outline_glyph(font, "approxequal", approx, w, [0x2248])
    for name, src, cp in [("lessequal", "less", 0x2264), ("greaterequal", "greater", 0x2265)]:
        lp = path_of(font, src)
        lb = lp.bounds
        lcx, lcy = (lb[0] + lb[2]) / 2, (lb[1] + lb[3]) / 2
        chev = transformed(lp, Transform().translate(lcx, pcy + 150).scale(0.82).translate(-lcx, -lcy))
        under = transformed(eq_bar, Transform().translate(lcx - (eqb[0] + eqb[2]) / 2, 260 - eq_cy))
        outline_glyph(font, name, union(chev, under), font[src].width, [cp])

    # broken bar
    bp = path_of(font, "bar")
    bb = bp.bounds
    mid = (bb[1] + bb[3]) / 2
    outline_glyph(font, "brokenbar",
                  union(intersection(bp, rect(-100, -1000, 1000, mid - 90)),
                        intersection(bp, rect(-100, mid + 90, 1000, 3000))),
                  font["bar"].width, [0x00A6])

    # currency sign
    ccx, ccy, r, wgt = 520, 760, 300, 118
    ring = difference(ellipse(ccx, ccy, r, r), ellipse(ccx, ccy, r - wgt, r - wgt))
    ticks = []
    for k in range(4):
        a = math.pi / 4 + k * math.pi / 2
        t = Transform().translate(ccx, ccy).rotate(a)
        ticks.append(transformed(rect(r - 40, -50, r + 170, 50), t))
    outline_glyph(font, "currency", union(ring, *ticks), 1040, [0x00A4])

    # per mille: percent plus one more lower ring
    pc = font["percent"]
    rings = [c for c in pc.contours if c.getBounds()[3] < 900]
    g = new_glyph(font, "_tmpring")
    for c in rings:
        c.draw(g.getPen())
    lower = path_of(font, "_tmpring")
    del font["_tmpring"]
    lw = lower.bounds[2] - lower.bounds[0]
    outline_glyph(font, "perthousand",
                  union(path_of(font, "percent"), transformed(lower, Transform().translate(lw + 60, 0))),
                  pc.width + lw + 60, [0x2030])

    # daggers from the flared I
    ip = path_of(font, "I")
    icx = (143 + 340) / 2
    up = transformed(ip, Transform().translate(icx, -380).scale(0.86, (CAP + 380) / CAP)
                     .translate(-icx, 0))
    def crossbar(yc):
        return transformed(ip, Transform().translate(icx, yc).rotate(math.pi / 2)
                           .scale(0.54, 0.62).translate(-icx, -CAP / 2))
    outline_glyph(font, "dagger", union(up, crossbar(1060)), 900, [0x2020])
    outline_glyph(font, "daggerdbl", union(up, crossbar(1060), crossbar(140)), 900, [0x2021])
    for name in ("dagger", "daggerdbl"):
        _center(font, name)

    # section sign: two small S curves interlocked
    s = path_of(font, "S")
    s_b = s.bounds
    s_small = transformed(s, Transform().scale(0.62, 0.56).translate(-s_b[0], -s_b[1]))
    h = (s_b[3] - s_b[1]) * 0.56
    sect = union(transformed(s_small, Transform().translate(110, CAP - h + 30)),
                 transformed(s_small, Transform().translate(110, CAP - 2 * h * 0.78 + 30)))
    g = outline_glyph(font, "section", sect, 0, [0x00A7])
    embolden(g, 14, 10)
    _round(g)
    _center(font, "section", sidebearing=90)

    # braces: each half is the top of "(" run into the bottom of ")",
    # squeezed to half height, so the ends curl out and the middle points in
    pl, pr = path_of(font, "parenleft"), path_of(font, "parenright")
    plb = pl.bounds
    pmid = (plb[1] + plb[3]) / 2
    upper = intersection(pl, rect(-1000, pmid, 3000, plb[3] + 10))
    lower = intersection(pr, rect(-1000, plb[1] - 10, 3000, pmid + 1))
    ua = runs_at_y(font, "parenleft", pmid + 1)[0]
    la = runs_at_y(font, "parenright", pmid - 1)[0]
    half = union(upper, transformed(lower, Transform().translate(ua[0] - la[0], 0)))
    hb = half.bounds
    top = transformed(half, Transform().translate(0, plb[3]).scale(1, 0.5).translate(0, -hb[3]))
    bot = transformed(top, Transform(1, 0, 0, -1, 0, 2 * pmid))
    brace = union(top, bot)
    bw = font["parenleft"].width + 120
    brace = transformed(brace, Transform().translate(60, 0))
    outline_glyph(font, "braceleft", brace, bw, [0x007B])
    outline_glyph(font, "braceright",
                  transformed(brace, Transform(-1, 0, 0, 1, bw, 0)), bw, [0x007D])
    _center(font, "braceleft")
    _center(font, "braceright")

    # guillemets from < and >, centred on the x-height (and cap height for .case)
    for src, single, double, cps in [("less", "guilsinglleft", "guillemotleft", (0x2039, 0x00AB)),
                                     ("greater", "guilsinglright", "guillemotright", (0x203A, 0x00BB))]:
        lp = path_of(font, src)
        lb = lp.bounds
        lcx, lcy = (lb[0] + lb[2]) / 2, (lb[1] + lb[3]) / 2
        cw = (lb[2] - lb[0]) * 0.6
        for suffix, yc in (("", LX * 0.5), (".case", CAP * 0.5)):
            chev = transformed(lp, Transform().translate(80 + cw / 2, yc).scale(0.6)
                               .translate(-lcx, -lcy))
            g = outline_glyph(font, single + suffix, chev, cw + 160, [] if suffix else [cps[0]])
            embolden(g, 10, 6)
            _round(g)
            dbl = union(chev, transformed(chev, Transform().translate(cw * 0.72, 0)))
            g = outline_glyph(font, double + suffix, dbl, cw * 1.72 + 160, [] if suffix else [cps[1]])
            embolden(g, 10, 6)
            _round(g)

    # middle dot
    pb_ = bbox(font, "period")
    for suffix, yc in (("", LX * 0.5), (".case", CAP * 0.5)):
        g = new_glyph(font, "periodcentered" + suffix, font["period"].width,
                      [] if suffix else [0x00B7])
        add_component(g, "period", 0, yc - (pb_[1] + pb_[3]) / 2)

    # fraction slash
    fw = 240
    fs = transformed(sl, Transform().translate(fw / 2, 0).scale(0.72, 0.62)
                     .translate(-(sb[0] + sb[2]) / 2, 0))
    g = outline_glyph(font, "fraction", fs, fw, [0x2044])

    # florin: J's hook below, J's hook turned round above, a bar, slanted
    jp = path_of(font, "J")
    jb = jp.bounds
    js = runs_at_y(font, "J", 800)[0]
    jcx = (js[0] + js[1]) / 2
    low = intersection(jp, rect(-500, -500, 3000, 800))
    high = transformed(low, Transform(-1, 0, 0, -1, 2 * jcx, CAP - 43))
    fl = union(low, high, rect(js[0], 700, js[1], 900))
    fl = transformed(fl, Transform().translate(0, -380))
    fl = union(fl, bar(jcx - 330, jcx + 330, LX - 120, 0.85))
    fl = transformed(fl, Transform().skew(math.radians(12), 0))
    g = outline_glyph(font, "florin", fl, 0, [0x0192])
    _center(font, "florin", sidebearing=40)


def _center(font, name, sidebearing=None):
    g = font[name]
    b = g.getBounds(font)
    if sidebearing is not None:
        g.width = round(b.xMax - b.xMin + 2 * sidebearing)
    dx = round((g.width - (b.xMax - b.xMin)) / 2 - b.xMin)
    for c in g.contours:
        for p in c.points:
            p.x += dx
    for comp in g.components:
        t = comp.transformation
        comp.transformation = (t[0], t[1], t[2], t[3], t[4] + dx, t[5])


# ---------------------------------------------------------------------------
# 4. anchors on the capitals

TOP_X_OVERRIDE = {}       # filled in after visual review, glyph -> x
OGONEK_X = {"A": lambda f: runs_at_y(f, "A", 60)[-1][1] - 70,
            "E": lambda f: runs_at_y(f, "E", 40)[-1][1] - 140,
            "I": lambda f: sum(runs_at_y(f, "I", 40)[0]) / 2 + 40,
            "U": lambda f: (bbox(f, "U")[0] + bbox(f, "U")[2]) / 2 + 80,
            "O": lambda f: (bbox(f, "O")[0] + bbox(f, "O")[2]) / 2 + 80}


def cap_anchors(font, letters):
    # learn top-anchor positions from the designer's own accented capitals
    learned = {}
    for name in font.keys():
        g = font[name]
        if not g.unicodes or g.components:
            continue
        ch = chr(g.unicodes[0])
        dec = unicodedata.decomposition(ch).split()
        if len(dec) != 2 or dec[0].startswith("<"):
            continue
        base = font.get(uni_name(int(dec[0], 16)))
        if base is None:
            continue
        marks = [c for c in g.contours if c.getBounds()[1] > CAP + 30]
        if marks:
            xs = [b for c in marks for b in (c.getBounds()[0], c.getBounds()[2])]
            learned.setdefault(base.name, []).append((min(xs) + max(xs)) / 2)
    for name in letters:
        g = font[name]
        b = g.getBounds(font)
        if name in TOP_X_OVERRIDE:
            tx = TOP_X_OVERRIDE[name]
        elif name in learned:
            tx = sum(learned[name]) / len(learned[name])
        else:
            lo, hi = band_extent(font, name, CAP * 0.8, CAP - 2)
            tx = (lo + hi) / 2 if lo is not None else (b.xMin + b.xMax) / 2
        set_anchor(g, "top", tx, CAP)
        lo, hi = band_extent(font, name, 4, CAP * 0.15)
        bx = (lo + hi) / 2 if lo is not None else (b.xMin + b.xMax) / 2
        set_anchor(g, "bottom", bx, 0)
        if name in OGONEK_X:
            set_anchor(g, "ogonek", OGONEK_X[name](font), 0)
        else:
            set_anchor(g, "ogonek", (hi if hi is not None else b.xMax) - STEM * 0.5, 0)
    # C: the designer's cedilla position in Ccedilla
    ced = band_extent(font, "Ccedilla", -60, -5)
    set_anchor(font["C"], "bottom", (ced[0] + ced[1]) / 2, 0)
    # L and D: room for the vertical caron
    set_anchor(font["L"], "topright", 340 + 70, CAP)


# ---------------------------------------------------------------------------
# 5. lowercase (small caps)

def make_lowercase(font, pairs):
    """pairs: list of (Upper glyph, lower glyph name, lower codepoint or None)."""
    for up, lo, cp in pairs:
        g = derive(font, up, lo, SC_SX, SC_SY, SC_EX, SC_EY, SC_TRACK,
                   unicodes=[cp] if cp else [])
        g.anchors.clear()
        tx = lambda x: x * SC_SX + SC_EX + SC_TRACK
        for a in font[up].anchors:
            y = SC if a.name in ("top", "topright") else a.y
            set_anchor(g, a.name, tx(a.x), y)


# ---------------------------------------------------------------------------
# 6. accented letters as composites

SPECIAL_MARK = {}
for cp in (0x0122, 0x0123, 0x0136, 0x0137, 0x013B, 0x013C, 0x0145, 0x0146, 0x0156, 0x0157):
    SPECIAL_MARK[cp] = {0x0327: 0x0326}       # Latvian: comma below, not cedilla
SPECIAL_MARK[0x0123] = {0x0327: 0x0312}       # ...but lowercase g takes it turned, above


def flatten(cp):
    dec = unicodedata.decomposition(chr(cp)).split()
    if not dec or dec[0].startswith("<"):
        return None
    parts = [int(x, 16) for x in dec]
    first = flatten(parts[0])
    base, marks = first if first else (parts[0], [])
    return base, marks + parts[1:]


def build_composite(font, name, cp, base, marks):
    g = new_glyph(font, name, font[base].width, [cp] if cp else [])
    add_component(g, base)
    stack_top = anchor(font[base], "top")
    for m in marks:
        mname = MARK_NAMES[m]
        mg = font[mname]
        if m in TOP_MARKS:
            if mname == "caroncomb" and anchor(font[base], "topright"):
                tr = anchor(font[base], "topright")
                ma = anchor(font["caroncomb.alt"], "_topright")
                add_component(g, "caroncomb.alt", tr[0] - ma[0], tr[1] - ma[1])
                continue
            ma = anchor(mg, "_top")
            dx, dy = stack_top[0] - ma[0], stack_top[1] - ma[1]
            add_component(g, mname, dx, dy)
            mt = anchor(mg, "top")
            stack_top = (mt[0] + dx, mt[1] + dy)
        elif m in BOTTOM_MARKS:
            ba, ma = anchor(font[base], "bottom"), anchor(mg, "_bottom")
            add_component(g, mname, ba[0] - ma[0], ba[1] - ma[1])
        else:
            ba, ma = anchor(font[base], "ogonek"), anchor(mg, "_ogonek")
            add_component(g, mname, ba[0] - ma[0], ba[1] - ma[1])
    # the composite keeps its base's anchors, with "top" moved above the accents
    for a in font[base].anchors:
        set_anchor(g, a.name, *(stack_top if a.name == "top" else (a.x, a.y)))
    return g


def anchor_precomposed(font):
    """Give the original accented capitals anchors so further marks stack."""
    for g in font:
        if g.anchors or g.components or not g.unicodes:
            continue
        fl = flatten(g.unicodes[0])
        if not fl:
            continue
        base = font.get(uni_name(fl[0]))
        if base is None or not base.anchors:
            continue
        b = g.getBounds(font)
        for a in base.anchors:
            y = b.yMax - 40 if a.name == "top" and b.yMax > CAP + 50 else a.y
            set_anchor(g, a.name, a.x, y)


# ---------------------------------------------------------------------------
# character set

def target_codepoints():
    cps = set(range(0x20, 0x7F)) | set(range(0xA0, 0x100)) | set(range(0x100, 0x180))
    cps -= {0x017F}                                   # long s: not drawn
    cps |= {0x018F, 0x0259, 0x01E6, 0x01E7, 0x01FA, 0x01FB, 0x01FC, 0x01FD,
            0x01FE, 0x01FF, 0x0218, 0x0219, 0x021A, 0x021B, 0x0237,
            0x1E80, 0x1E81, 0x1E82, 0x1E83, 0x1E84, 0x1E85, 0x1EF2, 0x1EF3,
            0x1EBC, 0x1EBD, 0x1EF8, 0x1EF9, 0x1E9E}
    return cps | GREEK_TARGET


LOWER_OF_SPECIAL = {
    "AE": "ae", "OE": "oe", "Oslash": "oslash", "Eth": "eth", "Thorn": "thorn",
    "Lslash": "lslash", "Hbar": "hbar", "Tbar": "tbar", "Eng": "eng",
    "uni018F": "uni0259", "uni1E9E": "germandbls",
}


def lower_anchors(font, names):
    """Anchors for the drawn lowercase."""
    generic_lower_anchors(font, names, asc_stem=("b", "h", "k", "l", "thorn"))
    latin_anchor_tweaks(font)


def generic_lower_anchors(font, names, asc_stem=()):
    for name in names:
        g = font[name]
        b = g.getBounds(font)
        tall = b.yMax > LX + 200
        if name in asc_stem:
            lo, hi = band_extent(font, name, LC.ASC - 300, LC.ASC - 10)
            set_anchor(g, "top", (lo + hi) / 2, LC.ASC)
        else:
            lo, hi = band_extent(font, name, LX * 0.75, LX - 5)
            if lo is None:
                lo, hi = b.xMin, b.xMax
            set_anchor(g, "top", (lo + hi) / 2, LC.ASC if tall else LX)
        lo, hi = band_extent(font, name, 4, LX * 0.18)
        if lo is None:
            lo, hi = b.xMin, b.xMax
        set_anchor(g, "bottom", (lo + hi) / 2, 0)
        set_anchor(g, "ogonek", hi - LC.ST * 0.6, 0)


def latin_anchor_tweaks(font):
    # tweaks: accents sit over the bowl / stem the eye reads as the letter's centre
    for name, x in (("a", 470), ("d", 510), ("q", 510), ("g", 500), ("u", 500)):
        set_anchor(font[name], "top", x, LX)
    set_anchor(font["i"], "top", 100 + LC.ST / 2, LX)
    set_anchor(font["dotlessi"], "top", 100 + LC.ST / 2, LX)
    set_anchor(font["uni0237"], "top", 330, LX)
    set_anchor(font["j"], "top", 330, LX)
    for name in ("u", "a"):
        set_anchor(font[name], "ogonek", runs_at_y(font, name, 300)[-1][1] - 20, 0)
    set_anchor(font["e"], "ogonek", 640, 0)
    set_anchor(font["i"], "ogonek", 100 + LC.ST / 2 + 30, 0)
    # vertical caron after the ascender of d, l, t
    for name in ("d", "l"):
        hi = band_extent(font, name, LC.ASC - 200, LC.ASC - 10)[1]
        set_anchor(font[name], "topright", hi + 70, LC.ASC)
    hi = band_extent(font, "t", LX + 100, LX + 280)[1]
    set_anchor(font["t"], "topright", hi + 60, LX + 300)
    set_anchor(font["L"], "topright", 340 + 70, CAP)


GREEK_TARGET = set(range(0x0391, 0x03AA)) - {0x03A2} | set(range(0x03AA, 0x03CF)) | \
    {0x0384, 0x0385, 0x0386, 0x0387, 0x0388, 0x0389, 0x038A, 0x038C, 0x038E, 0x038F, 0x0390, 0x037E}


def build_greek(font):
    import greek as GR
    for cp, base in GR.SHARED_CAPS.items():
        g = new_glyph(font, uni_name(cp), font[base].width, [cp])
        add_component(g, base)
        for a in font[base].anchors:
            set_anchor(g, a.name, a.x, a.y)
    drawn = {uni_name(cp): (p, w, cp) for p, w, cp in GR.caps(font).values()}
    for name, (path, width, cp) in drawn.items():
        outline_glyph(font, name, path, width, [cp])
    cap_anchors(font, list(drawn))
    for cp, base in GR.SHARED_LOWER.items():
        g = new_glyph(font, "uni03BC" if cp == 0x03BC else uni_name(cp), font[base].width, [cp])
        add_component(g, base)
        for a in font[base].anchors:
            set_anchor(g, a.name, a.x, a.y)
    drawn = {uni_name(cp): (p, w, cp) for p, w, cp in GR.lower(font).values()}
    for name, (path, width, cp) in drawn.items():
        outline_glyph(font, name, path, width, [cp])
    generic_lower_anchors(font, list(drawn))
    set_anchor(font["iota"], "top", 100 + LC.ST / 2, LX)

    # tonos: a steep acute; on capitals it stands to the left of the letter
    ab = bbox(font, "acute")
    tg = new_glyph(font, "tonos", 420, [0x0384])
    copy_outline(font, "acute", tg, Transform().translate(210, 0).skew(math.radians(-18), 0)
                 .scale(0.82, 0.95).translate(-(ab[0] + ab[2]) / 2, 0))
    _round(tg)
    tb = tg.getBounds(font)
    for c in tg.contours:
        for p in c.points:
            p.y += CAP - 120 - tb.yMin + 60
    dg = new_glyph(font, "dieresistonos", 1024, [0x0385])
    add_component(dg, "dieresis")
    add_component(dg, "tonos", 512 - 210, 160)
    for cp in (0x0386, 0x0388, 0x0389, 0x038A, 0x038C, 0x038E, 0x038F):
        base = uni_name(flatten(cp)[0])
        tb = tg.getBounds(font)
        lsb = font[base].getBounds(font).xMin
        # tuck the tonos into the open top-left of round and pointed capitals
        tuck = {0x0391: 330, 0x039F: 140, 0x03A9: 140, 0x03A5: 120}.get(flatten(cp)[0], 0)
        shift = max(0, round(tb.xMax - tb.xMin + 70 - lsb - tuck))
        g = new_glyph(font, uni_name(cp), font[base].width + shift, [cp])
        add_component(g, "tonos", 40 - tb.xMin, 0)
        add_component(g, base, shift)
    for cp, base in ((0x037E, "semicolon"), (0x0387, "periodcentered"), (0x2015, "emdash")):
        g = new_glyph(font, uni_name(cp), font[base].width, [cp])
        add_component(g, base)


def build(font):
    read_original_kerning()
    build_marks(font)
    build_constructed(font)

    caps = [chr(c) for c in range(ord("A"), ord("Z") + 1)]
    cap_specials = list(LOWER_OF_SPECIAL)
    cap_anchors(font, caps + cap_specials + ["Ccedilla"])

    # small capitals (smcp / c2sc)
    pairs = [(c, c.lower() + ".sc", None) for c in caps]
    pairs += [(up, lo + ".sc", None) for up, lo in LOWER_OF_SPECIAL.items()]
    make_lowercase(font, pairs)

    # the drawn lowercase
    def derive_x(src, dst, sx):
        sy = (LX - LC.TH) / (CAP - THIN)
        ey = (LC.TH - THIN * sy) / 2
        ex = (LC.ST + 10 - STEM * sx) / 2
        derive(font, src, dst, sx, sy, ex, ey, 12, unicodes=[ord(dst)])
    for name, (path, width) in LC.build(font, derive_x).items():
        cp = ord(name) if len(name) == 1 else {"dotlessi": 0x0131, "uni0237": 0x0237}[name]
        outline_glyph(font, name, path, width, [cp])
    extra_cps = {"germandbls": 0xDF, "ae": 0xE6, "oe": 0x153, "oslash": 0xF8, "eth": 0xF0,
                 "thorn": 0xFE, "lslash": 0x142, "hbar": 0x127, "tbar": 0x167, "dcroat": 0x111,
                 "eng": 0x14B, "kgreenlandic": 0x138, "uni0259": 0x259}
    for name, (path, width) in LC.build_extras(font).items():
        outline_glyph(font, name, path, width, [extra_cps[name]])
    lower_names = [chr(c) for c in range(ord("a"), ord("z") + 1)] + \
        ["dotlessi", "uni0237"] + list(extra_cps)
    lower_anchors(font, lower_names)

    # ss01 for the lowercase: as the capitals' set, the letter stands on a rule
    for up in sorted(n for n in font.keys() if n.endswith(".ss01") and n[0].isupper()):
        lo = up[:-5].lower()
        if lo == "y":
            continue        # its tail would cut through the rule
        lb = bbox(font, lo)
        outline_glyph(font, lo + ".ss01",
                      union(transformed(path_of(font, lo), Transform().translate(0, 230)),
                            rect(lb[0], 0, lb[2], 131)), font[lo].width)

    # mu: u with a descending left stem
    us = runs_at_y(font, "u", LX * 0.6)[0]
    mu = union(path_of(font, "u"), rect(us[0], LC.DESC, us[1], LX * 0.5))
    outline_glyph(font, "mu", mu, font["u"].width, [0x00B5])

    g = new_glyph(font, "IJ", font["I"].width + font["J"].width - 30, [0x0132])
    add_component(g, "I")
    add_component(g, "J", font["I"].width - 30)
    g = new_glyph(font, "ij", font["i"].width + font["j"].width - 40, [0x0133])
    add_component(g, "i")
    add_component(g, "j", font["i"].width - 40)
    pb = bbox(font, "period")
    for name, base, cp, x, y in [("Ldot", "L", 0x013F, 400, CAP * 0.5),
                                 ("ldot", "l", 0x0140, 100 + LC.ST + 70, LX * 0.55)]:
        g = new_glyph(font, name, font[base].width + (120 if base == "l" else 0), [cp])
        add_component(g, base)
        add_component(g, "period", x - pb[0], y - (pb[1] + pb[3]) / 2)
    g = new_glyph(font, "napostrophe", font["quoteright"].width + font["n"].width - 40, [0x0149])
    add_component(g, "quoteright")
    add_component(g, "n", font["quoteright"].width - 40)

    build_greek(font)

    # accented letters, and their small-cap twins
    existing = {u for g in font for u in g.unicodes}
    for cp in sorted(target_codepoints()):
        fl = flatten(cp)
        if not fl:
            continue
        base_cp, marks = fl
        if any(m not in MARK_NAMES for m in marks):
            continue
        marks = [SPECIAL_MARK.get(cp, {}).get(m, m) for m in marks]
        base = {0x69: "dotlessi", 0x6A: "uni0237"}.get(base_cp, uni_name(base_cp))
        if base not in font:
            base = next((g.name for g in font if base_cp in g.unicodes), None)
            if base is None:
                print("  skip (no base)", hex(cp))
                continue
        if cp not in existing:
            build_composite(font, uni_name(cp), cp, base, marks)
        if unicodedata.category(chr(cp)) == "Ll":
            sc_base = {"dotlessi": "i.sc", "uni0237": "j.sc"}.get(base, base + ".sc")
            if sc_base in font:
                sc_marks = [0x0326 if m == 0x0312 else m for m in marks]
                build_composite(font, uni_name(cp) + ".sc", None, sc_base, sc_marks)

    anchor_precomposed(font)
    build_figures(font)

    import arabic_build as AB
    prefix, fea, marks, style = AB.build_arabic(font, new_glyph, set_anchor)
    FEATURE_HOOKS.append((prefix, fea))
    ARABIC_MARKS.extend(marks)
    print("  arabic style:", style.key)
    missing = sorted(target_codepoints() - {u for g in font for u in g.unicodes})
    if missing:
        print("  not covered:", " ".join("U+%04X" % c for c in missing))


# ---------------------------------------------------------------------------
# 7. superior, inferior and fraction figures; ordinals; numero

DIGITS = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine"]
SUP_CP = [0x2070, 0x00B9, 0x00B2, 0x00B3, 0x2074, 0x2075, 0x2076, 0x2077, 0x2078, 0x2079]


def build_figures(font):
    top_dy = CAP - FIG_H
    for i, d in enumerate(DIGITS):
        derive(font, d, d + ".dnom", SUP_SX, SUP_SY, SUP_EX, SUP_EY, SUP_TRACK)
        for suffix, dy, cp in ((".numr", top_dy, None), (".sups", top_dy, SUP_CP[i]),
                               (".subs", -280, 0x2080 + i)):
            g = new_glyph(font, d + suffix, font[d + ".dnom"].width)
            add_component(g, d + ".dnom", 0, dy)
            if cp:
                alias = new_glyph(font, uni_name(cp), g.width, [cp])
                add_component(alias, d + suffix)
    for name, nums, cp in [("onequarter", ("one", "four"), 0x00BC),
                           ("onehalf", ("one", "two"), 0x00BD),
                           ("threequarters", ("three", "four"), 0x00BE)]:
        n, dn = nums[0] + ".numr", nums[1] + ".dnom"
        fw = font["fraction"].width
        g = new_glyph(font, name, font[n].width + fw + font[dn].width - 40, [cp])
        add_component(g, n)
        add_component(g, "fraction", font[n].width - 20)
        add_component(g, dn, font[n].width + fw - 40)

    # ordinals: superior A / O over a rule
    hy = bbox(font, "hyphen")
    for name, src, cp in [("ordfeminine", "A", 0x00AA), ("ordmasculine", "O", 0x00BA)]:
        derive(font, src, src + ".ordn", SUP_SX, SUP_SY, SUP_EX, SUP_EY, SUP_TRACK, dy=top_dy)
        g = font[src + ".ordn"]
        g.name  # keep as a feature alternate
        b = g.getBounds(font)
        rule = new_glyph(font, name, g.width, [cp])
        add_component(rule, src + ".ordn")
        sx = (b.xMax - b.xMin) / (hy[2] - hy[0])
        rule.components.append(ufoLib2.objects.Component(
            baseGlyph="hyphen",
            transformation=(round(sx, 3), 0, 0, 0.75,
                            round(b.xMin - hy[0] * sx), round(b.yMin - 150 - hy[1] * 0.75))))

    # numero: N followed by a raised, underlined small o
    derive(font, "O", "o.numero", 0.5, 0.48, 12, 9, 0, dy=CAP - 0.48 * CAP - 30)
    ob = font["o.numero"].getBounds(font)
    g = new_glyph(font, "uni2116", font["N"].width + font["o.numero"].width + 40, [0x2116])
    add_component(g, "N")
    add_component(g, "o.numero", font["N"].width)
    sx = (ob.xMax - ob.xMin) / (hy[2] - hy[0])
    g.components.append(ufoLib2.objects.Component(
        baseGlyph="hyphen",
        transformation=(round(sx, 3), 0, 0, 0.75,
                        round(font["N"].width + ob.xMin - hy[0] * sx),
                        round(ob.yMin - 170 - hy[1] * 0.75))))

    # legacy f-ligatures, kept as plain letter pairs in this caps design
    for name, a, b, cp in [("fi", "f", "i", 0xFB01), ("fl", "f", "l", 0xFB02)]:
        g = new_glyph(font, name, font[a].width + font[b].width, [cp])
        add_component(g, a)
        add_component(g, b, font[a].width)


# ---------------------------------------------------------------------------
# 8. kerning

def sc_name(name):
    """Small-cap twin of a capital glyph name, or None."""
    if len(name) == 1 and name.isalpha() and name.isupper():
        return name.lower() + ".sc"
    if name in LOWER_OF_SPECIAL:
        return LOWER_OF_SPECIAL[name] + ".sc"
    return None


# Lowercase kerning classes: (left-side shape, right-side shape) per letter.
LC_LEFT = {   # how the letter's LEFT edge looks (kern2 side)
    "round": "a c d e g o q eth oe ae oslash uni0259 alpha delta epsilon theta sigma phi sigma1",
    "stem": "b h i k l m n p r u dotlessi thorn kgreenlandic hbar lslash eng germandbls "
            "eta iota pi rho beta upsilon psi",
    "diag": "v w y", "x": "x", "z": "z", "s": "s", "t": "t tbar", "f": "f", "j": "j uni0237",
}
LC_RIGHT = {  # how the letter's RIGHT edge looks (kern1 side)
    "round": "b o p e oe thorn oslash eth uni0259 delta theta phi rho omega upsilon", "c": "c",
    "foot": "a d h l m n u dcroat hbar lslash alpha iota tau pi", "stem": "i dotlessi q j g uni0237 germandbls",
    "diag": "v w y", "x": "x", "z": "z", "s": "s", "t": "t tbar", "f": "f",
    "r": "r", "k": "k kgreenlandic",
}
# lowercase-lowercase values (font units)
LC_PAIRS = {
    ("diag", "round"): -55, ("round", "diag"): -45, ("c", "diag"): -25,
    ("r", "round"): -45, ("f", "round"): -40, ("t", "round"): -25, ("k", "round"): -40,
    ("round", "x"): -35, ("x", "round"): -35, ("diag", "diag"): 10, ("round", "z"): -10,
    ("f", "f"): -20, ("r", "s"): -20, ("diag", "s"): -30, ("foot", "diag"): -15,
    ("foot", "t"): -15, ("round", "t"): -20, ("f", "j"): 30,
}
# capital-on-the-left pairs, scaled from the capitals' own value against O / V
UC_LC = {"round": ("O", 0.9), "s": ("O", 0.75), "stem": ("O", 0.4), "diag": ("V", 0.55),
         "x": ("O", 0.45), "z": ("O", 0.45), "t": ("O", 0.35), "f": ("O", 0.3), "j": ("O", 0.5)}
# lowercase-on-the-left pairs against capitals, from the capitals' O / V values
LC_UC = {"round": ("O", 0.8), "foot": ("O", 0.45), "c": ("O", 0.5), "diag": ("V", 0.5),
         "r": ("O", 0.6), "x": ("O", 0.4), "f": ("O", 0.2)}
PUNCT_RIGHT = {"diag": -90, "r": -100, "f": -60, "round": -25, "c": -30}


def build_kerning(font):
    base_of = {}
    for g in font:
        if g.components and g.components[0].baseGlyph in font and not g.name.endswith(".dlig"):
            base_of[g.name] = g.components[0].baseGlyph

    def family(names):
        out = set(n for n in names if n in font)
        changed = True
        while changed:
            changed = False
            for n, b in base_of.items():
                if b in out and n not in out:
                    out.add(n)
                    changed = True
        return sorted(out)

    def is_cap_side(name):
        g = font[name]
        return not any(unicodedata.category(chr(u)) == "Ll" for u in g.unicodes) and \
            not name.endswith(".sc") and not (name.endswith((".dlig", ".ss01")) and name[0].islower())

    groups = {}
    for gname, members in ORIG_GROUPS.items():
        caps = [m for m in members if m in font and is_cap_side(m)]
        if not caps:
            continue
        groups[gname] = family(caps)
        scs = [sc_name(m) for m in caps if sc_name(m) in font]
        if scs:
            groups[gname + ".sc"] = family(scs)
    for side, table in (("public.kern2.lc_", LC_LEFT), ("public.kern1.lc_", LC_RIGHT)):
        for key, names in table.items():
            groups[side + key] = family(names.split())

    seen = {1: set(), 2: set()}
    for gname in sorted(groups):
        side = 1 if gname.startswith("public.kern1.") else 2
        groups[gname] = [m for m in groups[gname] if not (m in seen[side] or seen[side].add(m))]
    font.groups.clear()
    font.groups.update({k: v for k, v in groups.items() if v})

    def cap_group(glyph, side):
        for gname, members in font.groups.items():
            if gname.startswith("public.kern%d." % side) and glyph in members:
                return gname
        return glyph

    kern = {}
    for (l, r), v in ORIG_KERNING.items():
        if not (isinstance(l, str) and isinstance(r, str)):
            continue
        ok = lambda x: x in font.groups if x.startswith("public.kern") else x in font
        if not (ok(l) and ok(r)):
            continue
        kern[(l, r)] = v
        sl = l + ".sc" if l + ".sc" in font.groups else sc_name(l)
        sr = r + ".sc" if r + ".sc" in font.groups else sc_name(r)
        if sl and sr and ok(sl) and ok(sr):
            kern[(sl, sr)] = round(v * SC_SX)
        if sr and ok(sr):
            kern[(l, sr)] = round(v * 0.9)

    def value(left, right):
        return ORIG_KERNING.get((cap_group(left, 1), cap_group(right, 2)), 0)

    for (a, b), v in LC_PAIRS.items():
        kern[("public.kern1.lc_" + a, "public.kern2.lc_" + b)] = v
    for cap in ("T", "V", "W", "Y", "P", "F", "A", "L", "K", "X", "R"):
        for key, (ref, f) in UC_LC.items():
            v = value(cap, ref)
            if v:
                kern[(cap_group(cap, 1), "public.kern2.lc_" + key)] = round(v * f)
    for key, (ref, f) in LC_UC.items():
        for cap in ("T", "V", "W", "Y", "A", "X"):
            v = value(ref, cap)
            if v:
                kern[("public.kern1.lc_" + key, cap_group(cap, 2))] = round(v * f)
    for key, v in PUNCT_RIGHT.items():
        kern[("public.kern1.lc_" + key, cap_group("period", 2))] = v
    font.kerning.clear()
    font.kerning.update({k: v for k, v in kern.items()
                         if v and all((x in font.groups) if x.startswith("public.kern") else (x in font)
                                      for x in k)})


# ---------------------------------------------------------------------------
# 9. OpenType features

FEATURE_HOOKS = []
ARABIC_MARKS = []      # (prefix_text, feature_text) contributed by other scripts


def build_features(font):
    lig_lines = []
    for n in sorted(n for n in font.keys() if n.endswith(".dlig") and n[0].isupper()):
        lig_lines.append(f"    sub {' '.join(n[:-5].split('_'))} by {n};")
    lig_lines.sort(key=lambda s: -s.count(" "))

    ss_up = sorted(n for n in font.keys() if n.endswith(".ss01") and n[0].isupper())
    ss_lo = [n.lower() for n in ss_up if n.lower() in font]

    smcp, c2sc = [], []
    for g in font:
        if not g.unicodes or g.name.endswith(".sc"):
            continue
        ch = chr(g.unicodes[0])
        cat = unicodedata.category(ch)
        if cat == "Ll" and g.name + ".sc" in font:
            smcp.append((g.name, g.name + ".sc"))
        elif cat == "Lu":
            low = ch.lower()
            if len(low) != 1:
                continue
            lname = next((x.name for x in font if ord(low) in x.unicodes), None)
            if lname and lname + ".sc" in font:
                c2sc.append((g.name, lname + ".sc"))
    for extra in (("dotlessi", "i.sc"), ("uni0237", "j.sc")):
        smcp.append(extra)
    smcp.sort()
    c2sc.sort()

    sups = [d + ".sups" for d in DIGITS]
    subs = [d + ".subs" for d in DIGITS]
    numr = [d + ".numr" for d in DIGITS]
    dnom = [d + ".dnom" for d in DIGITS]
    top_marks = [n for n in TOP_MARKS.values() if n in font]

    prefix = "".join(p for p, _ in FEATURE_HOOKS)
    extra = "".join(f for _, f in FEATURE_HOOKS)
    fea = f"""\
languagesystem DFLT dflt;
languagesystem latn dflt;
languagesystem grek dflt;
languagesystem latn ROM;
languagesystem latn MOL;
{prefix}
@DIGITS = [{' '.join(DIGITS)}];
@NUMR = [{' '.join(numr)}];
@DNOM = [{' '.join(dnom)}];
@TOP_MARKS = [{' '.join(top_marks)}];

feature aalt {{
    feature locl;
    feature smcp;
    feature c2sc;
    feature sups;
    feature subs;
    feature ordn;
    feature ss01;
    feature case;
}} aalt;

feature ccmp {{
    lookup DOTLESS {{
        lookupflag UseMarkFilteringSet @TOP_MARKS;
        sub [i j]' @TOP_MARKS by [dotlessi uni0237];
    }} DOTLESS;
}} ccmp;

feature locl {{
    script latn;
    language ROM exclude_dflt;
        sub [Scedilla scedilla uni0162 uni0163] by [uni0218 uni0219 uni021A uni021B];
    language MOL exclude_dflt;
        sub [Scedilla scedilla uni0162 uni0163] by [uni0218 uni0219 uni021A uni021B];
}} locl;

feature smcp {{
{chr(10).join(f'    sub {a} by {b};' for a, b in smcp)}
}} smcp;

feature c2sc {{
{chr(10).join(f'    sub {a} by {b};' for a, b in c2sc)}
}} c2sc;

feature case {{
    sub [guilsinglleft guilsinglright guillemotleft guillemotright periodcentered]
     by [guilsinglleft.case guilsinglright.case guillemotleft.case guillemotright.case periodcentered.case];
}} case;

feature sups {{
    sub @DIGITS by [{' '.join(sups)}];
}} sups;

feature subs {{
    sub @DIGITS by [{' '.join(subs)}];
}} subs;

feature sinf {{
    sub @DIGITS by [{' '.join(subs)}];
}} sinf;

feature numr {{
    sub @DIGITS by @NUMR;
}} numr;

feature dnom {{
    sub @DIGITS by @DNOM;
}} dnom;

feature frac {{
    lookup FRAC_PREP {{
        sub slash by fraction;
    }} FRAC_PREP;
    lookup FRAC_NUMR {{
        sub @DIGITS by @NUMR;
    }} FRAC_NUMR;
    lookup FRAC_DNOM {{
        sub [fraction @DNOM] @NUMR' by @DNOM;
    }} FRAC_DNOM;
}} frac;

feature ordn {{
    sub [A a] by A.ordn;
    sub [O o] by O.ordn;
    sub N o by uni2116;
}} ordn;

feature ss01 {{
    featureNames {{ name "Underscored alternates"; }};
    sub [{' '.join(n[:-5] for n in ss_up)}] by [{' '.join(ss_up)}];
    sub [{' '.join(n[:-5] for n in ss_lo)}] by [{' '.join(ss_lo)}];
}} ss01;

feature dlig {{
{chr(10).join(lig_lines)}
}} dlig;
{extra}"""
    font.features.text = fea


# ---------------------------------------------------------------------------
# 10. metadata

def set_info(font):
    i = font.info
    i.familyName = FAMILY
    i.styleName = "Regular"
    i.styleMapFamilyName = FAMILY
    i.styleMapStyleName = "regular"
    i.versionMajor, i.versionMinor = VERSION
    i.openTypeNameVersion = "Version %d.%03d" % VERSION
    i.openTypeNameUniqueID = "%d.%03d;NONE;%s" % (*VERSION, PS_NAME)
    i.postscriptFontName = PS_NAME
    i.postscriptFullName = FAMILY + " Regular"
    i.openTypeNamePreferredFamilyName = None
    i.openTypeNamePreferredSubfamilyName = None
    i.openTypeNameDescription = (
        "Lowercase, extended European Latin, Greek and Arabic added to the caps-only "
        "Irvin Heading 1.001, in weights from Light to Bold.")
    i.openTypeNameRecords = []        # drop the original's name records ("Irvin")
    i.openTypeHeadCreated = None
    i.unitsPerEm = 2048
    i.capHeight = CAP
    i.xHeight = LX
    i.ascender = 2058
    i.descender = -760
    i.openTypeHheaAscender = 2058
    i.openTypeHheaDescender = -760
    i.openTypeHheaLineGap = 0
    i.openTypeOS2TypoAscender = 2058
    i.openTypeOS2TypoDescender = -760
    i.openTypeOS2TypoLineGap = 0
    i.openTypeOS2WeightClass = 400
    i.openTypeOS2WidthClass = 5
    i.openTypeOS2VendorID = "NONE"
    i.openTypeOS2Selection = [7]          # USE_TYPO_METRICS
    i.postscriptUnderlinePosition = -180
    i.postscriptUnderlineThickness = THIN
    i.openTypeOS2StrikeoutSize = THIN
    i.openTypeOS2StrikeoutPosition = round(LX * 0.5)
    i.openTypeOS2UnicodeRanges = None
    i.openTypeOS2CodePageRanges = None
    i.italicAngle = 0
    # PostScript alignment zones for CFF hinting: baseline, x-height, cap height
    i.postscriptBlueValues = [-45, 0, LX, LX + 16, CAP, CAP + 49]
    i.postscriptOtherBlues = [-500, -484]
    i.postscriptFamilyBlues = []
    i.postscriptStemSnapH = [THIN, round(0.9 * THIN)]
    i.postscriptStemSnapV = [STEM, round(0.92 * STEM)]
    ymin, ymax = 0, 0
    for g in font:
        b = g.getBounds(font)
        if b:
            ymin, ymax = min(ymin, b.yMin), max(ymax, b.yMax)
    i.openTypeOS2WinAscent = max(2058, math.ceil(ymax))
    i.openTypeOS2WinDescent = max(760, -math.floor(ymin))

    cats = {}
    for g in font:
        if g.name in MARK_NAMES.values() or g.name == "caroncomb.alt" or g.name in ARABIC_MARKS:
            cats[g.name] = "mark"
        elif g.name.endswith(".dlig"):
            cats[g.name] = "ligature"
        else:
            cats[g.name] = "base"
    font.lib["public.openTypeCategories"] = cats


def sort_glyphs(font):
    def key(name):
        g = font[name]
        cp = g.unicodes[0] if g.unicodes else 0x110000
        return (name != ".notdef", cp, name)
    order = sorted(font.keys(), key=key)
    font.glyphOrder = order
    font.lib["public.glyphOrder"] = order


# ---------------------------------------------------------------------------
# 11. compile

class _CubicPen(BasePen):
    """Exact quadratic -> cubic degree elevation."""

    def __init__(self, out):
        super().__init__(None)
        self.out = out

    def _moveTo(self, p):
        self.out.moveTo(p)

    def _lineTo(self, p):
        self.out.lineTo(p)

    def _qCurveToOne(self, p1, p2):
        p0 = self._getCurrentPoint()
        c1 = (p0[0] + 2 / 3 * (p1[0] - p0[0]), p0[1] + 2 / 3 * (p1[1] - p0[1]))
        c2 = (p2[0] + 2 / 3 * (p1[0] - p2[0]), p2[1] + 2 / 3 * (p1[1] - p2[1]))
        self.out.curveTo(c1, c2, p2)

    def _curveToOne(self, p1, p2, p3):
        self.out.curveTo(p1, p2, p3)

    def _closePath(self):
        self.out.closePath()

    def _endPath(self):
        self.out.endPath()


def cubic_copy(font):
    """Same font with cubic, PostScript-direction outlines (for CFF)."""
    out = ufoLib2.Font()
    out.info = font.info
    out.features.text = font.features.text
    out.groups.update(font.groups)
    out.kerning.update(font.kerning)
    out.lib.update(font.lib)
    for g in font:
        ng = out.newGlyph(g.name)
        ng.width = g.width
        ng.unicodes = list(g.unicodes)
        ng.anchors = [a for a in g.anchors]
        pen = ReverseContourPen(_CubicPen(ng.getPen()))
        for c in g.contours:
            c.draw(pen)
        for comp in g.components:
            ng.components.append(ufoLib2.objects.Component(
                baseGlyph=comp.baseGlyph, transformation=comp.transformation))
    return out


# Weights: every glyph is re-weighted from the Regular drawing by growing or
# shrinking its ink (ex horizontally, ey vertically) with the point structure
# kept, so all masters interpolate.  Spacing grows with the stems.
WEIGHTS = [  # (style name, OS/2 weight, ex, ey)
    ("Light", 300, -28, -14),
    ("Regular", 400, 0, 0),
    ("Medium", 500, 12, 5.5),
    ("SemiBold", 600, 30, 13.5),
    ("Bold", 700, 48, 22),
]
MASTERS = ("Light", "Regular", "Bold")


def make_weight(font, style, wclass, ex, ey):
    """A decomposed, cubic, PostScript-direction UFO at the given weight."""
    import copy
    out = ufoLib2.Font()
    out.info = copy.deepcopy(font.info)
    out.features.text = font.features.text
    out.groups.update(font.groups)
    out.kerning.update(font.kerning)
    out.lib.update(font.lib)
    for g in font:
        tmp = ufoLib2.objects.Glyph(g.name)
        rec = DecomposingRecordingPen(font)
        g.draw(rec)
        rec.replay(tmp.getPen())
        is_mark = g.width == 0
        if ex or ey:
            embolden(tmp, ex, ey)
            if not is_mark:
                transform_glyph(tmp, Transform().translate(ex, 0))
        ng = out.newGlyph(g.name)
        ng.width = g.width if is_mark else round(g.width + 2 * ex)
        ng.unicodes = list(g.unicodes)
        for a in g.anchors:
            ng.appendAnchor({"name": a.name, "x": round(a.x + (0 if is_mark else ex)), "y": round(a.y)})
        pen = ReverseContourPen(_CubicPen(ng.getPen()))
        for c in tmp.contours:
            for p in c.points:
                p.x, p.y = round(p.x), round(p.y)
            c.draw(pen)
    out.glyphOrder = list(font.glyphOrder)
    i = out.info
    i.styleName = style
    i.openTypeOS2WeightClass = wclass
    i.postscriptFontName = "NymphHeading-" + style
    i.postscriptFullName = FAMILY + " " + style
    if style in ("Regular", "Bold"):
        i.styleMapFamilyName = FAMILY
        i.styleMapStyleName = style.lower()
    else:
        i.styleMapFamilyName = FAMILY + " " + style
        i.styleMapStyleName = "regular"
        i.openTypeNamePreferredFamilyName = FAMILY
        i.openTypeNamePreferredSubfamilyName = style
    i.openTypeNameUniqueID = "%d.%03d;NONE;NymphHeading-%s" % (*VERSION, style)
    i.postscriptStemSnapV = [round(STEM + 2 * ex), round(0.92 * STEM + 2 * ex)]
    i.postscriptStemSnapH = [round(THIN + 2 * ey), round(0.9 * THIN + 2 * ey)]
    i.postscriptUnderlineThickness = round(THIN + 2 * ey)
    i.openTypeOS2StrikeoutSize = round(THIN + 2 * ey)
    return out


def _hint_ttf(src, dst):
    import ttfautohint
    ttfautohint.ttfautohint(in_file=str(src), out_file=str(dst), default_script="latn",
                            fallback_script="none", no_info=True, hint_composites=False)


def compile_all(font, quick_out=None):
    from fontTools.designspaceLib import AxisDescriptor, DesignSpaceDocument, SourceDescriptor
    from ufo2ft import compileOTF, compileTTF, compileVariableTTF
    if quick_out:
        compileTTF(make_weight(font, "Regular", 400, 0, 0), removeOverlaps=False,
                   useProductionNames=True).save(quick_out)
        return
    if OUT.exists():
        shutil.rmtree(OUT)
    for d in ("ttf", "otf", "webfonts", "variable"):
        (OUT / d).mkdir(parents=True, exist_ok=True)
    tmp = ROOT / "build-tmp"
    tmp.mkdir(exist_ok=True)

    weights = {}
    for style, wclass, ex, ey in WEIGHTS:
        ufo = make_weight(font, style, wclass, ex, ey)
        weights[style] = ufo
        name = "NymphHeading-" + style
        raw = tmp / (name + ".ttf")
        compileTTF(ufo, removeOverlaps=False, useProductionNames=True).save(raw)
        _hint_ttf(raw, OUT / "ttf" / (name + ".ttf"))
        otf = OUT / "otf" / (name + ".otf")
        compileOTF(ufo, removeOverlaps=False, useProductionNames=True, optimizeCFF=2).save(otf)
        if shutil.which("otfautohint"):
            subprocess.run(["otfautohint", str(otf)], check=True, capture_output=True)
        for flavor in ("woff", "woff2"):
            f = TTFont(OUT / "ttf" / (name + ".ttf"))
            f.flavor = flavor
            f.save(OUT / "webfonts" / f"{name}.{flavor}")
        print("  built", style)

    # variable font: Light, Regular, Bold masters on a wght axis
    doc = DesignSpaceDocument()
    axis = AxisDescriptor()
    axis.name, axis.tag, axis.minimum, axis.default, axis.maximum = "Weight", "wght", 300, 400, 700
    axis.labelNames = {"en": "Weight"}
    doc.addAxis(axis)
    for style in MASTERS:
        wclass = dict((s, w) for s, w, _, _ in WEIGHTS)[style]
        path = tmp / f"NymphHeading-{style}.ufo"
        if path.exists():
            shutil.rmtree(path)
        weights[style].save(path)
        src = SourceDescriptor()
        src.path = str(path)
        src.styleName = style
        src.location = {"Weight": wclass}
        src.font = weights[style]
        src.familyName = FAMILY
        doc.addSource(src)
    from fontTools.designspaceLib import AxisLabelDescriptor, InstanceDescriptor
    axis.axisLabels = [AxisLabelDescriptor(name=s, userValue=w, elidable=(s == "Regular"))
                       for s, w, _, _ in WEIGHTS]
    for s, w, _, _ in WEIGHTS:
        inst = InstanceDescriptor()
        inst.familyName = FAMILY
        inst.styleName = s
        inst.location = {"Weight": w}
        inst.postScriptFontName = "NymphHeading-" + s
        doc.addInstance(inst)
    doc.write(tmp / "NymphHeading.designspace")
    vf = compileVariableTTF(doc, useProductionNames=True, optimizeGvar=True)
    vf_path = OUT / "variable" / "NymphHeading[wght].ttf"
    for rec in vf["name"].names:
        if rec.nameID == 6:
            rec.string = "NymphHeading-Variable"
    vf.save(vf_path)
    f = TTFont(vf_path)
    f.flavor = "woff2"
    f.save(OUT / "variable" / "NymphHeading[wght].woff2")
    shutil.rmtree(tmp)
    write_css()
    return vf_path


def write_css():
    rules = []
    for style, wclass, _, _ in WEIGHTS:
        rules.append(f"""@font-face {{
  font-family: "Nymph Heading";
  src: url("NymphHeading-{style}.woff2") format("woff2"),
       url("NymphHeading-{style}.woff") format("woff");
  font-weight: {wclass};
  font-style: normal;
  font-display: swap;
}}""")
    (OUT / "webfonts" / "nymph-heading.css").write_text("\n\n".join(rules) + "\n")
    (OUT / "variable" / "nymph-heading-variable.css").write_text("""@font-face {
  font-family: "Nymph Heading";
  src: url("NymphHeading[wght].woff2") format("woff2-variations"),
       url("NymphHeading[wght].woff2") format("woff2");
  font-weight: 300 700;
  font-style: normal;
  font-display: swap;
}
""")


def main():
    import argparse
    ap = argparse.ArgumentParser()
    ap.add_argument("--quick", help="only compile an unhinted Regular TTF to this path")
    ap.add_argument("--arabic-style", default=None)
    args = ap.parse_args()
    if args.arabic_style:
        import arabic_build
        arabic_build.ARABIC_STYLE = args.arabic_style
    font = load_original()
    build(font)
    build_kerning(font)
    build_features(font)
    set_info(font)
    sort_glyphs(font)
    if args.quick:
        compile_all(font, quick_out=args.quick)
        print("wrote", args.quick)
        return
    if UFO.exists():
        shutil.rmtree(UFO)
    font.save(UFO)
    compile_all(font)
    print("glyphs:", len(font))


if __name__ == "__main__":
    main()

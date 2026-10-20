#!/usr/bin/env python3
"""Build Melad Display from Jomhuria.

    python3 build.py            # everything: masters, variable font, statics, woff2

Pipeline (all derived from sources/Jomhuria-Regular.ttf, OFL 1.1):
  1. Base prep on Jomhuria: new linear tatweel, drop Jomhuria's tatweel-collapsing
     rlig lookups, add elongated alternates (jalt + ss02), clone their GPOS data.
  2. Every glyph is flattened once into an overlap-free *body* plus *satellites*
     (dots, hamza and other mark components), so all masters share one point
     structure.
  3. Masters at wdth {78, 84, 100} x wght {400, 900}: horizontal condense (calibrated
     so wdth = % of Jomhuria's set width), point-preserving embolden, lighter and
     less condensed satellites pushed clear of the body, GPOS rescaled to match.
  4. varLib -> MeladDisplay[wdth,wght].ttf; statics built directly at wght 900
     with overlaps removed; WOFF2 for all.
"""
import bisect
import copy
import os
import sys

import skia
import uharfbuzz as hb
from fontTools.designspaceLib import AxisDescriptor, DesignSpaceDocument, InstanceDescriptor, SourceDescriptor
from fontTools.misc.transform import Transform
from fontTools.otlLib.builder import buildStatTable
from fontTools.ttLib import TTFont, newTable
from fontTools.ttLib.removeOverlaps import removeOverlaps
from fontTools.ttLib.tables import otTables as ot
from fontTools.ttLib.tables import ttProgram
from fontTools.ttLib.tables._g_l_y_f import Glyph, GlyphCoordinates
from fontTools import varLib

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import geometry as G  # noqa: E402

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
SRC = os.path.join(HERE, "Jomhuria-Regular.ttf")
BUILD = os.path.join(HERE, "build")
FONTS = os.path.join(ROOT, "fonts")

VERSION = 1.000
FAMILY = "Melad Display"
PS_FAMILY = "MeladDisplay"

# ------------------------------------------------------------------ design
TATWEEL_ADV = 360          # advance of one U+0640 at 100% width (Jomhuria's single kashida: 270)
JOIN_TOP = 436             # Jomhuria's connecting-stroke height (0..436)
JOIN_OVERHANG = 70         # joins overlap the neighbour by 70 units on each side
EMB_X_900 = 46             # per-side emboldening at wght 900 (x is a bit stronger
EMB_Y_900 = 40             #   to compensate for the condensing)
SHIFT_K = 0.5              # share of the added ink returned as sidebearing (tightens)
DOT_EMB = 0.7              # satellites/marks get a fraction of the body weight
MARK_EMB = 0.5
SAT_SCALE_EXP = 0.5        # satellites are condensed by s**0.5 (dots stay rounder)
GAP_FLOOR = 120            # white gaps (counters, teeth, dot clearances) narrower than this...
GAP_KEEP = 0.8             # ...keep at least 80% of their width; wider gaps shrink by the full weight

WDTH_MASTERS = (78, 84, 100)
WGHT_MASTERS = (400, 900)
DEFAULT = (84, 900)
STATICS = {78: "Narrow", 84: "", 90: "Semi"}

# elongated alternates: glyph -> list of (x range to search for a clean cut, length)
ALTS = {
    "uni0647.medi": [((200, 560), 480)],
    "uni0633.medi": [((-60, 1360), 560)],
    "uni0634.medi": [((-60, 1360), 560)],
    "uni0644.medi": [((-60, 1290), 560)],
    "uni0649.fina": [((150, 1300), 680)],
    "uni06CC.fina": [((150, 1300), 680)],
    "uni064A.fina": [((150, 1300), 680)],
    "uni0646.fina": [((100, 800), 560)],
}
ALT_SUFFIX = ".long"

SAMPLE = [
    "إنهـــــــا تتخفّـــى", "أكبر من الفستـــان", "ثم جاء الوجه الشاحـــب", "من أخذ الغـــلاف؟",
    "هل تتذكّر الفستان أم الوجـــــــه؟",
    "في يناير ١٩٩٠ جمع المصوّر بيتر ليندبرغ خمس عارضات على غلاف واحد لفوغ البريطانية.",
    "المرأة، الموضة، الصورة، العارضة، زرّ، رزق، لا، لأ، لإ، لآ، فـــي، بـــ، ١٠٠٪",
]


def emb(wght):
    t = (wght - 400) / 500
    return EMB_X_900 * t, EMB_Y_900 * t


# ============================================================ OTL helpers

def gid_map(font):
    return {g: i for i, g in enumerate(font.getGlyphOrder())}


def cov_insert(cov, glyph, gids):
    """Insert glyph into a Coverage keeping GID order; return index (or None if present)."""
    if glyph in cov.glyphs:
        return None
    keys = [gids[g] for g in cov.glyphs]
    i = bisect.bisect(keys, gids[glyph])
    cov.glyphs.insert(i, glyph)
    return i


def iter_subtables(table):
    for li, lk in enumerate(table.LookupList.Lookup):
        for st in lk.SubTable:
            t = lk.LookupType
            if (table is not None) and t in (7, 9):
                t = st.ExtensionLookupType
                st = st.ExtSubTable
            yield li, t, st


def clone_in_gpos(font, orig, new, anchor_fn):
    """Give glyph `new` the same GPOS behaviour as `orig`. anchor_fn(x, y) maps base anchors."""
    gids = gid_map(font)
    gpos = font["GPOS"].table
    for _, t, st in iter_subtables(gpos):
        if t == 1:
            if orig in st.Coverage.glyphs:
                idx = st.Coverage.glyphs.index(orig)
                i = cov_insert(st.Coverage, new, gids)
                if i is not None and st.Format == 2:
                    st.Value.insert(i, copy.deepcopy(st.Value[idx]))
                    st.ValueCount = len(st.Value)
        elif t == 2:
            if st.Format == 1:
                if orig in st.Coverage.glyphs:
                    ps = copy.deepcopy(st.PairSet[st.Coverage.glyphs.index(orig)])
                    i = cov_insert(st.Coverage, new, gids)
                    if i is not None:
                        st.PairSet.insert(i, ps)
                        st.PairSetCount = len(st.PairSet)
                for ps in st.PairSet:
                    recs = [r for r in ps.PairValueRecord if r.SecondGlyph == orig]
                    for r in recs:
                        nr = copy.deepcopy(r)
                        nr.SecondGlyph = new
                        keys = [gids[x.SecondGlyph] for x in ps.PairValueRecord]
                        ps.PairValueRecord.insert(bisect.bisect(keys, gids[new]), nr)
                    ps.PairValueCount = len(ps.PairValueRecord)
            else:
                if orig in st.Coverage.glyphs:
                    cov_insert(st.Coverage, new, gids)
                    if orig in st.ClassDef1.classDefs:
                        st.ClassDef1.classDefs[new] = st.ClassDef1.classDefs[orig]
                if orig in st.ClassDef2.classDefs:
                    st.ClassDef2.classDefs[new] = st.ClassDef2.classDefs[orig]
        elif t == 4:
            if orig in st.BaseCoverage.glyphs:
                rec = copy.deepcopy(st.BaseArray.BaseRecord[st.BaseCoverage.glyphs.index(orig)])
                for a in rec.BaseAnchor:
                    if a is not None:
                        a.XCoordinate, a.YCoordinate = anchor_fn(a.XCoordinate, a.YCoordinate)
                i = cov_insert(st.BaseCoverage, new, gids)
                if i is not None:
                    st.BaseArray.BaseRecord.insert(i, rec)
                    st.BaseArray.BaseCount = len(st.BaseArray.BaseRecord)
        elif t == 8:
            if st.Format == 3:
                for cov in st.BacktrackCoverage + st.InputCoverage + st.LookAheadCoverage:
                    if orig in cov.glyphs:
                        cov_insert(cov, new, gids)
            elif st.Format == 2:
                for cd in (st.BacktrackClassDef, st.InputClassDef, st.LookAheadClassDef):
                    if cd and orig in cd.classDefs:
                        cd.classDefs[new] = cd.classDefs[orig]
                if orig in st.Coverage.glyphs:
                    cov_insert(st.Coverage, new, gids)
            else:
                raise NotImplementedError("ChainContextPos format 1")


def add_gsub_feature(font, tags_lookup, names=None):
    """Append features (tag -> lookup index) to every LangSys, keeping FeatureList sorted."""
    gsub = font["GSUB"].table
    fl = gsub.FeatureList
    old = list(fl.FeatureRecord)
    added = []
    for tag, li in tags_lookup.items():
        fr = ot.FeatureRecord()
        fr.FeatureTag = tag
        fr.Feature = ot.Feature()
        fr.Feature.FeatureParams = None
        if names and tag in names:
            fp = ot.FeatureParamsStylisticSet()
            fp.Version = 0
            fp.UINameID = names[tag]
            fr.Feature.FeatureParams = fp
        fr.Feature.LookupListIndex = [li]
        fr.Feature.LookupCount = 1
        added.append(fr)
    allrecs = old + added
    order = sorted(range(len(allrecs)), key=lambda i: (allrecs[i].FeatureTag, i))
    remap = {o: n for n, o in enumerate(order)}
    fl.FeatureRecord = [allrecs[i] for i in order]
    fl.FeatureCount = len(fl.FeatureRecord)
    new_idx = [remap[len(old) + k] for k in range(len(added))]
    for sr in gsub.ScriptList.ScriptRecord:
        langs = [sr.Script.DefaultLangSys] + [l.LangSys for l in sr.Script.LangSysRecord]
        for ls in langs:
            if ls is None:
                continue
            idx = [remap[i] for i in ls.FeatureIndex] + new_idx
            ls.FeatureIndex = sorted(idx)
            ls.FeatureCount = len(ls.FeatureIndex)
            if ls.ReqFeatureIndex != 0xFFFF:
                ls.ReqFeatureIndex = remap[ls.ReqFeatureIndex]


# ============================================================ base prep

class BaseGlyph:
    """Master-independent description of a glyph."""

    def __init__(self, name, kind, adv, body=None, sats=None, emb_factor=1.0):
        self.name = name
        self.kind = kind            # 'base' | 'mark' | 'empty'
        self.adv = adv
        self.body = body or []      # contours
        self.sats = sats or []      # dicts: contours, cx, push, emb
        self.emb_factor = emb_factor
        self.joins = set()          # (contour, point) on the connecting strokes: always full weight
        self.join_edge = {}         # (contour, point) on a stroke's top (+1) / bottom (-1) edge


def is_dotlike(name):
    return "Dot" in name


def mark_factor(name):
    return DOT_EMB if is_dotlike(name) else MARK_EMB


def skia_path(contours):
    from fontTools.pens.basePen import BasePen
    p = skia.Path()

    class _Pen(BasePen):
        def _moveTo(self, pt): p.moveTo(*pt)
        def _lineTo(self, pt): p.lineTo(*pt)
        def _curveToOne(self, a, b, c): p.cubicTo(*a, *b, *c)
        def _qCurveToOne(self, a, b): p.quadTo(*a, *b)
        def _closePath(self): p.close()
    G.draw_contours(contours, _Pen(None))
    return p


def vertical_gap(body_path, bb, up, limit=1500):
    x0, y0, x1, y1 = bb
    w = x1 - x0
    best = None
    for f in (0.2, 0.35, 0.5, 0.65, 0.8):
        x = x0 + w * f
        for d in range(4, limit, 8):
            y = y1 + d if up else y0 - d
            if body_path.contains(x, y):
                best = d if best is None else min(best, d)
                break
    return best


def flatten(font, name):
    glyf = font["glyf"]
    gdef = font["GDEF"].table.GlyphClassDef.classDefs
    adv = font["hmtx"][name][0]
    is_mark = gdef.get(name) == 3
    leaves = []  # (leafname, [transforms outer->inner], satellite group or None, root name)
    counter = [0]

    def walk(n, xforms, group, root):
        g = glyf[n]
        if g.isComposite():
            for c in g.components:
                cname, t = c.getComponentInfo()
                grp, rt = group, root
                if grp is None and not is_mark and gdef.get(cname) == 3:
                    counter[0] += 1
                    grp, rt = counter[0], cname
                walk(cname, xforms + [Transform(*t)], grp, rt)
        elif g.numberOfContours != 0:
            leaves.append((n, xforms, group, root))

    walk(name, [], None, name)
    if not leaves:
        return BaseGlyph(name, "empty", adv)
    body_leaves = [(glyf[n], glyf, x) for n, x, g, _ in leaves if g is None]
    body = G.union_contours(body_leaves) if body_leaves else []
    groups = {}
    for n, x, g, root in leaves:
        if g is not None:
            groups.setdefault(g, (root, []))[1].append((glyf[n], glyf, x))
    sats = []
    for g, (root, pieces) in sorted(groups.items()):
        sc = G.union_contours(pieces)
        if body:
            inter = G.contours_to_pathops(body)
            import pathops
            ip = pathops.op(inter, G.contours_to_pathops(sc), pathops.PathOp.INTERSECTION)
            if abs(ip.area) > 1:
                body = G.union_of([body, sc])  # touching the body: part of the body
                continue
        sats.append({"contours": sc, "root": root, "emb": mark_factor(root)})
    bg = BaseGlyph(name, "mark" if is_mark else "base", adv, body, sats,
                   mark_factor(name) if is_mark else 1.0)
    return bg


def place_satellites(bg):
    """Decide which way each satellite moves to keep its gap as the body thickens."""
    if not bg.body:
        for s in bg.sats:
            s["push"] = 0.0
            x0, y0, x1, y1 = G.bbox(s["contours"])
            s["cx"] = (x0 + x1) / 2
        return
    bp = skia_path(bg.body)
    for s in bg.sats:
        bb = G.bbox(s["contours"])
        s["cx"] = (bb[0] + bb[2]) / 2
        up = vertical_gap(bp, bb, True)
        down = vertical_gap(bp, bb, False)
        need = 2 * EMB_Y_900 * (1 + s["emb"])  # both sides' growth, with margin
        if up is None and down is None:
            s["push"] = 0.0
            continue
        if down is not None and (up is None or down <= up):
            sign, near, far = 1, down, up
        else:
            sign, near, far = -1, up, down
        p = 1.0 if far is None else max(0.0, min(1.0, (far - near) / need))
        s["push"] = sign * p


def find_joins(bg):
    """Points of the connecting strokes (inside the 70-unit overlap at either edge,
    on the stroke's top/bottom or its cut end) are never thinned."""
    n = bg.name
    bg.joins = set()
    bg.join_edge = {}
    if bg.kind != "base" or not bg.body:
        return
    if not (n == "uni0640" or any(t in n for t in (".init", ".medi", ".fina"))):
        return
    left = n == "uni0640" or ".init" in n or ".medi" in n
    right = n == "uni0640" or ".medi" in n or ".fina" in n
    for ci, c in enumerate(bg.body):
        for pi, p in enumerate(c):
            x, y = p[0], p[1]
            on_stroke = abs(y) <= 1 or abs(y - JOIN_TOP) <= 1
            if left and x <= 2 and (on_stroke or x <= -JOIN_OVERHANG + 1):
                bg.joins.add((ci, pi))
            if right and x >= bg.adv - 2 and (on_stroke or x >= bg.adv + JOIN_OVERHANG - 1):
                bg.joins.add((ci, pi))
    # follow each stroke edge inward along its straight run, plus the point where it turns
    for ci, pi in list(bg.joins):
        x, y = bg.body[ci][pi][0], bg.body[ci][pi][1]
        if -JOIN_OVERHANG + 1 < x < bg.adv + JOIN_OVERHANG - 1 and bg.body[ci][pi][2]:
            if abs(y - JOIN_TOP) <= 1:
                bg.join_edge[(ci, pi)] = 1
            elif abs(y) <= 1:
                bg.join_edge[(ci, pi)] = -1
        c = bg.body[ci]
        n_ = len(c)
        y0 = c[pi][1]
        if not (abs(y0) <= 1 or abs(y0 - JOIN_TOP) <= 1):
            continue
        for step in (1, -1):
            k = pi
            for _ in range(n_):
                k = (k + step) % n_
                bg.joins.add((ci, k))
                if not (c[k][2] and abs(c[k][1] - y0) <= 1):
                    break
                if -JOIN_OVERHANG + 1 < c[k][0] < bg.adv + JOIN_OVERHANG - 1:
                    bg.join_edge[(ci, k)] = 1 if y0 > JOIN_TOP / 2 else -1


def contours_overlap(contours):
    if not contours:
        return False
    raw = abs(G.contours_to_pathops(contours).area)
    union = G.true_area(contours)
    return abs(raw - union) > max(40, 0.0005 * union)


def _bridges(groups, d):
    """Small bridges where outer contours of different pieces come within 2d of each
    other: pairwise intersections of the pieces grown by d. Edges elsewhere are untouched."""
    import pathops
    outers = []
    for gi, cl in enumerate(groups):
        for c in cl:
            if G.signed_area(c) < 0:
                outers.append((gi, G.contours_to_pathops([G.embolden_contour(c, d, d)])))
    found = []
    for i in range(len(outers)):
        for j in range(i + 1, len(outers)):
            gi, a = outers[i]
            gj, b2 = outers[j]
            x = pathops.op(a, b2, pathops.PathOp.INTERSECTION)
            if abs(x.area) > 0.5:
                found.append((gi, gj, G.pathops_to_contours(x)))
    return found


def fuse_touching(bg):
    """Pieces that touch or nearly touch in Jomhuria (the % zeros and slash, three-dot
    clusters, the ring of U+06BC) would overlap once grown. Bridge them on the base with
    the smallest reach (3..21 units) that keeps every master overlap-free."""
    if bg.kind == "empty":
        return False
    pieces = [[c] for c in bg.body if G.signed_area(c) < 0] + [s["contours"] for s in bg.sats]
    if len(pieces) < 2:
        return False
    tests = [calibrate_guess(w) for w in (78, 84, 100)]

    def bad(g):
        return any(contours_overlap(transform_glyph(g, s, *emb(wg))[0]) for s in tests for wg in (400, 900))
    if not bad(bg):
        return False
    orig_body, orig_sats = bg.body, bg.sats
    for d in (3, 6, 10, 15, 21):
        groups = [orig_body] + [s["contours"] for s in orig_sats]
        bridges = _bridges(groups, d)
        merged = {0}
        extra_body = []
        sat_extra = {}
        for gi, gj, cl in bridges:
            if gi == gj:
                if gi == 0:
                    extra_body += cl
                else:
                    sat_extra.setdefault(gi, []).extend(cl)
            else:
                merged |= {gi, gj} if 0 in (gi, gj) else set()
                extra_body += cl if 0 in (gi, gj) else []
                if 0 not in (gi, gj):
                    sat_extra.setdefault(gi, []).extend(cl)
                    sat_extra.setdefault(gj, []).extend(cl)
        body = G.union_of([orig_body, extra_body] + [orig_sats[k - 1]["contours"] for k in merged if k])
        keep = []
        for k, s in enumerate(orig_sats, 1):
            if k in merged:
                continue
            sc = G.union_of([s["contours"], sat_extra.get(k, [])]) if k in sat_extra else s["contours"]
            keep.append(dict(s, contours=sc))
        bg.body, bg.sats = body, keep
        if not bad(bg):
            return d
    bg.body, bg.sats = orig_body, orig_sats  # nothing helped: keep Jomhuria's pieces
    return False


def calibrate_guess(w):
    return w / 100 - 2 * SHIFT_K * EMB_X_900 / 1000


def fix_high_hamza(font, base):
    """U+0674 is a spacing letter (Jawi, Kazakh): Jomhuria drew it as a combining mark.
    Use the hamza (U+0621) raised to sit at the height of the joins."""
    if "uni0674" not in base:
        return
    hz = base["uni0621"]
    body = [[[p[0], p[1] + 520, p[2]] for p in c] for c in hz.body]
    base["uni0674"] = BaseGlyph("uni0674", "base", hz.adv, body, [])
    font["hmtx"]["uni0674"] = (hz.adv, font["hmtx"]["uni0621"][1])
    font["GDEF"].table.GlyphClassDef.classDefs["uni0674"] = 1
    gpos = font["GPOS"].table
    for lk in gpos.LookupList.Lookup:
        for st in lk.SubTable:
            for cov, arr, rec in (("MarkCoverage", "MarkArray", "MarkRecord"),
                                  ("Mark1Coverage", "Mark1Array", "MarkRecord")):
                c = getattr(st, cov, None)
                if c is not None and "uni0674" in c.glyphs:
                    i = c.glyphs.index("uni0674")
                    del c.glyphs[i]
                    a = getattr(st, arr)
                    del getattr(a, rec)[i]
                    a.MarkCount = len(getattr(a, rec))


def fix_zero_width_bases(font, base):
    """Spacing characters drawn with zero advance in Jomhuria (e.g. U+2038 caret)."""
    cmap = font.getBestCmap()
    gdef = font["GDEF"].table.GlyphClassDef.classDefs
    import unicodedata
    for u, g in cmap.items():
        bg = base[g]
        if bg.kind != "base" or bg.adv != 0 or gdef.get(g) == 3:
            continue
        if unicodedata.category(chr(u)).startswith("M") or unicodedata.category(chr(u)) in ("Cf", "Zs", "Cc"):
            continue
        x0, _, x1, _ = G.bbox(bg.body + [c for s in bg.sats for c in s["contours"]])
        dx = 60 - x0
        for c in bg.body + [c for s in bg.sats for c in s["contours"]]:
            for p in c:
                p[0] += dx
        bg.adv = round(x1 - x0 + 120)
        font["hmtx"][g] = (bg.adv, 60)


def tatweel_glyph():
    T, o = TATWEEL_ADV, JOIN_OVERHANG
    c = [[-o, 0, True], [-o, JOIN_TOP, True], [T + o, JOIN_TOP, True], [T + o, 0, True]]
    return BaseGlyph("uni0640", "base", T, [c], [])


def make_long(bg, spec, newname):
    body = [[p[:] for p in c] for c in bg.body]
    sats = [dict(s, contours=[[p[:] for p in c] for c in s["contours"]]) for s in bg.sats]
    cuts = []
    for (lo, hi), L in spec:
        best = G.best_cut(body, lo, hi)
        if best is None:
            raise RuntimeError(f"no cut for {bg.name}")
        cuts.append((best[1], L, best[0]))
    total = 0
    for cx, L, _ in sorted(cuts, reverse=True):
        body = [G.stretch_contour(c, cx, L) for c in body]
        for s in sats:
            x0, _, x1, _ = G.bbox(s["contours"])
            dx = L if x0 >= cx else (0 if x1 <= cx else L / 2)
            for c in s["contours"]:
                for p in c:
                    p[0] += dx
        total += L
    nb = BaseGlyph(newname, bg.kind, bg.adv + total, body, sats, bg.emb_factor)

    def anchor_fn(x, y):
        return x + sum(L for cx, L, _ in cuts if x > cx), y
    return nb, cuts, anchor_fn


def prep_base():
    font = TTFont(SRC)
    for t in ("DSIG", "prep", "fpgm", "cvt "):
        if t in font:
            del font[t]
    gsub = font["GSUB"].table

    # 1. tatweel: stop rlig from collapsing runs into fixed-length ligatures
    drop = set()
    for li, lk in enumerate(gsub.LookupList.Lookup):
        for st in lk.SubTable:
            if lk.LookupType == 4:
                for first, ligs in st.ligatures.items():
                    for lg in ligs:
                        if "uni0640" in [first] + lg.Component or first.startswith("uni0640.") \
                                or "Tatweel" in lg.LigGlyph:
                            drop.add(li)
            if lk.LookupType == 1 and st.mapping.get("uni0640", "").startswith("uni0640."):
                drop.add(li)
    for fr in gsub.FeatureList.FeatureRecord:
        if fr.FeatureTag == "rlig":
            fr.Feature.LookupListIndex = [i for i in fr.Feature.LookupListIndex if i not in drop]
            fr.Feature.LookupCount = len(fr.Feature.LookupListIndex)
    print("dropped tatweel lookups:", sorted(drop))

    # 2. flatten every glyph
    order = font.getGlyphOrder()
    base = {}
    for n in order:
        base[n] = flatten(font, n)
    base["uni0640"] = tatweel_glyph()
    fix_high_hamza(font, base)
    fix_zero_width_bases(font, base)
    font["hmtx"]["uni0640"] = (TATWEEL_ADV, -JOIN_OVERHANG)
    # tatweel takes the mark anchors of Jomhuria's single kashida, centred on the new length
    clone_in_gpos(font, "uni0640.1", "uni0640",
                  lambda x, y: (round(x * TATWEEL_ADV / 270), y))

    # 3. elongated alternates
    mapping = {}
    new_names = []
    for n, spec in ALTS.items():
        if n not in base:
            continue
        newname = n + ALT_SUFFIX
        nb, cuts, afn = make_long(base[n], spec, newname)
        print(f"  {newname}: cuts " + ", ".join(f"x={c:.0f} +{L} (slope {s:.2f})" for c, L, s in cuts))
        base[newname] = nb
        mapping[n] = newname
        new_names.append((n, newname, afn))
    font.setGlyphOrder(order + [nn for _, nn, _ in new_names])
    glyf = font["glyf"]
    for n, nn, _ in new_names:
        glyf.glyphs[nn] = Glyph()
        font["hmtx"][nn] = (base[nn].adv, 0)
        font["GDEF"].table.GlyphClassDef.classDefs[nn] = font["GDEF"].table.GlyphClassDef.classDefs.get(n, 1)
        clone_in_gpos(font, n, nn, afn)
    if "post" in font:
        font["post"].extraNames = []
    lk = ot.Lookup()
    lk.LookupType = 1
    lk.LookupFlag = 0
    st = ot.SingleSubst()
    st.mapping = mapping
    lk.SubTable = [st]
    lk.SubTableCount = 1
    gsub.LookupList.Lookup.append(lk)
    gsub.LookupList.LookupCount = len(gsub.LookupList.Lookup)
    li = len(gsub.LookupList.Lookup) - 1
    ss_name = font["name"].addMultilingualName({"en": "Elongated letters"}, mac=False)
    add_gsub_feature(font, {"jalt": li, "ss02": li}, names={"ss02": ss_name})

    for bg in base.values():
        place_satellites(bg)
    for bg in base.values():
        find_joins(bg)
    fused = {bg.name: d for bg in base.values() for d in [fuse_touching(bg)] if d}
    print(f"fused touching pieces in {len(fused)} glyphs:", fused)
    for n in fused:
        find_joins(base[n])
    return font, base


# ============================================================ masters

def calibrate(font, base, wdth, wght):
    """Horizontal scale so a typical headline sets at `wdth`% of Jomhuria's width."""
    dx, _ = emb(wght)
    path = os.path.join(BUILD, "_base_shaping.ttf")
    if not os.path.exists(path):
        f = copy.deepcopy(font)
        # temporary outlines are irrelevant for shaping; widths come from hmtx
        f.save(path)
    blob = hb.Blob.from_file_path(path)
    hfont = hb.Font(hb.Face(blob))
    order = font.getGlyphOrder()
    total = 0
    n_spacing = 0
    for line in SAMPLE:
        buf = hb.Buffer()
        buf.add_str(line)
        buf.guess_segment_properties()
        hb.shape(hfont, buf, {"kern": False})
        for info in buf.glyph_infos:
            a = font["hmtx"][order[info.codepoint]][0]
            total += a
            if a > 0:
                n_spacing += 1
    return (wdth / 100 * total - 2 * SHIFT_K * dx * n_spacing) / total


def transform_glyph(bg, s, dx, dy):
    sm = s ** SAT_SCALE_EXP
    contours = []
    if bg.kind == "empty":
        # word spaces are condensed less than letters, or words run together
        return [], (round(s ** SAT_SCALE_EXP * bg.adv + 2 * SHIFT_K * dx) if bg.adv else 0)
    if bg.kind == "mark":
        f = bg.emb_factor
        pre = [[[p[0] * sm, p[1], p[2]] for p in c] for c in bg.body]
        facs = G.gap_factors(pre, max(dx, dy) * f, GAP_FLOOR * f, GAP_KEEP)
        for cc, fa in zip(pre, facs):
            contours.append(G.embolden_contour(cc, dx * f, dy * f, fa))
        return contours, (round(s * bg.adv) if bg.adv else 0)
    shift = SHIFT_K * dx
    # condense first (satellites less), then grow every contour with gap-aware factors
    pre, embs, offs = [], [], []
    for c in bg.body:
        pre.append([[p[0] * s, p[1], p[2]] for p in c])
        embs.append(1.0)
        offs.append(0.0)
    for sat in bg.sats:
        cx = sat["cx"]
        for c in sat["contours"]:
            pre.append([[s * cx + sm * (p[0] - cx), p[1] + sat["push"] * (dy + dy * sat["emb"]), p[2]] for p in c])
            embs.append(sat["emb"])
    facs = G.gap_factors(pre, max(dx, dy), GAP_FLOOR, GAP_KEEP, pinned=bg.joins)
    grown = [G.embolden_contour(c, dx * e, dy * e, fa) for c, e, fa in zip(pre, embs, facs)]
    # pieces that still run into each other give up their growth where they collide
    for _ in range(4):
        if len(grown) < 2 or not contours_overlap(grown):
            break
        changed = False
        for i, c in enumerate(grown):
            others = skia_path([g for j, g in enumerate(grown) if j != i])
            for k, p in enumerate(c):
                if facs[i][k] > 0 and others.contains(p[0], p[1]):
                    for m in (-2, -1, 0, 1, 2):
                        if (i, (k + m) % len(c)) not in bg.joins:
                            facs[i][(k + m) % len(c)] = 0.0
                    changed = True
        if not changed:
            break
        grown = [G.embolden_contour(c, dx * e, dy * e, fa) for c, e, fa in zip(pre, embs, facs)]
    # stroke edges stay perfectly flat: exact vertical offset, no sideways drift
    for (ci, pi), side in bg.join_edge.items():
        grown[ci][pi][0] = pre[ci][pi][0]
        edge = (JOIN_TOP + dy) if side > 0 else -dy
        grown[ci][pi][1] = edge
        # the fillet next to a junction must not dip back through the raised edge
        n_ = len(grown[ci])
        for m in (-3, -2, -1, 1, 2, 3):
            k = (pi + m) % n_
            if (ci, k) in bg.join_edge or abs(pre[ci][k][1] - (JOIN_TOP if side > 0 else 0)) > 80:
                continue
            if side > 0 and grown[ci][k][1] < edge:
                grown[ci][k][1] = edge
            elif side < 0 and grown[ci][k][1] > edge:
                grown[ci][k][1] = edge
    if contours_overlap(grown):
        grown = [G.collapse_small_loops(cc) for cc in grown]
    for cc in grown:
        contours.append([[p[0] + shift, p[1], p[2]] for p in cc])
    adv = round(s * bg.adv + 2 * shift) if bg.adv else 0
    return contours, adv


def make_glyph(contours, glyf):
    g = Glyph()
    if not contours:
        g.numberOfContours = 0
        return g
    pts, flags, ends = [], [], []
    for c in contours:
        for p in c:
            pts.append((round(p[0]), round(p[1])))
            flags.append(1 if p[2] else 0)
        ends.append(len(pts) - 1)
    g.numberOfContours = len(contours)
    g.coordinates = GlyphCoordinates(pts)
    g.flags = bytearray(flags)
    g.endPtsOfContours = ends
    g.program = ttProgram.Program()
    g.program.fromBytecode(b"")
    g.recalcBounds(glyf)
    return g


def mark_class_sides(font, base):
    """For each (lookup, subtable, class): +1 if its marks sit above their anchor, -1 below,
    plus the average emboldening factor of those marks."""
    res = {}
    gpos = font["GPOS"].table
    for li, lk in enumerate(gpos.LookupList.Lookup):
        for si, st in enumerate(lk.SubTable):
            if lk.LookupType not in (4, 6):
                continue
            cov = st.MarkCoverage if lk.LookupType == 4 else st.Mark1Coverage
            arr = st.MarkArray if lk.LookupType == 4 else st.Mark1Array
            votes = {}
            for g, rec in zip(cov.glyphs, arr.MarkRecord):
                bg = base[g]
                bb = G.bbox(bg.body + [c for s in bg.sats for c in s["contours"]])
                if bb is None:
                    continue
                side = 1 if (bb[1] + bb[3]) / 2 > rec.MarkAnchor.YCoordinate else -1
                v = votes.setdefault(rec.Class, [0, []])
                v[0] += side
                v[1].append(bg.emb_factor)
            for cls, (side, fs) in votes.items():
                res[(li, si, cls)] = (1 if side >= 0 else -1, sum(fs) / len(fs))
    return res


def transform_gpos(font, base, s, dx, dy, sides):
    sm = s ** SAT_SCALE_EXP
    shift = SHIFT_K * dx

    def vr(v):
        if v is None:
            return
        for a in ("XPlacement", "XAdvance"):
            if hasattr(v, a) and getattr(v, a):
                setattr(v, a, round(getattr(v, a) * s))

    def base_x(g, x):
        bg = base[g]
        if bg.kind == "mark":
            return round(x * sm)
        return round(x * s + shift)

    gpos = font["GPOS"].table
    for li, lk in enumerate(gpos.LookupList.Lookup):
        for si, st in enumerate(lk.SubTable):
            t = lk.LookupType
            if t == 1:
                if st.Format == 1:
                    vr(st.Value)
                else:
                    for v in st.Value:
                        vr(v)
            elif t == 2:
                if st.Format == 1:
                    for ps in st.PairSet:
                        for r in ps.PairValueRecord:
                            vr(getattr(r, "Value1", None))
                            vr(getattr(r, "Value2", None))
                else:
                    for c1 in st.Class1Record:
                        for c2 in c1.Class2Record:
                            vr(getattr(c2, "Value1", None))
                            vr(getattr(c2, "Value2", None))
            elif t == 4:
                for g, rec in zip(st.MarkCoverage.glyphs, st.MarkArray.MarkRecord):
                    rec.MarkAnchor.XCoordinate = round(rec.MarkAnchor.XCoordinate * sm)
                for g, rec in zip(st.BaseCoverage.glyphs, st.BaseArray.BaseRecord):
                    gf = base[g].emb_factor
                    for cls, a in enumerate(rec.BaseAnchor):
                        if a is None:
                            continue
                        side, mf = sides.get((li, si, cls), (1, MARK_EMB))
                        a.XCoordinate = base_x(g, a.XCoordinate)
                        a.YCoordinate = round(a.YCoordinate + side * (dy * gf + dy * mf))
            elif t == 6:
                for g, rec in zip(st.Mark1Coverage.glyphs, st.Mark1Array.MarkRecord):
                    rec.MarkAnchor.XCoordinate = round(rec.MarkAnchor.XCoordinate * sm)
                for g, rec in zip(st.Mark2Coverage.glyphs, st.Mark2Array.Mark2Record):
                    gf = base[g].emb_factor
                    for cls, a in enumerate(rec.Mark2Anchor):
                        if a is None:
                            continue
                        side, mf = sides.get((li, si, cls), (1, MARK_EMB))
                        a.XCoordinate = round(a.XCoordinate * sm)
                        a.YCoordinate = round(a.YCoordinate + side * (dy * gf + dy * mf))


def build_master(font, base, sides, s, wght, remove_overlaps=False):
    dx, dy = emb(wght)
    f = copy.deepcopy(font)
    glyf = f["glyf"]
    hmtx = f["hmtx"]
    for n in f.getGlyphOrder():
        contours, adv = transform_glyph(base[n], s, dx, dy)
        g = make_glyph(contours, glyf)
        glyf.glyphs[n] = g
        hmtx[n] = (adv, g.xMin if g.numberOfContours else 0)
    transform_gpos(f, base, s, dx, dy, sides)
    if remove_overlaps:
        removeOverlaps(f)
        for n in f.getGlyphOrder():
            g = glyf[n]
            if g.numberOfContours > 0:
                glyf.glyphs[n] = g = dedupe_points(g, glyf)
                hmtx[n] = (hmtx[n][0], g.xMin)
    return f


def dedupe_points(g, glyf):
    """Statics only: drop zero-length segments left by rounding."""
    coords, ends, flags = g.getCoordinates(glyf)
    contours, st = [], 0
    for e in ends:
        c = [[x, y, bool(fl & 1)] for (x, y), fl in zip(coords[st:e + 1], flags[st:e + 1])]
        st = e + 1
        out = []
        for p in c:
            if out and p[:2] == out[-1][:2]:
                if p[2]:
                    out[-1][2] = True
                continue
            out.append(p)
        while len(out) > 1 and out[-1][:2] == out[0][:2]:
            out[0][2] = out[0][2] or out[-1][2]
            out.pop()
        if len(out) >= 3:
            contours.append(out)
    return make_glyph(contours, glyf)


def find_overlaps(font):
    """Glyphs whose contours intersect each other or themselves."""
    glyf = font["glyf"]
    bad = []
    for n in font.getGlyphOrder():
        g = glyf[n]
        if g.numberOfContours <= 0:
            continue
        coords, ends, flags = g.getCoordinates(glyf)
        contours, st = [], 0
        for e in ends:
            contours.append([[x, y, bool(fl & 1)] for (x, y), fl in zip(coords[st:e + 1], flags[st:e + 1])])
            st = e + 1
        # raw signed area (curves included) equals the filled area only when nothing overlaps
        raw = abs(G.contours_to_pathops(contours).area)
        union = G.true_area(contours)
        if abs(raw - union) > max(40, 0.0005 * union):
            bad.append(n)
    return bad


# ============================================================ naming / finishing

LICENSE = ("This Font Software is licensed under the SIL Open Font License, Version 1.1. "
           "This license is available with a FAQ at: https://openfontlicense.org")


def finish(font, family, style, ps, weight, width_class, typo=None, variable=False):
    jom_copyright = font["name"].getDebugName(0)
    name = font["name"]
    name.names = [r for r in name.names if r.nameID > 255 and r.platformID == 3]
    cr = jom_copyright.strip() + " Copyright 2026 melad (Melad Display modifications)."
    vals = {
        0: cr, 1: family, 2: style,
        3: f"{VERSION:.3f};MELD;{ps}", 4: f"{family} {style}".replace(" Regular", ""),
        5: f"Version {VERSION:.3f}", 6: ps,
        8: "melad", 9: "KB-Studio, Lasse Fister, Sorkin Type, Khaled Hosny (Jomhuria); melad (Melad Display)",
        10: "Melad Display is a condensed, heavy Arabic headline face derived from Jomhuria.",
        13: LICENSE, 14: "https://openfontlicense.org",
    }
    if typo:
        vals[16], vals[17] = typo
    for k, v in vals.items():
        name.setName(v, k, 3, 1, 0x409)
    os2 = font["OS/2"]
    os2.usWeightClass = weight
    os2.usWidthClass = width_class
    os2.achVendID = "MELD"
    os2.fsType = 0
    os2.fsSelection = (os2.fsSelection & ~0b1100001) | (1 << 7) | (1 << 6 if style == "Regular" else 0)
    head = font["head"]
    head.fontRevision = VERSION
    head.macStyle = 0
    hhea = font["hhea"]
    hhea.ascent, hhea.descent, hhea.lineGap = 1840, -1160, 0
    os2.sTypoAscender, os2.sTypoDescender, os2.sTypoLineGap = 1840, -1160, 0
    glyf = font["glyf"]
    ymax = max(glyf[g].yMax for g in font.getGlyphOrder() if glyf[g].numberOfContours)
    ymin = min(glyf[g].yMin for g in font.getGlyphOrder() if glyf[g].numberOfContours)
    os2.usWinAscent = max(1840, ymax)
    os2.usWinDescent = max(1160, -ymin)
    gasp = newTable("gasp")
    gasp.version = 1
    gasp.gaspRange = {0xFFFF: 0x000F}
    font["gasp"] = gasp
    if "post" in font:
        font["post"].formatType = 2.0
    font["head"].flags |= (1 << 3)
    # unhinted, but switch on smart dropout control for rasterisers that use it
    prep = newTable("prep")
    prep.program = ttProgram.Program()
    prep.program.fromAssembly(["PUSHW[ ]", "511", "SCANCTRL[ ]", "PUSHB[ ]", "4", "SCANTYPE[ ]"])
    font["prep"] = prep
    rebuild_cmap(font)
    advs = [a for a, _ in font["hmtx"].metrics.values() if a > 0]
    os2.xAvgCharWidth = round(sum(advs) / len(advs))
    for fr in font["GSUB"].table.FeatureList.FeatureRecord:
        if fr.FeatureTag == "ss01" and fr.Feature.FeatureParams is None:
            fp = ot.FeatureParamsStylisticSet()
            fp.Version = 0
            fp.UINameID = font["name"].addMultilingualName({"en": "Small kasra and kasratan"}, mac=False)
            fr.Feature.FeatureParams = fp


def rebuild_cmap(font):
    from fontTools.ttLib.tables._c_m_a_p import CmapSubtable
    best = font.getBestCmap()
    tables = []
    bmp = {u: g for u, g in best.items() if u <= 0xFFFF}
    for pid, eid in ((0, 3), (3, 1)):
        t = CmapSubtable.newSubtable(4)
        t.platformID, t.platEncID, t.language, t.cmap = pid, eid, 0, dict(bmp)
        tables.append(t)
    if any(u > 0xFFFF for u in best):
        for pid, eid in ((0, 4), (3, 10)):
            t = CmapSubtable.newSubtable(12)
            t.platformID, t.platEncID, t.language, t.cmap = pid, eid, 0, dict(best)
            tables.append(t)
    font["cmap"].tables = tables


def drop_mac_names(font):
    font["name"].names = [r for r in font["name"].names if r.platformID != 1]


def save_woff2(ttf_path, out_dir):
    f = TTFont(ttf_path)
    f.flavor = "woff2"
    out = os.path.join(out_dir, os.path.basename(ttf_path).replace(".ttf", ".woff2"))
    f.save(out)
    return out


# ============================================================ main

def main():
    os.makedirs(BUILD, exist_ok=True)
    stale = os.path.join(BUILD, "_base_shaping.ttf")
    if os.path.exists(stale):
        os.remove(stale)
    for d in ("ttf", "woff2", "variable"):
        os.makedirs(os.path.join(FONTS, d), exist_ok=True)

    print("preparing base ...")
    font, base = prep_base()
    sides = mark_class_sides(font, base)
    # new glyphs need real outlines in the shaping copy used for width calibration
    for n in font.getGlyphOrder():
        if n.endswith(ALT_SUFFIX) or n == "uni0640":
            font["glyf"].glyphs[n] = make_glyph(base[n].body, font["glyf"])
    scales = {}
    for w in sorted(set(WDTH_MASTERS) | set(STATICS)):
        for wg in WGHT_MASTERS:
            scales[(w, wg)] = calibrate(font, base, w, wg)
    print("horizontal scales:", {k: round(v, 4) for k, v in scales.items()})

    # ---- variable font
    ds = DesignSpaceDocument()
    for tag, name, lo, df, hi in (("wdth", "Width", 78, DEFAULT[0], 100), ("wght", "Weight", 400, DEFAULT[1], 900)):
        a = AxisDescriptor()
        a.tag, a.name, a.minimum, a.default, a.maximum = tag, name, lo, df, hi
        ds.addAxis(a)
    report = {}
    for w in WDTH_MASTERS:
        for wg in WGHT_MASTERS:
            print(f"master wdth={w} wght={wg} ...")
            m = build_master(font, base, sides, scales[(w, wg)], wg)
            finish(m, FAMILY, "Regular", f"{PS_FAMILY}-Master{w}{wg}", wg, 4)
            p = os.path.join(BUILD, f"master_{w}_{wg}.ttf")
            m.save(p)
            report[(w, wg)] = find_overlaps(TTFont(p))
            src = SourceDescriptor()
            src.path = p
            src.location = {"Width": w, "Weight": wg}
            src.name = f"master_{w}_{wg}"
            ds.addSource(src)
    for w, wn in ((78, "Narrow"), (84, "Condensed"), (90, "Semi"), (100, "")):
        for wg, gn in ((400, "Regular"), (700, "Bold"), (900, "Black")):
            inst = InstanceDescriptor()
            inst.familyName = FAMILY
            sn = f"{wn} {gn}".strip()
            if wn and gn == "Regular":
                sn = wn
            inst.styleName = sn
            inst.location = {"Width": w, "Weight": wg}
            ds.addInstance(inst)
    dsp = os.path.join(BUILD, "MeladDisplay.designspace")
    ds.write(dsp)
    print("building variable font ...")
    vf, _, _ = varLib.build(dsp)
    finish(vf, FAMILY, "Regular", f"{PS_FAMILY}-CondensedBlack", 900, 4, typo=(FAMILY, "Condensed Black"),
           variable=True)
    vf["name"].setName(PS_FAMILY, 25, 3, 1, 0x409)
    flag_overlaps(vf, set().union(*report.values()))
    buildStatTable(vf, [
        dict(tag="wdth", name="Width", values=[
            dict(value=78, name="Narrow"), dict(value=84, name="Condensed"),
            dict(value=90, name="Semi"), dict(value=100, name="Normal", flags=0x2)]),
        dict(tag="wght", name="Weight", values=[
            dict(value=400, name="Regular", flags=0x2), dict(value=700, name="Bold"),
            dict(value=900, name="Black")]),
    ], macNames=False)
    drop_mac_names(vf)
    vpath = os.path.join(FONTS, "variable", "MeladDisplay[wdth,wght].ttf")
    vf.save(vpath)
    save_woff2(vpath, os.path.join(FONTS, "variable"))

    # ---- statics (exact, not interpolated), overlaps removed
    for w, wn in STATICS.items():
        print(f"static wdth={w} ...")
        m = build_master(font, base, sides, scales[(w, 900)], 900, remove_overlaps=True)
        fam = f"{FAMILY} {wn}".strip()
        ps = f"{PS_FAMILY}{wn}-Black"
        finish(m, fam + " Black", "Regular", ps, 900, {78: 3, 84: 4, 90: 5}[w],
               typo=(FAMILY, f"{wn} Black".strip()))
        p = os.path.join(FONTS, "ttf", f"{PS_FAMILY}{wn}-Black.ttf")
        m.save(p)
        save_woff2(p, os.path.join(FONTS, "woff2"))
        left = find_overlaps(TTFont(p))
        print(f"  overlaps after removal: {len(left)}")

    print("variable-master overlap report (glyphs flagged OVERLAP_SIMPLE):")
    for k, v in report.items():
        print("  ", k, len(v), v[:12])


def flag_overlaps(font, names):
    glyf = font["glyf"]
    for n in names:
        g = glyf[n]
        if g.numberOfContours > 0:
            g.flags[0] |= 0x40


if __name__ == "__main__":
    main()

#!/usr/bin/env python3
"""Check that every Arabic joining stroke meets its neighbour at the same height.

For each init/medi/fina glyph, measure the ink's vertical extent exactly at the join
boundary (x=0 / x=advance) and compare with the tatweel's stroke. With a reference font
(Jomhuria) only edges that are flush in the reference but not in FONT are reported, so
Jomhuria's own deliberate slants are not counted.

Usage: check_joins.py FONT.ttf [REFERENCE.ttf]"""
import sys
import skia
from fontTools.ttLib import TTFont
from fontTools.pens.basePen import BasePen


def path_of(gs, name):
    p = skia.Path()

    class Pen(BasePen):
        def _moveTo(s, a): p.moveTo(*a)
        def _lineTo(s, a): p.lineTo(*a)
        def _qCurveToOne(s, a, b): p.quadTo(*a, *b)
        def _curveToOne(s, a, b, c): p.cubicTo(*a, *b, *c)
        def _closePath(s): p.close()
    gs[name].draw(Pen(gs))
    return p


def extent(p, x, lo=-600, hi=1200):
    ys = [y for y in range(lo, hi) if p.contains(x, y + 0.5)]
    if not ys:
        return None
    # the run touching the baseline region
    runs, start = [], ys[0]
    for a, b in zip(ys, ys[1:]):
        if b != a + 1:
            runs.append((start, a)); start = b
    runs.append((start, ys[-1]))
    for r in runs:
        if r[0] <= 200 <= r[1]:
            return r
    return None


def edges(path):
    f = TTFont(path)
    gs = f.getGlyphSet()
    hmtx = f["hmtx"]
    tname = "uni0640.1" if "uni0640.1" in gs and hmtx["uni0640"][0] == 0 else "uni0640"
    tp = path_of(gs, tname)
    ref = extent(tp, hmtx[tname][0] / 2)
    res = {}
    for g in f.getGlyphOrder():
        if not (g.startswith("uni06") or g.startswith("uni07") or g == "uni0640"):
            continue
        parts = g.split(".")
        if len(parts) < 2 or not any(parts[1].startswith(k) for k in ("init", "medi", "fina")):
            if g != "uni0640":
                continue
        adv = hmtx[g][0]
        p = path_of(gs, g)
        sides = []
        if ".init" in g or ".medi" in g:
            sides.append(("left", 0.5))          # joins the next letter at x=0
        if ".medi" in g or ".fina" in g:
            sides.append(("right", adv - 0.5))   # joins the previous letter at x=adv
        for side, x in sides:
            e = extent(p, x)
            ok = e is not None and abs(e[0] - ref[0]) <= 2 and abs(e[1] - ref[1]) <= 2
            res[(g, side)] = (ok, e)
    return ref, res


def main(path, refpath=None):
    ref, res = edges(path)
    base = edges(refpath)[1] if refpath else {}
    bad = [(k, e) for k, (ok, e) in res.items() if not ok and base.get(k, (True,))[0]]
    inherent = sum(1 for k, (ok, _) in res.items() if not ok and not base.get(k, (True,))[0])
    print(f"tatweel stroke: y {ref[0]}..{ref[1]}; checked {len(res)} join edges; "
          f"new mismatches: {len(bad)} (plus {inherent} slanted by design in the reference)")
    for b in bad[:60]:
        print("  ", b)
    return 0 if not bad else 1


if __name__ == "__main__":
    sys.exit(main(*sys.argv[1:3]))

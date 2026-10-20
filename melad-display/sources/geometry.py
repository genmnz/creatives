"""Outline geometry for the Melad Display build.

Contours are lists of [x, y, on_curve] in TrueType conventions (quadratic, outer
contours clockwise in y-up space). Everything here preserves point structure
except `union_contours` (used once, on the Jomhuria base, before masters are
derived) so that all masters stay interpolation-compatible.
"""
import math

import pathops
from fontTools.pens.recordingPen import RecordingPen
from fontTools.pens.transformPen import TransformPen


# ---------------------------------------------------------------- conversion

def recording_to_contours(value):
    """RecordingPen value (quadratic only) -> list of contours."""
    contours, cur = [], None
    for op, args in value:
        if op == "moveTo":
            cur = [[args[0][0], args[0][1], True]]
        elif op == "lineTo":
            cur.append([args[0][0], args[0][1], True])
        elif op == "qCurveTo":
            if cur is None:  # all-off-curve contour (no moveTo)
                cur = []
            for x, y in args[:-1]:
                cur.append([x, y, False])
            if args[-1] is not None:
                cur.append([args[-1][0], args[-1][1], True])
        elif op == "curveTo":
            raise ValueError("cubic segment in a TrueType pipeline")
        elif op in ("closePath", "endPath"):
            if len(cur) > 1 and cur[-1][2] and cur[0][2] and cur[-1][:2] == cur[0][:2]:
                cur.pop()
            if len(cur) >= 2:
                contours.append(cur)
            cur = None
    return contours


def draw_contours(contours, pen):
    for c in contours:
        if not any(p[2] for p in c):  # all off-curve: TrueType implied-on loop
            pen.qCurveTo(*[(p[0], p[1]) for p in c], None)
            pen.closePath()
            continue
        start = next(i for i, p in enumerate(c) if p[2])
        pts = c[start:] + c[:start]
        pen.moveTo((pts[0][0], pts[0][1]))
        offs = []
        for p in pts[1:] + [pts[0]]:
            if p[2]:
                if offs:
                    pen.qCurveTo(*offs, (p[0], p[1]))
                    offs = []
                else:
                    pen.lineTo((p[0], p[1]))
            else:
                offs.append((p[0], p[1]))
        pen.closePath()


def contours_to_pathops(contours):
    path = pathops.Path()
    draw_contours(contours, path.getPen())
    return path


def pathops_to_contours(path):
    rec = RecordingPen()
    path.draw(rec)
    return recording_to_contours(rec.value)


def union_contours(pieces):
    """pieces: list of (glyph, glyfTable, [transforms outer->inner]). Returns overlap-free contours."""
    path = pathops.Path()
    pen = path.getPen()
    for glyph, glyf, xforms in pieces:
        p = pen
        for t in xforms:
            p = TransformPen(p, t)
        glyph.draw(p, glyf)
    path.simplify(fix_winding=True, keep_starting_points=False, clockwise=True)
    return pathops_to_contours(path)


def union_of(contour_lists):
    path = pathops.Path()
    pen = path.getPen()
    for cl in contour_lists:
        draw_contours(cl, pen)
    path.simplify(fix_winding=True, keep_starting_points=False, clockwise=True)
    return pathops_to_contours(path)


# ------------------------------------------------------------------ measures

def signed_area(c):
    """Shoelace on the on/off polygon; sign is what matters (negative = clockwise)."""
    a = 0.0
    n = len(c)
    for i in range(n):
        x0, y0 = c[i][0], c[i][1]
        x1, y1 = c[(i + 1) % n][0], c[(i + 1) % n][1]
        a += x0 * y1 - x1 * y0
    return a / 2


def bbox(contours):
    xs = [p[0] for c in contours for p in c]
    ys = [p[1] for c in contours for p in c]
    if not xs:
        return None
    return min(xs), min(ys), max(xs), max(ys)


def true_area(contours):
    """Filled area (nonzero) via pathops; used to detect overlaps."""
    path = contours_to_pathops(contours)
    path.simplify(fix_winding=True, clockwise=True)
    return abs(path.area)


def raw_area(contours):
    path = contours_to_pathops(contours)
    return sum(-signed_area(c) for c in contours), path


# ---------------------------------------------------------------- embolden

def embolden_contour(c, sx, sy, factors=None, miter=1.05):
    """Point-preserving outline offset (port of FreeType's FT_Outline_EmboldenXY
    for TrueType orientation). sx/sy are per-side amounts. Counters (counter-
    clockwise contours) move inward, i.e. the ink grows on every side."""
    n = len(c)
    if n < 3 or (sx == 0 and sy == 0):
        return [p[:] for p in c]
    out = []
    for i in range(n):
        x, y = c[i][0], c[i][1]
        # previous / next distinct points
        j = (i - 1) % n
        while j != i and c[j][0] == x and c[j][1] == y:
            j = (j - 1) % n
        k = (i + 1) % n
        while k != i and c[k][0] == x and c[k][1] == y:
            k = (k + 1) % n
        ix, iy = x - c[j][0], y - c[j][1]
        ox, oy = c[k][0] - x, c[k][1] - y
        lin, lout = math.hypot(ix, iy), math.hypot(ox, oy)
        if lin == 0 or lout == 0:
            out.append([x, y, c[i][2]])
            continue
        ix, iy, ox, oy = ix / lin, iy / lin, ox / lout, oy / lout
        d = ix * ox + iy * oy
        if d > -0.9375:
            d += 1
            shx = -(iy + oy)
            shy = ix + ox
            q = -(ox * iy - oy * ix)
            l = min(lin, lout)
            shx = shx * sx / d if sx * q <= l * d else shx * l / q
            shy = shy * sy / d if sy * q <= l * d else shy * l / q
        else:
            shx = shy = 0.0
        # miter limit: pointed tips (alef, lam, kaf) must not grow spikes
        lim = miter * math.hypot(sx, sy)
        m = math.hypot(shx, shy)
        if m > lim > 0:
            shx, shy = shx * lim / m, shy * lim / m
        if factors is not None:
            shx *= factors[i]
            shy *= factors[i]
        out.append([x + shx, y + shy, c[i][2]])
    return out


def _turn_cos(c, i):
    n = len(c)
    x, y = c[i][0], c[i][1]
    j = (i - 1) % n
    while j != i and c[j][0] == x and c[j][1] == y:
        j = (j - 1) % n
    k = (i + 1) % n
    while k != i and c[k][0] == x and c[k][1] == y:
        k = (k + 1) % n
    ix, iy = x - c[j][0], y - c[j][1]
    ox, oy = c[k][0] - x, c[k][1] - y
    l = math.hypot(ix, iy) * math.hypot(ox, oy)
    return (ix * ox + iy * oy) / l if l else 1.0


def shift_dirs(c):
    """Unit outward directions (embolden direction) for each point."""
    moved = embolden_contour(c, 1.0, 1.0)
    res = []
    for p, q in zip(c, moved):
        dx, dy = q[0] - p[0], q[1] - p[1]
        l = math.hypot(dx, dy)
        res.append((dx / l, dy / l) if l > 1e-9 else (0.0, 0.0))
    return res


def polyline(contours, steps=6):
    """Flatten contours into edge arrays (x0, y0, x1, y1) for ray casting."""
    import numpy as np
    edges = []
    for c in contours:
        for s in _segments(c):
            if s[0] == "l":
                edges.append((*s[1], *s[2]))
            else:
                prev = s[1]
                for k in range(1, steps + 1):
                    p = _qpoint(s, k / steps)
                    edges.append((*prev, *p))
                    prev = p
    return np.array(edges, dtype=float) if edges else np.zeros((0, 4))


def gap_factors(contours, delta, floor, keep, eps=3.0, pinned=None):
    """Per-point share (0..1) of `delta` each point may grow by, so that the white
    gap in front of it never closes below min(gap, floor) * keep (both sides grow)."""
    import numpy as np
    E = polyline(contours)
    out = []
    if delta <= 0 or len(E) == 0:
        return [[1.0] * len(c) for c in contours]
    ex, ey = E[:, 2] - E[:, 0], E[:, 3] - E[:, 1]
    el = np.hypot(ex, ey)
    el[el == 0] = 1
    nx, ny = -ey / el, ex / el  # outward (into white) normal for TrueType orientation
    for c in contours:
        dirs = shift_dirs(c)
        f = []
        for p, (dx, dy) in zip(c, dirs):
            if dx == 0 and dy == 0:
                f.append(1.0)
                continue
            wx, wy = E[:, 0] - p[0], E[:, 1] - p[1]
            den = dx * ey - dy * ex
            with np.errstate(divide="ignore", invalid="ignore"):
                t = (wx * ey - wy * ex) / den
                u = (wx * dy - wy * dx) / den
            # only surfaces that face back towards the ray close a gap; glancing
            # hits (e.g. along the inside of a small fillet) are not gaps
            facing = (nx * dx + ny * dy) < -0.3
            ok = (np.abs(den) > 1e-12) & (t > eps) & (u >= 0) & (u <= 1) & facing
            if not ok.any():
                f.append(1.0)
                continue
            g = float(t[ok].min())
            target = max(g - 2 * delta, min(g, floor) * keep)
            f.append(max(0.0, min(1.0, (g - target) / (2 * delta))))
        n = len(f)
        # sharp cusps (e.g. the scallops under the teeth of seen) do not grow at all
        for i in range(n):
            if _turn_cos(c, i) < -0.75:
                for k in (-1, 0, 1):
                    f[(i + k) % n] = 0.0
        if n > 2:
            m = [min(f[i - 1], f[i], f[(i + 1) % n]) for i in range(n)]
            f = [0.25 * m[i - 1] + 0.5 * m[i] + 0.25 * m[(i + 1) % n] for i in range(n)]
        out.append(f)
    for ci, pi in (pinned or ()):
        out[ci][pi] = 1.0
    return out


# ------------------------------------------------------- elongation (cuts)

def _segments(c):
    """Contour -> explicit segments [('l', p0, p1) | ('q', p0, c, p1)]."""
    pts = [p[:] for p in c]
    if not any(p[2] for p in pts):
        m = [(pts[0][0] + pts[-1][0]) / 2, (pts[0][1] + pts[-1][1]) / 2, True]
        pts.insert(0, m)
    # expand implied on-curve points
    exp = []
    n = len(pts)
    for i in range(n):
        p, q = pts[i], pts[(i + 1) % n]
        exp.append(p)
        if not p[2] and not q[2]:
            exp.append([(p[0] + q[0]) / 2, (p[1] + q[1]) / 2, True])
    start = next(i for i, p in enumerate(exp) if p[2])
    exp = exp[start:] + exp[:start]
    segs = []
    n = len(exp)
    i = 0
    while i < n:
        p0 = exp[i]
        p1 = exp[(i + 1) % n]
        if p1[2]:
            segs.append(("l", (p0[0], p0[1]), (p1[0], p1[1])))
            i += 1
        else:
            p2 = exp[(i + 2) % n]
            segs.append(("q", (p0[0], p0[1]), (p1[0], p1[1]), (p2[0], p2[1])))
            i += 2
    return segs


def _qpoint(s, t):
    (x0, y0), (x1, y1), (x2, y2) = s[1], s[2], s[3]
    u = 1 - t
    return (u * u * x0 + 2 * u * t * x1 + t * t * x2, u * u * y0 + 2 * u * t * y1 + t * t * y2)


def _crossings(seg, cx):
    eps = 1e-9
    if seg[0] == "l":
        (x0, y0), (x1, y1) = seg[1], seg[2]
        if (x0 - cx) * (x1 - cx) < 0:
            t = (cx - x0) / (x1 - x0)
            return [t]
        return []
    (x0, _), (x1, _), (x2, _) = seg[1], seg[2], seg[3]
    a = x0 - 2 * x1 + x2
    b = 2 * (x1 - x0)
    c0 = x0 - cx
    ts = []
    if abs(a) < 1e-12:
        if abs(b) > 1e-12:
            ts = [-c0 / b]
    else:
        disc = b * b - 4 * a * c0
        if disc >= 0:
            r = math.sqrt(disc)
            ts = [(-b - r) / (2 * a), (-b + r) / (2 * a)]
    return sorted(t for t in ts if eps < t < 1 - eps)


def _slope(seg, t):
    if seg[0] == "l":
        (x0, y0), (x1, y1) = seg[1], seg[2]
        dx, dy = x1 - x0, y1 - y0
    else:
        (x0, y0), (x1, y1), (x2, y2) = seg[1], seg[2], seg[3]
        dx = 2 * (1 - t) * (x1 - x0) + 2 * t * (x2 - x1)
        dy = 2 * (1 - t) * (y1 - y0) + 2 * t * (y2 - y1)
    if abs(dx) < 1e-9:
        return float("inf")
    return abs(dy / dx)


def cut_profile(contours, cx):
    """Return list of (y, slope) where the outline crosses x=cx."""
    res = []
    for c in contours:
        for s in _segments(c):
            for t in _crossings(s, cx):
                y = _qpoint(s, t)[1] if s[0] == "q" else s[1][1] + t * (s[2][1] - s[1][1])
                res.append((y, _slope(s, t)))
    return res


def best_cut(contours, lo, hi, step=2):
    best = None
    x = lo
    while x <= hi:
        prof = cut_profile(contours, x)
        if prof:
            score = max(s for _, s in prof)
            if best is None or score < best[0] - 1e-6:
                best = (score, x, prof)
        x += step
    return best


def _split_q(seg, t):
    (x0, y0), (x1, y1), (x2, y2) = seg[1], seg[2], seg[3]
    ax, ay = x0 + (x1 - x0) * t, y0 + (y1 - y0) * t
    bx, by = x1 + (x2 - x1) * t, y1 + (y2 - y1) * t
    mx, my = ax + (bx - ax) * t, ay + (by - ay) * t
    return ("q", (x0, y0), (ax, ay), (mx, my)), ("q", (mx, my), (bx, by), (x2, y2))


def stretch_contour(c, cx, L):
    """Insert a horizontal run of length L where the contour crosses x=cx; points
    right of the cut move right by L. Returns a new contour."""
    segs = []
    for s in _segments(c):
        ts = _crossings(s, cx)
        if not ts:
            segs.append(s)
            continue
        if s[0] == "l":
            (x0, y0), (x1, y1) = s[1], s[2]
            t = ts[0]
            m = (cx, y0 + t * (y1 - y0))
            segs += [("l", s[1], m), ("l", m, s[2])]
        else:
            rest, done = s, 0.0
            for t in ts:
                tt = (t - done) / (1 - done)
                a, rest = _split_q(rest, tt)
                a = (a[0], a[1], a[2], (cx, a[3][1]))
                rest = (rest[0], (cx, rest[1][1]), rest[2], rest[3])
                segs.append(a)
                done = t
            segs.append(rest)

    def side(seg):
        pts = seg[1:]
        mx = sum(p[0] for p in pts) / len(pts)
        return mx > cx

    def mp(p, right):
        return [p[0] + (L if right else 0), p[1]]

    out = []
    for s in segs:
        right = side(s)
        start = mp(s[1], right)
        if not out or out[-1][:2] != start:
            out.append(start + [True])
        if s[0] == "q":
            out.append(mp(s[2], right) + [False])
            out.append(mp(s[3], right) + [True])
        else:
            out.append(mp(s[2], right) + [True])
    if len(out) > 1 and out[-1][:2] == out[0][:2]:
        out.pop()
    return out


def _seg_intersect(p1, p2, p3, p4):
    d = (p2[0] - p1[0]) * (p4[1] - p3[1]) - (p2[1] - p1[1]) * (p4[0] - p3[0])
    if abs(d) < 1e-12:
        return None
    t = ((p3[0] - p1[0]) * (p4[1] - p3[1]) - (p3[1] - p1[1]) * (p4[0] - p3[0])) / d
    u = ((p3[0] - p1[0]) * (p2[1] - p1[1]) - (p3[1] - p1[1]) * (p2[0] - p1[0])) / d
    if 1e-9 < t < 1 - 1e-9 and 1e-9 < u < 1 - 1e-9:
        return (p1[0] + t * (p2[0] - p1[0]), p1[1] + t * (p2[1] - p1[1]))
    return None


def collapse_small_loops(c, max_pts=10):
    """Remove small self-intersection loops (as seen on the control polygon) by moving
    the loop's points onto the crossing point. Point count is preserved."""
    c = [p[:] for p in c]
    n = len(c)
    for _ in range(8):
        hit = None
        for i in range(n):
            a, b = c[i], c[(i + 1) % n]
            for L in range(2, max_pts + 2):
                j = (i + L) % n
                x = _seg_intersect(a, b, c[j], c[(j + 1) % n])
                if x:
                    hit = (i, L, x)
                    break
            if hit:
                break
        if not hit:
            return c
        i, L, x = hit
        for k in range(1, L + 1):
            q = c[(i + k) % n]
            q[0], q[1] = x[0], x[1]
    return c

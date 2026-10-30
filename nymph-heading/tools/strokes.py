"""Contrast-aware stroke drawing.

A letter is described as one or more *skeletons*: centre lines made of cubic
Bezier segments.  Each skeleton is expanded into an outline whose thickness
depends on the stroke direction (a broad-nib model) and on position along the
stroke (tapers, flares).  The offset point sequences are fitted back to smooth
cubic curves (Schneider's algorithm), so the result has proper curves, not
polygons.  Strokes of one glyph are unioned with pathops.
"""

import math

import pathops

from geometry import clean, union

# ---------------------------------------------------------------------------
# skeleton building


class Sk:
    """A skeleton path: chain of cubic segments built with a turtle-ish API."""

    def __init__(self, x, y):
        self.segs = []
        self.p = (float(x), float(y))

    def line(self, x, y):
        a = self.p
        b = (float(x), float(y))
        self.segs.append((a, _lerp(a, b, 1 / 3), _lerp(a, b, 2 / 3), b))
        self.p = b
        return self

    def curve(self, c1, c2, end):
        self.segs.append((self.p, tuple(map(float, c1)), tuple(map(float, c2)),
                          tuple(map(float, end))))
        self.p = tuple(map(float, end))
        return self

    def smooth(self, *pts, tension=0.5):
        """Catmull-Rom style curve through pts (continuing from current point)."""
        allp = [self.p] + [tuple(map(float, q)) for q in pts]
        prev_dir = None
        if self.segs:
            s = self.segs[-1]
            prev_dir = _sub(s[3], s[2])
        for i in range(1, len(allp)):
            p0, p1 = allp[i - 1], allp[i]
            if i == 1 and prev_dir is not None and _len(prev_dir) > 0:
                t0 = _scale(_norm(prev_dir), _len(_sub(p1, p0)))
            else:
                pm = allp[i - 2] if i >= 2 else p0
                t0 = _sub(p1, pm)
                if i < 2:
                    t0 = _sub(p1, p0)
            pn = allp[i + 1] if i + 1 < len(allp) else p1
            t1 = _sub(pn, p0) if i + 1 < len(allp) else _sub(p1, p0)
            c1 = _add(p0, _scale(t0, tension / 3 * (2 if i == 1 and prev_dir is None else 1)))
            c2 = _sub(p1, _scale(t1, tension / 3))
            self.segs.append((p0, c1, c2, p1))
        self.p = allp[-1]
        return self

    def arc(self, cx, cy, rx, ry, a0, a1):
        """Elliptic arc from angle a0 to a1 (degrees, ccw positive).

        Starts wherever the arc starts; a straight line joins it if the
        current point is elsewhere.
        """
        a0, a1 = math.radians(a0), math.radians(a1)
        start = (cx + rx * math.cos(a0), cy + ry * math.sin(a0))
        if _len(_sub(start, self.p)) > 0.5:
            self.line(*start)
        n = max(1, int(math.ceil(abs(a1 - a0) / (math.pi / 2) - 1e-9)))
        da = (a1 - a0) / n
        k = 4 / 3 * math.tan(da / 4)
        for i in range(n):
            t0 = a0 + i * da
            t1 = t0 + da
            p0 = (cx + rx * math.cos(t0), cy + ry * math.sin(t0))
            p3 = (cx + rx * math.cos(t1), cy + ry * math.sin(t1))
            c1 = (p0[0] - k * rx * math.sin(t0), p0[1] + k * ry * math.cos(t0))
            c2 = (p3[0] + k * rx * math.sin(t1), p3[1] - k * ry * math.cos(t1))
            self.segs.append((p0, c1, c2, p3))
        self.p = (cx + rx * math.cos(a1), cy + ry * math.sin(a1))
        return self


def _lerp(a, b, t):
    return (a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t)


def _sub(a, b):
    return (a[0] - b[0], a[1] - b[1])


def _add(a, b):
    return (a[0] + b[0], a[1] + b[1])


def _scale(a, s):
    return (a[0] * s, a[1] * s)


def _len(a):
    return math.hypot(a[0], a[1])


def _norm(a):
    ln = _len(a) or 1
    return (a[0] / ln, a[1] / ln)


def _bez(seg, t):
    p0, p1, p2, p3 = seg
    mt = 1 - t
    return (mt ** 3 * p0[0] + 3 * mt * mt * t * p1[0] + 3 * mt * t * t * p2[0] + t ** 3 * p3[0],
            mt ** 3 * p0[1] + 3 * mt * mt * t * p1[1] + 3 * mt * t * t * p2[1] + t ** 3 * p3[1])


def _bez_d(seg, t):
    p0, p1, p2, p3 = seg
    mt = 1 - t
    return (3 * mt * mt * (p1[0] - p0[0]) + 6 * mt * t * (p2[0] - p1[0]) + 3 * t * t * (p3[0] - p2[0]),
            3 * mt * mt * (p1[1] - p0[1]) + 6 * mt * t * (p2[1] - p1[1]) + 3 * t * t * (p3[1] - p2[1]))


# ---------------------------------------------------------------------------
# width models


class Pen:
    """Broad-nib width model.

    thick: width of a stroke running perpendicular to the nib edge
    thin:  width of a stroke running along the nib edge
    angle: nib edge angle in degrees (0 = horizontal hairlines, vertical stress)
    """

    def __init__(self, thick, thin, angle=0.0):
        self.thick, self.thin, self.angle = thick, thin, math.radians(angle)

    def width(self, theta):
        return self.thin + (self.thick - self.thin) * abs(math.sin(theta - self.angle))


def profile(start=1.0, end=1.0, start_len=0.12, end_len=0.12, mid=1.0):
    """Multiplier along the stroke (s in 0..1): swell or taper at the ends."""
    def f(s):
        m = mid
        if s < start_len:
            u = 1 - s / start_len
            m *= 1 + (start - 1) * _smooth(u)
        if s > 1 - end_len:
            u = (s - (1 - end_len)) / end_len
            m *= 1 + (end - 1) * _smooth(u)
        return m
    return f


def _smooth(u):
    return u * u * (3 - 2 * u)


# ---------------------------------------------------------------------------
# expansion


def stroke(sk, pen, prof=None, cap="flat", start_angle=None, end_angle=None,
           samples=28, tol=1.2):
    """Expand a skeleton to a filled outline (pathops.Path).

    cap: "flat" (cut square to the stroke), "round", or "nib" (cut along the
    nib edge).  start_angle / end_angle force the cut direction (degrees) at
    each end, e.g. 90 for a vertical cut where a stroke must butt-join.
    """
    prof = prof or (lambda s: 1.0)
    pts, tans = [], []
    for si, seg in enumerate(sk.segs):
        for i in range(samples + 1):
            if i == 0 and si > 0:
                continue
            t = i / samples
            pts.append(_bez(seg, t))
            d = _bez_d(seg, t)
            if _len(d) < 1e-6:
                d = _sub(seg[3], seg[0]) if t > 0.5 else _sub(seg[3], seg[0])
            tans.append(_norm(d))
    # arc length parameter
    acc = [0.0]
    for a, b in zip(pts, pts[1:]):
        acc.append(acc[-1] + _len(_sub(b, a)))
    total = acc[-1] or 1
    left, right = [], []
    for k, (p, t) in enumerate(zip(pts, tans)):
        theta = math.atan2(t[1], t[0])
        w = pen.width(theta) * prof(acc[k] / total) / 2
        n = (-t[1], t[0])
        cut = None
        if k == 0 and start_angle is not None:
            cut = start_angle
        if k == len(pts) - 1 and end_angle is not None:
            cut = end_angle
        if cap == "nib" and cut is None and k in (0, len(pts) - 1):
            cut = math.degrees(pen.angle)
        if cut is not None:
            # place the two edge points on a line through p at the cut angle
            c = (math.cos(math.radians(cut)), math.sin(math.radians(cut)))
            dot = c[0] * n[0] + c[1] * n[1]
            if abs(dot) < 0.2:
                dot = 0.2 if dot >= 0 else -0.2
            left.append((p[0] + c[0] * w / dot, p[1] + c[1] * w / dot))
            right.append((p[0] - c[0] * w / dot, p[1] - c[1] * w / dot))
        else:
            left.append((p[0] + n[0] * w, p[1] + n[1] * w))
            right.append((p[0] - n[0] * w, p[1] - n[1] * w))

    path = pathops.Path()
    lcurves = fit_curve(left, tol)
    rcurves = fit_curve(right[::-1], tol)
    path.moveTo(*left[0])
    for c in lcurves:
        path.cubicTo(*c[1], *c[2], *c[3])
    path.lineTo(*right[-1])
    for c in rcurves:
        path.cubicTo(*c[1], *c[2], *c[3])
    path.close()
    out = clean(path)
    if cap == "round":
        for p, t, side in ((pts[0], tans[0], 0), (pts[-1], tans[-1], 1)):
            theta = math.atan2(t[1], t[0])
            r = pen.width(theta) * prof(float(side)) / 2
            out = union(out, _circle(p[0], p[1], r))
    return out


def _circle(cx, cy, r):
    sk = Sk(cx + r, cy).arc(cx, cy, r, r, 0, 360)
    p = pathops.Path()
    p.moveTo(*sk.segs[0][0])
    for s in sk.segs:
        p.cubicTo(*s[1], *s[2], *s[3])
    p.close()
    return clean(p)


def blob(sk, tol=1.0):
    """Fill a closed skeleton directly (for dots, loops drawn as shapes)."""
    p = pathops.Path()
    p.moveTo(*sk.segs[0][0])
    for s in sk.segs:
        p.cubicTo(*s[1], *s[2], *s[3])
    p.close()
    return clean(p)


def draw(*items):
    """Union of stroke outlines."""
    return union(*items)


# ---------------------------------------------------------------------------
# Schneider curve fitting


def fit_curve(points, tol):
    pts = [points[0]]
    for p in points[1:]:
        if _len(_sub(p, pts[-1])) > 1e-3:
            pts.append(p)
    if len(pts) < 2:
        return []
    if len(pts) == 2:
        a, b = pts
        return [(a, _lerp(a, b, 1 / 3), _lerp(a, b, 2 / 3), b)]
    t1 = _norm(_sub(pts[1], pts[0]))
    t2 = _norm(_sub(pts[-2], pts[-1]))
    return _fit(pts, t1, t2, tol)


def _fit(pts, t1, t2, tol, depth=0):
    if len(pts) == 2:
        d = _len(_sub(pts[1], pts[0])) / 3
        return [(pts[0], _add(pts[0], _scale(t1, d)), _add(pts[1], _scale(t2, d)), pts[1])]
    u = _chord(pts)
    bez = _generate(pts, u, t1, t2)
    err, split = _max_err(pts, bez, u)
    if err < tol:
        return [bez]
    if err < tol * 4:
        for _ in range(6):
            u = [_newton(bez, p, t) for p, t in zip(pts, u)]
            bez = _generate(pts, u, t1, t2)
            err, split = _max_err(pts, bez, u)
            if err < tol:
                return [bez]
    if depth > 12:
        return [bez]
    split = max(1, min(len(pts) - 2, split))
    tc = _norm(_sub(pts[split - 1], pts[split + 1]))
    return (_fit(pts[:split + 1], t1, tc, tol, depth + 1) +
            _fit(pts[split:], _scale(tc, -1), t2, tol, depth + 1))


def _chord(pts):
    u = [0.0]
    for a, b in zip(pts, pts[1:]):
        u.append(u[-1] + _len(_sub(b, a)))
    return [x / u[-1] for x in u]


def _generate(pts, u, t1, t2):
    first, last = pts[0], pts[-1]
    c00 = c01 = c11 = x0 = x1 = 0.0
    for p, t in zip(pts, u):
        b0 = (1 - t) ** 3
        b1 = 3 * t * (1 - t) ** 2
        b2 = 3 * t * t * (1 - t)
        b3 = t ** 3
        a1 = _scale(t1, b1)
        a2 = _scale(t2, b2)
        c00 += a1[0] * a1[0] + a1[1] * a1[1]
        c01 += a1[0] * a2[0] + a1[1] * a2[1]
        c11 += a2[0] * a2[0] + a2[1] * a2[1]
        tmp = _sub(p, _add(_scale(first, b0 + b1), _scale(last, b2 + b3)))
        x0 += a1[0] * tmp[0] + a1[1] * tmp[1]
        x1 += a2[0] * tmp[0] + a2[1] * tmp[1]
    det = c00 * c11 - c01 * c01
    seg_len = _len(_sub(last, first))
    if abs(det) > 1e-12:
        al = (x0 * c11 - c01 * x1) / det
        ar = (c00 * x1 - c01 * x0) / det
    else:
        al = ar = seg_len / 3
    eps = 1e-6 * seg_len
    if al < eps or ar < eps:
        al = ar = seg_len / 3
    return (first, _add(first, _scale(t1, al)), _add(last, _scale(t2, ar)), last)


def _max_err(pts, bez, u):
    mx, idx = 0.0, len(pts) // 2
    for i, (p, t) in enumerate(zip(pts, u)):
        d = _len(_sub(_bez(bez, t), p))
        if d > mx:
            mx, idx = d, i
    return mx, idx


def _newton(bez, p, t):
    d = _sub(_bez(bez, t), p)
    q1 = _bez_d(bez, t)
    p0, p1, p2, p3 = bez
    q2 = (6 * (1 - t) * (p2[0] - 2 * p1[0] + p0[0]) + 6 * t * (p3[0] - 2 * p2[0] + p1[0]),
          6 * (1 - t) * (p2[1] - 2 * p1[1] + p0[1]) + 6 * t * (p3[1] - 2 * p2[1] + p1[1]))
    num = d[0] * q1[0] + d[1] * q1[1]
    den = q1[0] ** 2 + q1[1] ** 2 + d[0] * q2[0] + d[1] * q2[1]
    if abs(den) < 1e-12:
        return t
    return min(1.0, max(0.0, t - num / den))


def stroke_closed(sk, pen, samples=28, tol=1.0):
    """Expand a closed skeleton (end == start) into a ring outline."""
    pts, tans = [], []
    for seg in sk.segs:
        for i in range(samples):
            t = i / samples
            pts.append(_bez(seg, t))
            d = _bez_d(seg, t)
            if _len(d) < 1e-6:
                d = _sub(seg[3], seg[0])
            tans.append(_norm(d))
    left, right = [], []
    for p, t in zip(pts, tans):
        w = pen.width(math.atan2(t[1], t[0])) / 2
        n = (-t[1], t[0])
        left.append((p[0] + n[0] * w, p[1] + n[1] * w))
        right.append((p[0] - n[0] * w, p[1] - n[1] * w))
    out = []
    for side in (left, right):
        side = side + [side[0]]
        curves = fit_curve(side, tol)
        p = pathops.Path()
        p.moveTo(*side[0])
        for c in curves:
            p.cubicTo(*c[1], *c[2], *c[3])
        p.close()
        out.append(clean(p))
    from geometry import difference
    a, b = out
    return difference(a, b) if a.area >= b.area else difference(b, a)


def ellipse_sk(cx, cy, rx, ry, start=90):
    """Closed elliptical skeleton, counter-clockwise from angle `start`."""
    return Sk(cx + rx * math.cos(math.radians(start)), cy + ry * math.sin(math.radians(start))) \
        .arc(cx, cy, rx, ry, start, start + 360)


def rounded_rect(x0, y0, x1, y1, r=28):
    r = min(r, (x1 - x0) / 2, (y1 - y0) / 2)
    sk = Sk(x0 + r, y0)
    sk.line(x1 - r, y0).arc(x1 - r, y0 + r, r, r, -90, 0)
    sk.line(x1, y1 - r).arc(x1 - r, y1 - r, r, r, 0, 90)
    sk.line(x0 + r, y1).arc(x0 + r, y1 - r, r, r, 90, 180)
    sk.line(x0, y0 + r).arc(x0 + r, y0 + r, r, r, 180, 270)
    return blob(sk)

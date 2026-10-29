"""Outline helpers used by build.py.

Everything works on ufoLib2 glyphs in a font whose contours follow the
TrueType convention (outer contours clockwise, counters counter-clockwise).
"""

import math

import pathops
from fontTools.misc.transform import Transform
from fontTools.pens.basePen import BasePen
from fontTools.pens.transformPen import TransformPen

TT_CLOCKWISE = True


# --- pathops bridges -------------------------------------------------------

def path_of(font, name, transform=None):
    """Decomposed outline of a glyph as a pathops.Path."""
    path = pathops.Path()
    pen = path.getPen(glyphSet=font)
    if transform is not None:
        pen = TransformPen(pen, transform)
    font[name].draw(pen)
    return path


def transformed(path, transform):
    out = pathops.Path()
    path.draw(TransformPen(out.getPen(), transform))
    return clean(out)


def clean(path):
    path = pathops.Path(path)
    path.simplify(fix_winding=True, clockwise=TT_CLOCKWISE)
    return path


def union(*paths):
    result = pathops.Path()
    for p in paths:
        result = pathops.op(result, clean(p), pathops.PathOp.UNION,
                            fix_winding=True, clockwise=TT_CLOCKWISE)
    return result


def difference(a, b):
    return pathops.op(clean(a), clean(b), pathops.PathOp.DIFFERENCE,
                      fix_winding=True, clockwise=TT_CLOCKWISE)


def intersection(a, b):
    return pathops.op(clean(a), clean(b), pathops.PathOp.INTERSECTION,
                      fix_winding=True, clockwise=TT_CLOCKWISE)


def rect(x0, y0, x1, y1):
    p = pathops.Path()
    p.moveTo(x0, y0)
    p.lineTo(x0, y1)
    p.lineTo(x1, y1)
    p.lineTo(x1, y0)
    p.close()
    return p


def polygon(points):
    p = pathops.Path()
    p.moveTo(*points[0])
    for pt in points[1:]:
        p.lineTo(*pt)
    p.close()
    return clean(p)


def ellipse(cx, cy, rx, ry):
    """Ellipse from 8 quadratic segments (max error ~0.03% of the radius)."""
    p = pathops.Path()
    k = math.tan(math.pi / 8)
    pts = []
    for i in range(8):
        a = i * math.pi / 4
        pts.append((math.cos(a), math.sin(a)))
    p.moveTo(cx + rx, cy)
    for i in range(8):
        a0 = i * math.pi / 4
        a1 = (i + 1) * math.pi / 4
        # control point: intersection of tangents at a0 and a1
        cxn = (math.cos(a0) - k * math.sin(a0))
        cyn = (math.sin(a0) + k * math.cos(a0))
        p.quadTo(cx + rx * cxn, cy + ry * cyn,
                 cx + rx * math.cos(a1), cy + ry * math.sin(a1))
    p.close()
    return clean(p)


def bounds(path):
    return path.bounds  # (xMin, yMin, xMax, yMax)


def set_outline(glyph, path, round_coords=True):
    """Replace a glyph's contours with a pathops path."""
    glyph.clearContours()
    glyph.clearComponents()
    path = clean(path)
    path.draw(glyph.getPen())
    if round_coords:
        round_glyph(glyph)
    drop_tiny_contours(glyph)


def round_glyph(glyph):
    for c in glyph.contours:
        for p in c.points:
            p.x = round(p.x)
            p.y = round(p.y)
        # remove consecutive duplicate on-curve points created by rounding
        pts = c.points
        i = 0
        while len(pts) > 3 and i < len(pts):
            a = pts[i]
            b = pts[(i + 1) % len(pts)]
            if a.type and b.type and (a.x, a.y) == (b.x, b.y):
                del pts[(i + 1) % len(pts)]
                continue
            i += 1


def drop_tiny_contours(glyph, min_area=40):
    from fontTools.pens.areaPen import AreaPen
    keep = []
    for c in glyph.contours:
        ap = AreaPen()
        c.draw(ap)
        if abs(ap.value) >= min_area:
            keep.append(c)
    glyph.contours[:] = keep


# --- emboldening ------------------------------------------------------------

def embolden(glyph, ex, ey, miter_limit=3.0):
    """Grow the ink of every contour by ex horizontally and ey vertically.

    Works on the control polygon (like FreeType's FT_Outline_EmboldenXY), so
    point structure and on/off-curve layout are preserved and sharp corners
    stay sharp.  Relies on TrueType contour direction: the left-hand normal
    of each edge points away from the ink.
    """
    if ex <= 0 and ey <= 0:
        return
    ex = max(ex, 1e-6)
    ey = max(ey, 1e-6)
    for contour in glyph.contours:
        pts = [(p.x / ex, p.y / ey) for p in contour.points]
        n = len(pts)
        if n < 3:
            continue
        new = []
        for i in range(n):
            x, y = pts[i]
            j = (i - 1) % n
            while pts[j] == pts[i] and j != i:
                j = (j - 1) % n
            k = (i + 1) % n
            while pts[k] == pts[i] and k != i:
                k = (k + 1) % n
            n1 = _left_normal(pts[j], pts[i])
            n2 = _left_normal(pts[i], pts[k])
            if n1 is None or n2 is None:
                new.append((x, y))
                continue
            d = 1 + n1[0] * n2[0] + n1[1] * n2[1]
            if d < 1e-3:
                sx, sy = n1[0] + n2[0], n1[1] + n2[1]
                ln = math.hypot(sx, sy) or 1
                sx, sy = sx / ln * miter_limit, sy / ln * miter_limit
            else:
                sx, sy = (n1[0] + n2[0]) / d, (n1[1] + n2[1]) / d
                ln = math.hypot(sx, sy)
                if ln > miter_limit:
                    sx, sy = sx / ln * miter_limit, sy / ln * miter_limit
            new.append((x + sx, y + sy))
        for p, (x, y) in zip(contour.points, new):
            p.x = x * ex
            p.y = y * ey


def _left_normal(a, b):
    dx, dy = b[0] - a[0], b[1] - a[1]
    ln = math.hypot(dx, dy)
    if ln == 0:
        return None
    return (-dy / ln, dx / ln)


def transform_glyph(glyph, transform):
    for c in glyph.contours:
        for p in c.points:
            p.x, p.y = transform.transformPoint((p.x, p.y))
    for a in glyph.anchors:
        a.x, a.y = transform.transformPoint((a.x, a.y))


# --- measuring --------------------------------------------------------------

class _FlattenPen(BasePen):
    def __init__(self, glyphSet=None, steps=24):
        super().__init__(glyphSet)
        self.polys = []
        self.cur = []
        self.steps = steps

    def _moveTo(self, p):
        self.cur = [p]

    def _lineTo(self, p):
        self.cur.append(p)

    def _curveToOne(self, a, b, c):
        p0 = self.cur[-1]
        for i in range(1, self.steps + 1):
            t = i / self.steps
            mt = 1 - t
            self.cur.append((
                mt ** 3 * p0[0] + 3 * mt * mt * t * a[0] + 3 * mt * t * t * b[0] + t ** 3 * c[0],
                mt ** 3 * p0[1] + 3 * mt * mt * t * a[1] + 3 * mt * t * t * b[1] + t ** 3 * c[1]))

    def _qCurveToOne(self, a, b):
        p0 = self.cur[-1]
        for i in range(1, self.steps + 1):
            t = i / self.steps
            mt = 1 - t
            self.cur.append((mt * mt * p0[0] + 2 * mt * t * a[0] + t * t * b[0],
                             mt * mt * p0[1] + 2 * mt * t * a[1] + t * t * b[1]))

    def _closePath(self):
        if self.cur:
            self.polys.append(self.cur)
        self.cur = []

    _endPath = _closePath


def polygons(font, name):
    pen = _FlattenPen(font)
    font[name].draw(pen)
    return pen.polys


def runs_at_y(font, name, y):
    """Ink spans [(x0, x1), ...] along the horizontal line at y."""
    xs = []
    for poly in polygons(font, name):
        for (x0, y0), (x1, y1) in zip(poly, poly[1:] + poly[:1]):
            if (y0 <= y < y1) or (y1 <= y < y0):
                xs.append(x0 + (y - y0) * (x1 - x0) / (y1 - y0))
    xs.sort()
    return list(zip(xs[0::2], xs[1::2]))


def runs_at_x(font, name, x):
    """Ink spans [(y0, y1), ...] along the vertical line at x."""
    ys = []
    for poly in polygons(font, name):
        for (x0, y0), (x1, y1) in zip(poly, poly[1:] + poly[:1]):
            if (x0 <= x < x1) or (x1 <= x < x0):
                ys.append(y0 + (x - x0) * (y1 - y0) / (x1 - x0))
    ys.sort()
    return list(zip(ys[0::2], ys[1::2]))


def band_extent(font, name, y0, y1, samples=9):
    """Min/max x of ink between two heights."""
    lo, hi = None, None
    for i in range(samples):
        y = y0 + (y1 - y0) * (i + 0.5) / samples
        for a, b in runs_at_y(font, name, y):
            lo = a if lo is None else min(lo, a)
            hi = b if hi is None else max(hi, b)
    return lo, hi


__all__ = [n for n in dir() if not n.startswith("_")] + ["Transform"]

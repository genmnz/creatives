"""Quick development previews of glyph outlines (pathops paths or ufo glyphs)."""

from PIL import Image, ImageChops, ImageDraw, ImageFont
from fontTools.pens.basePen import BasePen


class _Flat(BasePen):
    def __init__(self, gs=None):
        super().__init__(gs)
        self.polys, self.cur = [], []

    def _moveTo(self, p):
        self.cur = [p]

    def _lineTo(self, p):
        self.cur.append(p)

    def _qCurveToOne(self, a, b):
        p0 = self._getCurrentPoint()
        for i in range(1, 13):
            t = i / 12
            m = 1 - t
            self.cur.append((m * m * p0[0] + 2 * m * t * a[0] + t * t * b[0],
                             m * m * p0[1] + 2 * m * t * a[1] + t * t * b[1]))

    def _curveToOne(self, a, b, c):
        p0 = self._getCurrentPoint()
        for i in range(1, 17):
            t = i / 16
            m = 1 - t
            self.cur.append((m ** 3 * p0[0] + 3 * m * m * t * a[0] + 3 * m * t * t * b[0] + t ** 3 * c[0],
                             m ** 3 * p0[1] + 3 * m * m * t * a[1] + 3 * m * t * t * b[1] + t ** 3 * c[1]))

    def _closePath(self):
        if len(self.cur) > 2:
            self.polys.append(self.cur)
        self.cur = []

    _endPath = _closePath


def sheet(items, path, cell=260, cols=8, upm_span=3000, baseline_frac=0.68, lines=(), points=False):
    """items: list of (label, drawable, advance). drawable has .draw(pen)."""
    rows = (len(items) + cols - 1) // cols
    img = Image.new("L", (cols * cell, rows * (cell + 16)), 255)
    d = ImageDraw.Draw(img)
    sc = cell / upm_span
    for i, (label, obj, adv) in enumerate(items):
        cx = (i % cols) * cell
        cy = (i // cols) * (cell + 16)
        base = cy + cell * baseline_frac
        ox = cx + (cell - adv * sc) / 2
        for y in (0,) + tuple(lines):
            d.line([(cx, base - y * sc), (cx + cell, base - y * sc)], fill=215)
        d.line([(ox, cy), (ox, cy + cell)], fill=225)
        d.line([(ox + adv * sc, cy), (ox + adv * sc, cy + cell)], fill=225)
        pen = _Flat()
        obj.draw(pen)
        acc = Image.new("1", (cell, cell), 0)
        for poly in pen.polys:
            t = Image.new("1", (cell, cell), 0)
            ImageDraw.Draw(t).polygon([(x * sc + ox - cx, base - cy - y * sc) for x, y in poly], fill=1)
            acc = ImageChops.logical_xor(acc, t)
        img.paste(0, (cx, cy), acc)
        if points:
            for poly in pen.polys:
                pass
        d.text((cx + 3, cy + cell + 2), label[:30], fill=0)
    img.save(path)

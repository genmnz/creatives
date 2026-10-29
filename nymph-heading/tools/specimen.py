#!/usr/bin/env python3
"""Render glyph sheets and a text specimen from the built font.

    python3 tools/specimen.py

Writes specimen/glyphs.png (every glyph, with its code point) and
specimen/text.png (shaped with HarfBuzz, so kerning, marks and features show).
"""

import sys
from pathlib import Path

import uharfbuzz as hb
from fontTools.pens.basePen import BasePen
from fontTools.ttLib import TTFont
from PIL import Image, ImageChops, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parent.parent
FONT = ROOT / "fonts" / "ttf" / "NymphHeading-Regular.ttf"
OUT = ROOT / "specimen"
SS = 3  # supersampling


class PolyPen(BasePen):
    def __init__(self, glyphSet, t):
        super().__init__(glyphSet)
        self.polys, self.cur, self.t = [], [], t

    def _moveTo(self, p):
        self.cur = [self.t(p)]

    def _lineTo(self, p):
        self.cur.append(self.t(p))

    def _qCurveToOne(self, a, b):
        p0 = self._getCurrentPoint()
        for i in range(1, 11):
            s = i / 10
            m = 1 - s
            self.cur.append(self.t((m * m * p0[0] + 2 * m * s * a[0] + s * s * b[0],
                                    m * m * p0[1] + 2 * m * s * a[1] + s * s * b[1])))

    def _curveToOne(self, a, b, c):
        p0 = self._getCurrentPoint()
        for i in range(1, 13):
            s = i / 12
            m = 1 - s
            self.cur.append(self.t((
                m ** 3 * p0[0] + 3 * m * m * s * a[0] + 3 * m * s * s * b[0] + s ** 3 * c[0],
                m ** 3 * p0[1] + 3 * m * m * s * a[1] + 3 * m * s * s * b[1] + s ** 3 * c[1])))

    def _closePath(self):
        if len(self.cur) > 2:
            self.polys.append(self.cur)
        self.cur = []


def fill(img, glyphset, name, x, y, scale, color=0):
    """Draw a glyph with its origin at pixel (x, y) (y = baseline)."""
    pen = PolyPen(glyphset, lambda p: (x + p[0] * scale, y - p[1] * scale))
    glyphset[name].draw(pen)
    if not pen.polys:
        return
    xs = [p[0] for poly in pen.polys for p in poly]
    ys = [p[1] for poly in pen.polys for p in poly]
    ox, oy = int(min(xs)) - 2, int(min(ys)) - 2
    size = (int(max(xs)) - ox + 4, int(max(ys)) - oy + 4)
    mask = Image.new("1", size, 0)
    for poly in pen.polys:
        layer = Image.new("1", size, 0)
        ImageDraw.Draw(layer).polygon([(px - ox, py - oy) for px, py in poly], fill=1)
        mask = ImageChops.logical_xor(mask, layer)
    img.paste(color, (ox, oy), mask)


def label_font(size):
    for p in ("/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",):
        if Path(p).exists():
            return ImageFont.truetype(p, size)
    return ImageFont.load_default()


def glyph_sheet(tt, path):
    gs = tt.getGlyphSet()
    cmap = tt.getBestCmap()
    rev = {}
    for cp, n in cmap.items():
        rev.setdefault(n, cp)
    names = [n for n in tt.getGlyphOrder() if n != ".notdef"]
    cols, cell, lab = 12, 150 * SS, 22 * SS
    upm = tt["head"].unitsPerEm
    scale = cell * 0.55 / upm
    rows = (len(names) + cols - 1) // cols
    head = 90 * SS
    img = Image.new("L", (cols * cell, head + rows * (cell + lab)), 255)
    d = ImageDraw.Draw(img)
    d.text((20 * SS, 20 * SS), f"Nymph Heading - {len(names)} glyphs, {len(cmap)} characters",
           fill=0, font=label_font(28 * SS))
    small = label_font(10 * SS)
    for i, n in enumerate(names):
        cx = (i % cols) * cell
        cy = head + (i // cols) * (cell + lab)
        base = cy + cell * 0.70
        w = gs[n].width * scale
        x0 = cx + (cell - w) / 2
        d.rectangle([cx, cy, cx + cell - 1, cy + cell + lab - 1], outline=225)
        d.line([(cx, base), (cx + cell, base)], fill=230)
        d.line([(x0, cy + 6 * SS), (x0, cy + cell - 6 * SS)], fill=235)
        d.line([(x0 + w, cy + 6 * SS), (x0 + w, cy + cell - 6 * SS)], fill=235)
        fill(img, gs, n, x0, base, scale)
        tag = ("U+%04X " % rev[n]) if n in rev else ""
        d.text((cx + 4 * SS, cy + cell), (tag + n)[:26], fill=90, font=small)
    img = img.resize((img.width // SS, img.height // SS), Image.LANCZOS)
    img.save(path, optimize=True)


SAMPLES = [
    ("Display", 150, "Nymph Heading", {}),
    ("Lowercase", 84, "The quick brown fox jumps over the lazy dog", {}),
    ("Capitals", 70, "THE QUICK BROWN FOX JUMPS OVER THE LAZY DOG", {}),
    ("Figures", 80, "0123456789  ½ ¼ ¾  x² H₂O  1/16  № 7  € £ ¥ $ ¢", {"frac": True}),
    ("Punctuation", 80, "«Bonjour» „Guten Tag“ “Hello” ‹oui› — & @ § ¶ † ‡ ‰", {}),
    ("Deutsch", 70, "Größe, Straße, Übermäßig — ẞ", {}),
    ("Français", 70, "Œuvre à côté d’un château, garçon ému", {}),
    ("Español", 70, "¿Señor Núñez? ¡Pingüino añejo!", {}),
    ("Polski", 70, "Zażółć gęślą jaźń — Łódź", {}),
    ("Čeština / Slovenčina", 70, "Příliš žluťoučký kůň — Ľubica ďalej", {}),
    ("Magyar", 70, "Árvíztűrő tükörfúrógép", {}),
    ("Română", 70, "Știință și țară — Brașov", {}),
    ("Türkçe", 70, "İstanbul için ılık ışık — Iğdır", {"locl_tr": True}),
    ("Latviešu / Lietuvių", 70, "Ģērbjas ķēniņš — Ąžuolas, ūsai", {}),
    ("Dansk / Norsk / Íslenska", 70, "Ærø, Øresund, Ålesund — Þórður, Ðorri", {}),
    ("Malti / Cymraeg / Esperanto", 70, "Ħabiba Żejtun — Ŵyn ŷd — ĉiuĵaŭde", {}),
    ("Azərbaycan / Sámi", 70, "Ərəb, Əli — Ŋuorra, Đuoddar, Ŧiekka", {}),
    ("ss01", 90, "ACE OUSY ace ousy", {"ss01": True}),
    ("dlig", 90, "THE AND FOR — the and for", {"dlig": True}),
]


def text_specimen(path):
    blob = hb.Blob.from_file_path(str(FONT))
    face = hb.Face(blob)
    hbfont = hb.Font(face)
    tt = TTFont(FONT)
    gs = tt.getGlyphSet()
    upm = tt["head"].unitsPerEm
    width = 2200 * SS
    margin = 60 * SS
    lines = []
    for label, size, text, feats in SAMPLES:
        lines.append((label, size * SS, text, feats))
    height = margin + sum(int(s * 1.55) + 30 * SS for _, s, _, _ in lines) + margin
    img = Image.new("L", (width, height), 255)
    d = ImageDraw.Draw(img)
    lab = label_font(14 * SS)
    y = margin
    for label, size, text, feats in lines:
        d.text((margin, y), label, fill=120, font=lab)
        y += 24 * SS
        buf = hb.Buffer()
        buf.add_str(text)
        buf.guess_segment_properties()
        f = dict(feats)
        if f.pop("locl_tr", False):
            buf.language = "tr"
        hb.shape(hbfont, buf, f)
        scale = size / upm
        x = margin
        baseline = y + size * 1.05
        for info, pos in zip(buf.glyph_infos, buf.glyph_positions):
            name = hbfont.glyph_to_string(info.codepoint)
            fill(img, gs, name, x + pos.x_offset * scale, baseline - pos.y_offset * scale, scale)
            x += pos.x_advance * scale
        y += int(size * 1.55)
    img = img.resize((img.width // SS, img.height // SS), Image.LANCZOS)
    img.save(path, optimize=True)


def main():
    OUT.mkdir(exist_ok=True)
    tt = TTFont(FONT)
    glyph_sheet(tt, OUT / "glyphs.png")
    text_specimen(OUT / "text.png")
    print("wrote", OUT / "glyphs.png", OUT / "text.png")


if __name__ == "__main__":
    sys.exit(main())

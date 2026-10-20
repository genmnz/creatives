#!/usr/bin/env python3
"""Measure how far shaped Arabic reaches above/below the baseline (font units), to check
stacked lines at tight line-heights. Usage: check_vertical.py FONT.ttf [REF.ttf]"""
import sys
import uharfbuzz as hb
from fontTools.ttLib import TTFont

WORDS = ("إنهـــــــا تتخفّـــى أكبر من الفستـــان ثم جاء الوجه الشاحـــب من أخذ الغـــلاف؟ "
         "هل تتذكّر الفستان أم الوجـــــــه؟ في يناير ١٩٩٠ جمع المصوّر بيتر ليندبرغ خمس عارضات "
         "على غلاف واحد لفوغ البريطانية. المرأة، الموضة، الصورة، العارضة، زرّ، رزق، لا، لأ، لإ، لآ، "
         "فـــي، بـــ، ١٠٠٪ كلّ لّ ألّ إلّا الطّ أُمّ بِ جُّ ئ ؤ ء ڭ گ ک ی پ چ ژ").split()


def reach(path):
    f = TTFont(path)
    glyf, order = f["glyf"], f.getGlyphOrder()
    font = hb.Font(hb.Face(hb.Blob.from_file_path(path)))
    top, bot = [], []
    for w in WORDS:
        b = hb.Buffer(); b.add_str(w); b.guess_segment_properties(); hb.shape(font, b)
        hi, lo = -9999, 9999
        for i, p in zip(b.glyph_infos, b.glyph_positions):
            g = glyf[order[i.codepoint]]
            if g.numberOfContours:
                hi = max(hi, g.yMax + p.y_offset)
                lo = min(lo, g.yMin + p.y_offset)
        top.append((hi, w)); bot.append((lo, w))
    return max(top), min(bot), f["hhea"].ascent, f["hhea"].descent, f["head"].unitsPerEm


def main(path, ref=None):
    for p in [path] + ([ref] if ref else []):
        (hi, wh), (lo, wl), asc, desc, upm = reach(p)
        print(p)
        print(f"  highest ink {hi} ({wh}), lowest {lo} ({wl}); hhea {asc}/{desc}")
        for lh in (0.85, 0.98):
            pitch = lh * upm
            print(f"  line-height {lh}: worst-case clearance between a deep descender and the "
                  f"tallest mark on the next line = {pitch - hi + lo:.0f} units")


if __name__ == "__main__":
    main(*sys.argv[1:3])

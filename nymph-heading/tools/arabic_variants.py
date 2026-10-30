#!/usr/bin/env python3
"""Render the Arabic style variants side by side so one can be picked.

    python3 tools/arabic_variants.py

Builds a quick Regular for each style in arabic.STYLES and writes
specimen/arabic-variants.png.  Pick one and build with
`python3 tools/build.py --arabic-style <key>` (or NYMPH_ARABIC=<key>).
"""

import subprocess
import sys
import tempfile
from pathlib import Path

import uharfbuzz as hb
from fontTools.ttLib import TTFont
from PIL import Image, ImageDraw

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import arabic  # noqa: E402
from specimen import fill, label_font  # noqa: E402

ROOT = HERE.parent
SAMPLE = [
    "بسم الله الرحمن الرحيم",
    "مرحبا بالعالم — السَّلامُ عَلَيْكُمْ",
    "كتب طالب صباح عين فقه شمس ضوء",
    "٠١٢٣٤٥٦٧٨٩ ؟ ، ؛ ٪ — ۱۲۳۴۵۶",
]
SS = 2


def shape_line(img, path, text, right, y, size):
    font = hb.Font(hb.Face(hb.Blob.from_file_path(str(path))))
    tt = TTFont(path)
    gs = tt.getGlyphSet()
    buf = hb.Buffer()
    buf.add_str(text)
    buf.guess_segment_properties()
    hb.shape(font, buf, {})
    sc = size / tt["head"].unitsPerEm
    total = sum(p.x_advance for p in buf.glyph_positions) * sc
    x = right - total
    for info, pos in zip(buf.glyph_infos, buf.glyph_positions):
        fill(img, gs, font.glyph_to_string(info.codepoint), x + pos.x_offset * sc,
             y - pos.y_offset * sc, sc)
        x += pos.x_advance * sc


def main():
    width = 2000 * SS
    size = 92 * SS
    row = int(size * 1.75)
    block = 70 * SS + row * len(SAMPLE) + 40 * SS
    img = Image.new("L", (width, block * len(arabic.STYLES) + 40 * SS), 255)
    d = ImageDraw.Draw(img)
    with tempfile.TemporaryDirectory() as tmp:
        for i, (key, style) in enumerate(arabic.STYLES.items()):
            path = Path(tmp) / f"{key}.ttf"
            subprocess.run([sys.executable, str(HERE / "build.py"), "--quick", str(path),
                            "--arabic-style", key], check=True, capture_output=True)
            top = 30 * SS + i * block
            d.text((40 * SS, top), f"{key} - {style.label}", fill=60, font=label_font(22 * SS))
            for j, line in enumerate(SAMPLE):
                shape_line(img, path, line, width - 40 * SS, top + 70 * SS + row * j + size, size)
            d.line([(40 * SS, top + block - 20 * SS), (width - 40 * SS, top + block - 20 * SS)], fill=200)
    out = ROOT / "specimen" / "arabic-variants.png"
    img.resize((img.width // SS, img.height // SS), Image.LANCZOS).save(out, optimize=True)
    print("wrote", out)


if __name__ == "__main__":
    main()

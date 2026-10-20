#!/usr/bin/env python3
"""Validate fonts written by the studio with independent tools.

    python3 tests/validate.py OUT_DIR ORIGINAL.ttf...

- fontTools decompiles every table of every output (ttf/woff/woff2)
- OTS (the sanitizer Chrome and Firefox run on web fonts) accepts every output
- HarfBuzz shapes the untouched round trip exactly like the original
"""
import glob
import os
import subprocess
import sys

import uharfbuzz as hb
from fontTools.ttLib import TTFont

SAMPLES = ["إنهـــــــا تتخفّـــى", "أكبر من الفستـــان", "زرّ، رزق، لا، لأ، لإ، لآ، ١٠٠٪",
           "في يناير ١٩٩٠ جمع المصوّر", "Hamburgefonstiv 0123 AVATAR", "پ چ ژ گ ک ی"]


def shape(path):
    font = hb.Font(hb.Face(hb.Blob.from_file_path(path)))
    out = []
    for s in SAMPLES:
        b = hb.Buffer()
        b.add_str(s)
        b.guess_segment_properties()
        hb.shape(font, b)
        out.append([(i.codepoint, p.x_advance, p.x_offset, p.y_offset) for i, p in zip(b.glyph_infos, b.glyph_positions)])
    return out


def main(out_dir, originals):
    fails = 0
    for f in sorted(glob.glob(os.path.join(out_dir, "*.ttf")) + glob.glob(os.path.join(out_dir, "*.woff*"))):
        try:
            t = TTFont(f)
            for tag in t.keys():
                if tag != "GlyphOrder":
                    t[tag]  # force decompile
            t["glyf"].glyphs  # noqa
            for g in t.getGlyphOrder():
                t["glyf"][g].getCoordinates(t["glyf"]) if t["glyf"][g].numberOfContours else None
            ft = "ok"
        except Exception as e:  # noqa: BLE001
            ft = f"FAIL {e!r}"
            fails += 1
        r = subprocess.run([sys.executable, "-m", "ots", f], capture_output=True, text=True)
        ots = "ok" if r.returncode == 0 else "FAIL " + (r.stdout + r.stderr).strip().splitlines()[-1]
        fails += r.returncode != 0
        print(f"{os.path.basename(f):45s} fontTools {ft:6s} OTS {ots}")
    for orig in originals:
        name = os.path.splitext(os.path.basename(orig))[0]
        rt = os.path.join(out_dir, name + ".roundtrip.ttf")
        if not os.path.exists(rt):
            continue
        same = shape(orig) == shape(rt)
        fails += not same
        print(f"{name}: HarfBuzz shaping of round trip identical to original: {'ok' if same else 'FAIL'}")
    print("all external checks passed" if not fails else f"{fails} external checks FAILED")
    return 1 if fails else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1], sys.argv[2:]))

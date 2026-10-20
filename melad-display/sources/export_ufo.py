#!/usr/bin/env python3
"""Export the Melad Display masters (built by build.py) as UFO sources + designspace.

    python3 build.py && python3 export_ufo.py

Each master UFO carries outlines (quadratic, as built), advances, unicodes and font
info. OpenType layout (GDEF/GSUB/GPOS, inherited from Jomhuria and rescaled per master)
is stored as TTX in data/com.github.fonttools.ttx/, which ufo2ft/fontmake merge back into
the compiled font, so `fontmake -m ufo/MeladDisplay.designspace -o variable` works.
build.py remains the authoritative source: edit parameters there, not the UFOs.
"""
import os
import shutil

import ufoLib2
from fontTools.designspaceLib import DesignSpaceDocument
from fontTools.ttLib import TTFont

HERE = os.path.dirname(os.path.abspath(__file__))
BUILD = os.path.join(HERE, "build")
OUT = os.path.join(HERE, "ufo")


def export(ttf_path, ufo_path, style):
    f = TTFont(ttf_path)
    ufo = ufoLib2.Font()
    gs = f.getGlyphSet()
    cmap = {}
    for u, g in f.getBestCmap().items():
        cmap.setdefault(g, []).append(u)
    order = f.getGlyphOrder()
    for n in order:
        g = ufo.newGlyph(n)
        g.width = f["hmtx"][n][0]
        g.unicodes = sorted(cmap.get(n, []))
        gs[n].draw(g.getPen())
    ufo.glyphOrder = order
    info = ufo.info
    name = f["name"]
    info.familyName = "Melad Display"
    info.styleName = style
    info.unitsPerEm = f["head"].unitsPerEm
    info.ascender, info.descender = f["hhea"].ascent, f["hhea"].descent
    info.openTypeHheaAscender, info.openTypeHheaDescender, info.openTypeHheaLineGap = 1840, -1160, 0
    info.openTypeOS2TypoAscender, info.openTypeOS2TypoDescender, info.openTypeOS2TypoLineGap = 1840, -1160, 0
    info.openTypeOS2WinAscent, info.openTypeOS2WinDescent = f["OS/2"].usWinAscent, f["OS/2"].usWinDescent
    info.openTypeOS2Selection = [7]
    info.openTypeOS2WeightClass = f["OS/2"].usWeightClass
    info.openTypeOS2VendorID = "MELD"
    info.openTypeOS2Type = []
    info.copyright = name.getDebugName(0)
    info.openTypeNameLicense = name.getDebugName(13)
    info.openTypeNameLicenseURL = name.getDebugName(14)
    info.openTypeNameDesigner = name.getDebugName(9)
    info.openTypeNameManufacturer = name.getDebugName(8)
    info.versionMajor, info.versionMinor = 1, 0
    info.postscriptUnderlinePosition = f["post"].underlinePosition
    info.postscriptUnderlineThickness = f["post"].underlineThickness
    # ttx layout tables, merged by ufo2ft at compile time
    for t in ("GDEF", "GSUB", "GPOS"):
        tmp = f"{ttf_path}.{t}.ttx"
        f.saveXML(tmp, tables=[t])
        with open(tmp, "rb") as fh:
            ufo.data[f"com.github.fonttools.ttx/{t}.ttx"] = fh.read()
        os.remove(tmp)
    ufo.lib["com.github.googlei18n.ufo2ft.keepGlyphOrder"] = True
    ufo.save(ufo_path, overwrite=True, structure="zip")


def main():
    if os.path.exists(OUT):
        shutil.rmtree(OUT)
    os.makedirs(OUT)
    ds = DesignSpaceDocument.fromfile(os.path.join(BUILD, "MeladDisplay.designspace"))
    for src in ds.sources:
        w, wg = int(src.location["Width"]), int(src.location["Weight"])
        ufo_name = f"MeladDisplay-wdth{w}-wght{wg}.ufoz"
        print("exporting", ufo_name)
        export(src.path, os.path.join(OUT, ufo_name), f"wdth{w} wght{wg}")
        src.path = os.path.join(OUT, ufo_name)
        src.filename = ufo_name
        src.font = None
    ds.write(os.path.join(OUT, "MeladDisplay.designspace"))


if __name__ == "__main__":
    main()

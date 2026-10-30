"""Bring the Arabic of another font (a "donor") into Nymph Heading.

Instead of translating the donor's OpenType code, each letter is shaped with
HarfBuzz in every joining position (isolated, initial, medial, final, using
ZWJ as context), and the resulting cluster -- base letter plus any dots or
marks the donor positions on it -- is copied as one outline.  Lam-alef
ligatures, harakat, digits and punctuation are captured the same way.  The
joining features are then rebuilt from what was captured, and the harakat get
anchors like the rest of the font.

The donor is scaled so its Arabic keeps the size relationship it had with its
own Latin capitals.
"""

import unicodedata

import uharfbuzz as hb
from fontTools.misc.transform import Transform
from fontTools.pens.recordingPen import DecomposingRecordingPen
from fontTools.pens.transformPen import TransformPen
from fontTools.ttLib import TTFont

import pathops
from geometry import clean, set_outline

ZWJ = "‍"
LETTER_RANGES = [(0x0620, 0x064A), (0x066E, 0x06D3), (0x06D5, 0x06D5), (0x06EE, 0x06EF),
                 (0x06FA, 0x06FF), (0x0750, 0x077F), (0x08A0, 0x08C9)]
MARK_RANGES = [(0x0610, 0x061A), (0x064B, 0x065F), (0x0670, 0x0670), (0x06D6, 0x06ED),
               (0x08CA, 0x08FF)]
OTHER = [0x060C, 0x060D, 0x061B, 0x061F, 0x0640, 0x066A, 0x066B, 0x066C, 0x066D, 0x06D4,
         0x0600, 0x0601, 0x0602, 0x0603, 0x0606, 0x0607, 0x0608, 0x0609, 0x060A, 0x060B,
         0x060E, 0x060F, 0x061E, 0xFD3E, 0xFD3F, 0xFDF2, 0xFDFC] + \
    list(range(0x0660, 0x066A)) + list(range(0x06F0, 0x06FA))
LAM_ALEF = [0x0622, 0x0623, 0x0625, 0x0627, 0x0671]


class Donor:
    def __init__(self, path, latin_cap):
        self.tt = TTFont(path)
        self.gs = self.tt.getGlyphSet()
        self.cmap = self.tt.getBestCmap()
        self.hb = hb.Font(hb.Face(hb.Blob.from_file_path(str(path))))
        cap = getattr(self.tt["OS/2"], "sCapHeight", 0) or 1450
        self.scale = latin_cap / cap
        self.upm_scale = 2048 / self.tt["head"].unitsPerEm

    def shape(self, text):
        buf = hb.Buffer()
        buf.add_str(text)
        buf.direction = "rtl"
        buf.script = "arab"
        buf.language = "ar"
        hb.shape(self.hb, buf, {})
        return buf

    def capture(self, text, keep):
        """Outline + advance of the glyphs whose cluster index is in `keep`."""
        buf = self.shape(text)
        s = self.scale * self.upm_scale
        x = 0
        start = None
        width = 0
        rec = []
        for info, pos in zip(buf.glyph_infos, buf.glyph_positions):
            name = self.hb.glyph_to_string(info.codepoint)
            if info.cluster in keep:
                if start is None:
                    start = x
                rec.append((name, x + pos.x_offset, pos.y_offset))
                width += pos.x_advance
            x += pos.x_advance
        if start is None:
            return None, 0, []
        path = pathops.Path()
        names = []
        for name, gx, gy in rec:
            if name == ".notdef":
                return None, 0, []
            names.append(name)
            pen = TransformPen(path.getPen(), Transform().scale(s).translate(gx - start, gy))
            r = DecomposingRecordingPen(self.gs)
            self.gs[name].draw(r)
            r.replay(pen)
        return clean(path), round(width * s), names

    def has(self, cp):
        return cp in self.cmap


def _in(cp, ranges):
    return any(a <= cp <= b for a, b in ranges)


def build_from_donor(font, donor_path, latin_cap, new_glyph, set_anchor, ink_extent):
    d = Donor(donor_path, latin_cap)
    features = {"init": [], "medi": [], "fina": []}
    marks = []
    made = 0

    def put(name, path, width, unicodes=()):
        g = new_glyph(font, name, width, list(unicodes))
        if path is not None:
            set_outline(g, path)
        return g

    def anchors(g, name):
        b = g.getBounds(font)
        if b is None:
            return
        cx = (b.xMin + b.xMax) / 2
        lo, hi = ink_extent(font, name, cx)
        set_anchor(g, "top", cx, (hi if hi is not None else b.yMax) + 110)
        set_anchor(g, "bottom", cx, (lo if lo is not None else b.yMin) - 110)

    # letters in every joining position
    for cp in sorted(c for c in d.cmap if _in(c, LETTER_RANGES)):
        ch = chr(cp)
        base = "uni%04X" % cp
        iso, w, iso_names = d.capture(ch, {0})
        if iso is None:
            continue
        g = put(base, iso, w, [cp])
        anchors(g, base)
        made += 1
        for form, text, keep in (("init", ch + ZWJ, {0}), ("medi", ZWJ + ch + ZWJ, {1}),
                                 ("fina", ZWJ + ch, {1})):
            p, w2, names = d.capture(text, keep)
            if p is None or names == iso_names:
                continue
            name = base + "." + form
            g = put(name, p, w2)
            anchors(g, name)
            features[form].append((base, name))
            made += 1

    # lam-alef ligatures (isolated and final)
    rlig = []
    for alef in LAM_ALEF:
        if not d.has(alef):
            continue
        for form, text, keep in (("", "ل" + chr(alef), {0, 1}),
                                 (".fina", ZWJ + "ل" + chr(alef), {1, 2})):
            p, w, names = d.capture(text, keep)
            if p is None or len(names) != 1:
                continue
            name = "uni0644_uni%04X%s" % (alef, form)
            g = put(name, p, w)
            anchors(g, name)
            lam = "uni0644.init" if not form else "uni0644.medi"
            rlig.append("    sub %s uni%04X.fina by %s;" % (lam, alef, name))

    # harakat and other combining marks: captured on a tatweel, kept alone
    for cp in sorted(c for c in d.cmap if _in(c, MARK_RANGES)):
        buf = d.shape("ـ" + chr(cp))
        gid = None
        for info in buf.glyph_infos:
            if info.cluster == 0 and d.hb.glyph_to_string(info.codepoint) != d.hb.glyph_to_string(
                    d.shape("ـ").glyph_infos[0].codepoint):
                gid = info.codepoint
        if gid is None:
            continue
        src = d.hb.glyph_to_string(gid)
        s = d.scale * d.upm_scale
        path = pathops.Path()
        r = DecomposingRecordingPen(d.gs)
        d.gs[src].draw(r)
        r.replay(TransformPen(path.getPen(), Transform().scale(s)))
        path = clean(path)
        if path.bounds is None or path.bounds == (0, 0, 0, 0):
            continue
        name = "uni%04X" % cp
        g = put(name, path, 0, [cp])
        gb = g.getBounds(font)
        cx = (gb.xMin + gb.xMax) / 2
        below = unicodedata.combining(chr(cp)) == 220 or cp in (0x0650, 0x064D, 0x0655, 0x065F,
                                                                  0x0656, 0x06E3, 0x06ED)
        if below or gb.yMax < 0:
            set_anchor(g, "_bottom", cx, gb.yMax + 70)
            set_anchor(g, "bottom", cx, gb.yMin - 50)
        else:
            set_anchor(g, "_top", cx, gb.yMin - 70)
            set_anchor(g, "top", cx, gb.yMax + 50)
        marks.append(name)

    # digits, punctuation, signs
    for cp in OTHER:
        if not d.has(cp) or ("uni%04X" % cp) in font:
            continue
        p, w, _ = d.capture(chr(cp), {0})
        if p is None:
            continue
        put("uni%04X" % cp, p, w, [cp])
    for cp in (0x200C, 0x200D, 0x200E, 0x200F, 0x061C):
        if "uni%04X" % cp not in font:
            put("uni%04X" % cp, None, 0, [cp])

    fea = ""
    for form in ("init", "medi", "fina"):
        fea += "\nfeature %s {\n    script arab;\n    lookupflag IgnoreMarks;\n" % form
        fea += "\n".join("    sub %s by %s;" % p for p in sorted(features[form]))
        fea += "\n} %s;\n" % form
    fea += "\nfeature rlig {\n    script arab;\n    lookupflag IgnoreMarks;\n" + "\n".join(rlig) + "\n} rlig;\n"
    prefix = "languagesystem arab dflt;\nlanguagesystem arab URD;\nlanguagesystem arab FAR;\n"
    print("  arabic from donor: %d letter glyphs, %d marks, %d lam-alef, scale %.3f"
          % (made, len(marks), len(rlig), d.scale))
    return prefix, fea, marks

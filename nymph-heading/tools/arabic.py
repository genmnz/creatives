"""Arabic for Nymph Heading.

Every letter is a set of skeletons expanded with the stroke engine, so one
drawing gives several styles: the STYLES below change contrast, nib angle,
terminals and dot shape.  Joining forms (isol/init/medi/fina) share a baseline
stroke of identical thickness that runs flush to the glyph edges, so letters
connect seamlessly.  Dots are drawn into each glyph; harakat attach through
mark anchors.

Text runs right to left, so in each glyph the *right* edge (x = advance)
connects to the previous letter and the *left* edge (x = 0) to the next one.
"""

import math
from dataclasses import dataclass

from fontTools.misc.transform import Transform

from geometry import difference, intersection, polygon, rect, transformed, union
from strokes import Pen, Sk, blob, ellipse_sk, profile, stroke, stroke_closed


@dataclass
class Style:
    key: str
    label: str
    pen: Pen
    dot: str          # round | diamond | square
    dot_size: float
    taper: float      # width factor at free stroke ends (1 = blunt)
    cap: str          # flat | round


STYLES = {
    "sahel": Style("sahel", "Sahel: modern, low contrast, round dots (closest to the macOS look)",
                   Pen(178, 128, 72), "round", 178, 0.92, "round"),
    "nymph": Style("nymph", "Nymph: calligraphic contrast and tapered ends to match the Latin",
                   Pen(244, 60, 58), "diamond", 190, 0.38, "flat"),
    "kufi": Style("kufi", "Kufi: geometric, monoline, square dots",
                  Pen(150, 150, 0), "square", 158, 1.0, "flat"),
}

ALEF_H = 1450     # alef / lam / kaf / tah height
TOOTH = 370       # beh-type teeth
SEEN_T = 300      # seen teeth
BOWL_D = -390     # depth of noon / lam / yeh bowls
DEEP = -600       # jeem bowl, meem tail
SB = 70           # side bearing on non-joining sides


# Joining type of each letter: D = dual (all four forms), R = right only (isol, fina)
LETTERS = {
    # name: (codepoint, joining, shape, dots)
    "hamza": (0x0621, "U", "hamza", None),
    "alefMadda": (0x0622, "R", "alef", "madda"),
    "alefHamzaAbove": (0x0623, "R", "alef", "hamza_above"),
    "wawHamza": (0x0624, "R", "waw", "hamza_above"),
    "alefHamzaBelow": (0x0625, "R", "alef", "hamza_below"),
    "yehHamza": (0x0626, "D", "yeh", "hamza_above_yeh"),
    "alef": (0x0627, "R", "alef", None),
    "beh": (0x0628, "D", "beh", "1b"),
    "tehMarbuta": (0x0629, "R", "heh", "2a"),
    "teh": (0x062A, "D", "beh", "2a"),
    "theh": (0x062B, "D", "beh", "3a"),
    "jeem": (0x062C, "D", "hah", "1j"),
    "hah": (0x062D, "D", "hah", None),
    "khah": (0x062E, "D", "hah", "1a"),
    "dal": (0x062F, "R", "dal", None),
    "thal": (0x0630, "R", "dal", "1a"),
    "reh": (0x0631, "R", "reh", None),
    "zain": (0x0632, "R", "reh", "1a"),
    "seen": (0x0633, "D", "seen", None),
    "sheen": (0x0634, "D", "seen", "3a"),
    "sad": (0x0635, "D", "sad", None),
    "dad": (0x0636, "D", "sad", "1a"),
    "tah": (0x0637, "D", "tah", None),
    "zah": (0x0638, "D", "tah", "1a"),
    "ain": (0x0639, "D", "ain", None),
    "ghain": (0x063A, "D", "ain", "1a"),
    "tatweel": (0x0640, "C", "tatweel", None),
    "feh": (0x0641, "D", "feh", "1a"),
    "qaf": (0x0642, "D", "qaf", "2a"),
    "kaf": (0x0643, "D", "kaf", "kafmark"),
    "lam": (0x0644, "D", "lam", None),
    "meem": (0x0645, "D", "meem", None),
    "noon": (0x0646, "D", "noon", "1a"),
    "heh": (0x0647, "D", "heh", None),
    "waw": (0x0648, "R", "waw", None),
    "alefMaksura": (0x0649, "D", "yeh", None),
    "yeh": (0x064A, "D", "yeh", "2b"),
    "alefWasla": (0x0671, "R", "alef", "wasla"),
    "peh": (0x067E, "D", "beh", "3b"),
    "tcheh": (0x0686, "D", "hah", "3j"),
    "jeh": (0x0698, "R", "reh", "3a"),
    "keheh": (0x06A9, "D", "kaf", None),
    "gaf": (0x06AF, "D", "kaf", "gafbar"),
    "farsiYeh": (0x06CC, "D", "yeh", "2b_medial"),
    "tteh": (0x0679, "D", "beh", "smalltah"),
    "ddal": (0x0688, "R", "dal", "smalltah"),
    "rreh": (0x0691, "R", "reh", "smalltah"),
    "noonGhunna": (0x06BA, "D", "noon", "1a_medial"),
    "hehDoachashmee": (0x06BE, "D", "hehdo", None),
    "hehGoal": (0x06C1, "D", "heh", None),
    "yehBarree": (0x06D2, "R", "barree", None),
    "dotlessBeh": (0x066E, "D", "beh", None),
    "dotlessQaf": (0x066F, "D", "qaf", None),
}

MARKS = {
    # name: (codepoint, position)
    "fathatan": (0x064B, "top"), "dammatan": (0x064C, "top"), "kasratan": (0x064D, "bottom"),
    "fatha": (0x064E, "top"), "damma": (0x064F, "top"), "kasra": (0x0650, "bottom"),
    "shadda": (0x0651, "top"), "sukun": (0x0652, "top"), "maddaAbove": (0x0653, "top"),
    "hamzaAbove": (0x0654, "top"), "hamzaBelow": (0x0655, "bottom"),
    "alefSuperscript": (0x0670, "top"),
}

DIGITS_AR = [0x0660 + i for i in range(10)]
DIGITS_FA = [0x06F0 + i for i in range(10)]


def build(style_key="sahel"):
    """Return (glyphs, marks, extras).

    glyphs: {name: dict(path, width, unicode or None, top=(x, y), bottom=(x, y))}
    """
    S = STYLES[style_key]
    pen = S.pen
    jw = pen.width(0)
    JY = jw / 2                       # the baseline stroke sits on the baseline
    vw = pen.width(math.pi / 2)       # width of vertical strokes

    lpen = Pen(min(pen.thick * 0.86, 170), pen.thin * 0.86, math.degrees(pen.angle))

    def ring_at(cx, cy, rx, ry):
        return stroke_closed(ellipse_sk(cx, cy, rx, ry), lpen)

    def free(start=False, end=False):
        return profile(start=S.taper if start else 1, end=S.taper if end else 1,
                       start_len=0.25, end_len=0.25)

    def st(sk, start_free=False, end_free=False, sa=None, ea=None):
        out = stroke(sk, pen, free(start_free, end_free), start_angle=sa, end_angle=ea)
        if S.cap == "round":
            from strokes import _circle
            pts = [sk.segs[0][0]] if start_free else []
            if end_free:
                pts.append(sk.segs[-1][3])
            for (x, y), seg_t in zip(pts, ([0] if start_free else []) + ([1] if end_free else [])):
                seg = sk.segs[0] if seg_t == 0 else sk.segs[-1]
                d = (seg[1][0] - seg[0][0], seg[1][1] - seg[0][1]) if seg_t == 0 else \
                    (seg[3][0] - seg[2][0], seg[3][1] - seg[2][1])
                th = math.atan2(d[1], d[0])
                r = pen.width(th) * S.taper / 2
                out = union(out, _circle(x, y, r * 0.98))
        return out

    def join(x0, x1):
        return stroke(Sk(x1, JY).line(x0, JY), pen, start_angle=90, end_angle=90)

    def tooth(x, h=TOOTH):
        return st(Sk(x, JY).line(x, h), end_free=True, sa=0)

    def stem(x, h=ALEF_H, y0=None):
        y0 = JY if y0 is None else y0
        return st(Sk(x, y0).line(x, h), end_free=True, sa=0)

    def dot_at(x, y):
        r = S.dot_size / 2
        if S.dot == "round":
            return blob(ellipse_sk(x, y, r, r))
        if S.dot == "square":
            from strokes import rounded_rect
            return rounded_rect(x - r, y - r, x + r, y + r, r * 0.25)
        # diamond with softly curved sides
        k = r * 1.12
        sk = Sk(x, y + k)
        sk.curve((x + k * 0.45, y + k * 0.55), (x + k * 0.55, y + k * 0.45), (x + k, y))
        sk.curve((x + k * 0.55, y - k * 0.45), (x + k * 0.45, y - k * 0.55), (x, y - k))
        sk.curve((x - k * 0.45, y - k * 0.55), (x - k * 0.55, y - k * 0.45), (x - k, y))
        sk.curve((x - k * 0.55, y + k * 0.45), (x - k * 0.45, y + k * 0.55), (x, y + k))
        return blob(sk)

    gap = S.dot_size * 1.22

    def dots(n, x, y, below=False):
        if n == 1:
            return dot_at(x, y)
        if n == 2:
            return union(dot_at(x - gap / 2, y), dot_at(x + gap / 2, y))
        dy = gap * 0.86
        if not below:
            return union(dot_at(x - gap / 2, y), dot_at(x + gap / 2, y), dot_at(x, y + dy))
        return union(dot_at(x - gap / 2, y), dot_at(x + gap / 2, y), dot_at(x, y - dy))

    # --- shapes -----------------------------------------------------------
    # each returns (path, width, anchor_x_top, anchor_x_bottom, dot_spot)
    # dot_spot: dict(above=(x, y), below=(x, y), inside=(x, y))

    def beh(form):
        if form == "isol" or form == "fina":
            W = 1180
            right = W - SB - vw / 2
            body = Sk(right if form == "isol" else W - 230, TOOTH if form == "isol" else JY)
            if form == "isol":
                body.curve((right, 160), (right - 40, JY), (right - 220, JY))
            else:
                body.line(W - 380, JY)
            body.line(300, JY).curve((170, JY), (SB + vw / 2, 120), (SB + vw / 2, 330))
            p = st(body, start_free=(form == "isol"), end_free=True, sa=None if form == "isol" else 90)
            if form == "fina":
                p = union(p, join(W - 240, W), tooth(W - 240))
            cx = W / 2 + 40
            return p, W, cx, cx, dict(above=(cx, 560), below=(cx, -230))
        W = 340 if form == "init" else 300
        tx = W - SB - vw / 2 if form == "init" else W / 2
        p = union(tooth(tx), join(0, tx + (vw / 2 if form == "init" else W - tx)))
        return p, W, tx, tx, dict(above=(tx, TOOTH + 240), below=(tx, -230))

    def noon(form):
        if form in ("init", "medi"):
            return beh(form)
        W = 900
        right = W - SB - vw / 2 if form == "isol" else W - 240
        sk = Sk(right, TOOTH if form == "isol" else JY)
        sk.curve((right, 60), (right - 60, BOWL_D), (W / 2 - 20, BOWL_D))
        sk.curve((180, BOWL_D), (SB + vw / 2, -170), (SB + vw / 2, 260))
        p = st(sk, start_free=(form == "isol"), end_free=True)
        if form == "fina":
            p = union(p, join(W - 240, W), tooth(W - 240))
        cx = W / 2 - 10
        return p, W, cx, cx, dict(above=(cx, 300 if form == "isol" else 330), below=(cx, BOWL_D - 260))

    def yeh(form):
        if form in ("init", "medi"):
            return beh(form)
        W = 1040
        if form == "isol":
            sk = Sk(W - 300, 650).curve((W - 470, 640), (W - 520, 470), (W - 380, 360))
            sk.curve((W - 280, 280), (W - SB - vw / 2, 210), (W - SB - vw / 2, 30))
            start_free = True
        else:
            sk = Sk(W, JY).line(W - 200, JY)
            sk.curve((W - 120, JY - 10), (W - SB - vw / 2, -20), (W - SB - vw / 2, -60))
            start_free = False
        sk.curve((W - SB - vw / 2, -320), (W - 330, BOWL_D), (W / 2 - 60, BOWL_D))
        sk.curve((230, BOWL_D), (SB + vw / 2, -300), (SB + vw / 2, -60))
        p = st(sk, start_free=start_free, end_free=True, sa=90 if not start_free else None)
        cx = W / 2 - 40
        return p, W, W - 360, cx, dict(above=(W - 380, 900), below=(cx, BOWL_D - 250))

    def hah(form):
        W = 860 if form in ("isol", "fina") else 760
        head = Sk(150, 590).curve((300, 690), (520, 690), (W - 200, 640))
        diag_end_x = 210
        p = st(head, start_free=True)
        if form in ("init", "medi"):
            d = Sk(W - 200, 640).curve((W - 330, 470), (360, 260), (diag_end_x, JY + 10))
            d.curve((150, JY), (80, JY), (0, JY))
            p = union(p, st(d, ea=90))
            if form == "medi":
                p = union(p, join(diag_end_x, W))
            return p, W, W / 2, 330, dict(above=(W / 2 - 40, 920), below=(330, -260),
                                          inside=(330, -260))
        d = Sk(W - 200, 640).curve((W - 350, 470), (220, 330), (170, 120))
        d.curve((90, -80), (120, -420), (360, DEEP + 70)).curve((520, DEEP - 10), (720, DEEP + 30), (W - SB, DEEP + 160))
        p = union(p, st(d, end_free=True))
        if form == "fina":
            p = union(p, join(250, W))
        return p, W, W / 2, 420, dict(above=(W / 2 - 40, 920), below=(430, DEEP - 230),
                                      inside=(460, -250))

    def dal(form):
        W = 760
        sk = Sk(250, 680).curve((350, 620), (W - 190, 380), (W - 190, 200))
        sk.curve((W - 190, 90), (W - 260, JY), (W - 380, JY)).line(SB + 40, JY)
        p = st(sk, start_free=True, end_free=True)
        if form == "fina":
            p = union(p, join(W - 260, W))
        return p, W, 360, W / 2, dict(above=(330, 960), below=(W / 2, -230))

    def reh(form):
        W = 640
        r = W - SB - vw / 2
        if form == "isol":
            sk = Sk(r, 380).curve((r, 120), (r - 60, -180), (SB, -420))
            p = st(sk, start_free=True, end_free=True)
        else:
            sk = Sk(W, JY).line(r + 20, JY).curve((r - 60, JY - 20), (r - 120, -200), (SB, -430))
            p = st(sk, end_free=True, sa=90)
        return p, W, r - 40, r - 120, dict(above=(r - 20, 640), below=(r, -560))

    def seen(form, teeth=3):
        bowl = form in ("isol", "fina")
        tw = 230
        start = (SB + vw / 2) if not bowl else 0
        left_part = 660 if bowl else 0
        W = left_part + tw * teeth + (SB if form in ("isol", "init") else 0) + (0 if bowl else 110)
        xs = [W - (SB if form in ("isol", "init") else 0) - vw / 2 - i * tw for i in range(teeth)]
        parts = [stroke(Sk(x, JY).line(x, SEEN_T), pen, free(end=True), start_angle=0) for x in xs]
        if S.cap == "round":
            parts = [st(Sk(x, JY).line(x, SEEN_T), end_free=True, sa=0) for x in xs]
        right_end = xs[0] + vw / 2 if form in ("isol", "init") else W
        if bowl:
            sk = Sk(right_end if form == "fina" else xs[0], JY)
            sk.line(xs[-1] - 40, JY)
            sk.curve((xs[-1] - 120, JY), (xs[-1] - 150, -60), (xs[-1] - 160, -140))
            sk.curve((xs[-1] - 170, BOWL_D + 40), (420, BOWL_D), (330, BOWL_D))
            sk.curve((180, BOWL_D), (SB + vw / 2, -200), (SB + vw / 2, 200))
            parts.append(st(sk, end_free=True, sa=90))
        else:
            parts.append(join(0, right_end))
        p = union(*parts)
        cx = xs[1]
        return p, W, cx, cx, dict(above=(cx, SEEN_T + 260), below=(cx, -260))

    def sad_loop(xr, xl, top=430):
        """Oval loop resting on the baseline stroke between xl and xr."""
        cx = (xl + xr) / 2 + 20
        ry = (top - JY) / 2 + 20
        loop = stroke_closed(ellipse_sk(cx, JY + ry - lpen.thin / 2 - 6, (xr - xl) / 2, ry), lpen)
        return loop

    def sad(form, tah=False):
        bowl = form in ("isol", "fina") and not tah
        loop_w = 620
        left = 660 if bowl else 0
        tooth_x = left + 120
        xl = tooth_x + (140 if not tah else 0)
        xr = xl + loop_w
        W = xr + (SB if form in ("isol", "init") else 120)
        parts = [sad_loop(xr, xl), tooth(tooth_x, 330) if not tah else None]
        parts = [p for p in parts if p is not None]
        if form in ("fina", "medi"):
            parts.append(join(xr - 160, W))
        if form in ("init", "medi") or (tah and form in ("fina",)):
            parts.append(join(0, xl + 40))
        if tah:
            parts.append(stem(xl + 150, ALEF_H, JY))
            if form == "isol":
                parts.append(join(SB, xl + 40))
        if bowl:
            sk = Sk(tooth_x, JY).line(tooth_x - 40, JY)
            sk.curve((tooth_x - 120, JY), (tooth_x - 150, -60), (tooth_x - 160, -140))
            sk.curve((tooth_x - 170, BOWL_D + 40), (420, BOWL_D), (330, BOWL_D))
            sk.curve((180, BOWL_D), (SB + vw / 2, -200), (SB + vw / 2, 200))
            parts.append(st(sk, end_free=True, sa=90))
        p = union(*parts)
        cx = (xl + xr) / 2 + 40
        return p, W, cx, cx, dict(above=(cx + (60 if tah else 0), 700), below=(cx, -260))

    def ain(form):
        if form in ("init", "isol"):
            W = 640 if form == "init" else 860
            o = 0 if form == "init" else 140
            tip = (o + 560, 610)
            lip = (o + 380, 380)
            arc = Sk(*tip).curve((o + 470, 710), (o + 250, 700), (o + 240, 560))
            arc.curve((o + 235, 450), (o + 300, 390), lip)
            parts = [st(arc, start_free=True), corner(*lip)]
            if form == "init":
                tail = Sk(*lip).curve((o + 300, 260), (200, JY + 5), (90, JY)).line(0, JY)
                parts.append(st(tail, ea=90))
            else:
                tail = Sk(*lip).curve((150, 280), (90, -150), (330, DEEP + 70))
                tail.curve((500, DEEP - 10), (700, DEEP + 30), (W - SB, DEEP + 160))
                parts.append(st(tail, end_free=True))
            return union(*parts), W, o + 400, 380, dict(above=(o + 400, 940), below=(380, -260))
        W = 520
        cx = W / 2
        loop = stroke_closed(Sk(cx, JY + 20).curve((cx + 190, JY + 40), (cx + 150, 470), (cx, 470))
                             .curve((cx - 150, 470), (cx - 190, JY + 40), (cx, JY + 20)), lpen)
        parts = [loop, join(cx - 120, W)]
        if form == "medi":
            parts.append(join(0, cx + 120))
        else:
            sk = Sk(cx - 100, JY + 30).curve((40, 0), (40, -380), (300, DEEP + 70))
            sk.curve((440, DEEP), (W, DEEP + 40), (W + 60, DEEP + 160))
            parts.append(st(sk, end_free=True))
            W += 120
        p = union(*parts)
        return p, W, cx, cx, dict(above=(cx, 760), below=(cx, -260))

    def fq_loop(cx, rx=165, ry=190):
        return ring_at(cx, JY + ry - lpen.thin / 2, rx, ry)

    def feh(form, qaf=False):
        if form in ("init", "medi"):
            W = 500 if form == "init" else 480
            cx = W - SB - 150 if form == "init" else W / 2
            parts = [fq_loop(cx, 140, 175), join(0, cx + 20)]
            if form == "medi":
                parts.append(join(cx - 20, W))
            p = union(*parts)
            return p, W, cx, cx, dict(above=(cx, 620), below=(cx, -230))
        if qaf:
            W = 940
            lx = W - SB - 160 if form == "isol" else W - 300
            sk = Sk(lx, JY).curve((lx - 40, BOWL_D * 0.4), (lx - 120, BOWL_D), (W / 2 - 80, BOWL_D))
            sk.curve((200, BOWL_D), (SB + vw / 2, -170), (SB + vw / 2, 240))
        else:
            W = 1240
            lx = W - SB - 160 if form == "isol" else W - 300
            sk = Sk(lx, JY).line(300, JY).curve((170, JY), (SB + vw / 2, 120), (SB + vw / 2, 330))
        parts = [fq_loop(lx), st(sk, end_free=True)]
        if form == "fina":
            parts.append(join(lx, W))
        p = union(*parts)
        return p, W, lx, W / 2, dict(above=(lx, 620), below=(W / 2, -230))

    def corner(x, y, th=0.0):
        from strokes import _circle
        return _circle(x, y, pen.width(th) / 2 * 0.98)

    def kaf(form, arabic_mark=True):
        if form in ("isol", "fina"):
            W = 1000 if form == "isol" else 1080
            x = W - SB - vw / 2 if form == "isol" else W - 240
            sk = Sk(x, ALEF_H).line(x, 160).curve((x, JY + 10), (x - 80, JY), (x - 190, JY))
            sk.line(250, JY).curve((150, JY), (SB + vw / 2, 110), (SB + vw / 2, 300))
            parts = [st(sk, start_free=True, end_free=True)]
            if form == "fina":
                parts.append(join(x, W))
            return union(*parts), W, x - 280, W / 2, dict(inside=(x - 300, 560), above=(W / 2, 1000),
                                                         below=(W / 2, -230))
        W = 840 if form == "init" else 800
        xr = W - SB - vw / 2 if form == "init" else W - 200
        cx, cy = 170, 640
        a1 = st(Sk(xr, ALEF_H - 120).line(cx, cy), start_free=True)
        a2 = stroke(Sk(cx, cy).line(xr - 40, JY + 40), pen)
        base = stroke(Sk(xr - 40, JY).line(0, JY), pen, start_angle=90, end_angle=90)
        parts = [a1, a2, base, corner(cx, cy, math.atan2(cy - ALEF_H, 0)), corner(xr - 40, JY + 30, 0)]
        if form == "medi":
            parts.append(join(xr - 60, W))
        p = union(*parts)
        return p, W, W / 2, W / 2, dict(inside=(xr - 220, 720), above=(W / 2, 1000), below=(W / 2, -230))

    def lam(form):
        if form in ("isol", "fina"):
            W = 860
            x = W - SB - vw / 2 if form == "isol" else W - 240
            sk = Sk(x, ALEF_H).line(x, 120).curve((x, -250), (x - 140, BOWL_D), (W / 2 - 60, BOWL_D))
            sk.curve((200, BOWL_D), (SB + vw / 2, -170), (SB + vw / 2, 260))
            p = st(sk, start_free=True, end_free=True)
            if form == "fina":
                p = union(p, join(x, W))
            return p, W, x, W / 2, dict(above=(x, ALEF_H + 200), below=(W / 2, BOWL_D - 250))
        W = 380 if form == "init" else 330
        x = W - SB - vw / 2 if form == "init" else W / 2
        sk = Sk(x, ALEF_H).line(x, 200).curve((x, JY + 20), (x - 60, JY), (x - 160, JY)).line(0, JY)
        parts = [st(sk, start_free=True, ea=90)]
        if form == "medi":
            parts.append(join(x, W))
        p = union(*parts)
        return p, W, x, x, dict(above=(x, ALEF_H + 200), below=(x, -230))

    def meem(form):
        r = 185
        if form in ("init", "medi"):
            W = 480 if form == "init" else 440
            cx = W - SB - r if form == "init" else W / 2
            cy = JY + r - 30 if form == "init" else JY - r + 60
            loop = ring_at(cx, cy, r, r * 0.92)
            parts = [loop, join(0, cx)]
            if form == "medi":
                parts.append(join(cx, W))
            p = union(*parts)
            return p, W, cx, cx, dict(above=(cx, 560), below=(cx, -330))
        W = 560
        cx = W - SB - r - (0 if form == "isol" else 60)
        loop = ring_at(cx, JY + r - 30, r, r * 0.92)
        tail = st(Sk(cx - r + 10, JY + 40).curve((cx - r - 120, JY - 20), (SB + vw / 2, -100),
                                                  (SB + vw / 2, DEEP + 60)), end_free=True)
        parts = [loop, tail]
        if form == "fina":
            parts.append(join(cx, W))
        return union(*parts), W, cx, cx, dict(above=(cx, 560), below=(cx - 120, DEEP - 200))

    def heh(form):
        if form in ("isol", "fina"):
            W = 640
            cx = W / 2 - (0 if form == "isol" else 30)
            ry = 270
            loop = stroke_closed(Sk(cx, JY).curve((cx + 290, JY), (cx + 250, 2 * ry), (cx, 2 * ry + 20))
                                 .curve((cx - 250, 2 * ry), (cx - 290, JY), (cx, JY)), lpen)
            parts = [loop]
            if form == "fina":
                parts.append(join(cx, W))
            return union(*parts), W, cx, cx, dict(above=(cx, 2 * ry + 300), below=(cx, -230))
        if form == "init":
            W = 620
            cx = W / 2 + 20
            outer = ring_at(cx, JY + 270, 240, 290)
            divider = st(Sk(cx, JY).line(cx, JY + 470))
            p = union(outer, divider, join(0, cx))
            return p, W, cx, cx, dict(above=(cx, 900), below=(cx, -230))
        W = 520
        cx = W / 2
        up = ring_at(cx, JY + 200, 170, 210)
        down = ring_at(cx, JY - 190, 150, 170)
        p = union(up, down, join(0, W))
        return p, W, cx, cx, dict(above=(cx, 650), below=(cx, -480))

    def hehdo(form):
        if form == "isol":
            W = 620
            cx = W / 2
            outer = ring_at(cx, JY + 270, 240, 290)
            divider = st(Sk(cx, JY).line(cx, JY + 470))
            return union(outer, divider), W, cx, cx, dict(above=(cx, 900), below=(cx, -230))
        return heh("init" if form == "fina" else form) if form != "fina" else \
            _hehdo_fina()

    def _hehdo_fina():
        W = 700
        cx = W / 2 - 20
        outer = ring_at(cx, JY + 270, 240, 290)
        divider = st(Sk(cx, JY).line(cx, JY + 470))
        return union(outer, divider, join(cx, W)), W, cx, cx, dict(above=(cx, 900), below=(cx, -230))

    def barree(form):
        W = 1300
        r = W - SB - vw / 2 if form == "isol" else W - 240
        if form == "isol":
            sk = Sk(r, 420).curve((r, 200), (r - 60, 40), (r - 200, -40))
        else:
            sk = Sk(W, JY).line(r + 20, JY).curve((r - 60, JY - 10), (r - 120, -20), (r - 200, -40))
        sk.curve((r - 400, -130), (500, -150), (260, -150)).curve((150, -150), (SB + 20, -100), (SB, 40))
        p = st(sk, start_free=(form == "isol"), end_free=True, sa=None if form == "isol" else 90)
        return p, W, r - 60, W / 2, dict(above=(r - 60, 640), below=(W / 2, -400))

    def waw(form):
        W = 760
        cx = W - SB - 160 if form == "isol" else W - 300
        loop = fq_loop(cx)
        tail = st(Sk(cx + 120, JY + 120).curve((cx + 160, -120), (cx - 60, -360), (SB, -440)), end_free=True)
        parts = [loop, tail]
        if form == "fina":
            parts.append(join(cx, W))
        return union(*parts), W, cx, cx, dict(above=(cx, 640), below=(cx, -560))

    def alef(form):
        if form == "isol":
            W = 2 * SB + vw + 40
            x = W / 2
            return stem(x, ALEF_H, 0), W, x, x, dict(above=(x, ALEF_H + 220), below=(x, -230))
        W = 400
        x = SB + vw / 2 + 20
        sk = Sk(x, ALEF_H).line(x, 200).curve((x, JY + 20), (x + 60, JY), (x + 160, JY)).line(W, JY)
        return st(sk, start_free=True, ea=90), W, x, x, dict(above=(x, ALEF_H + 220), below=(x, -230))

    def tatweel(form):
        return join(0, 400), 400, 200, 200, {}

    def hamza(form, scale=1.0):
        W = 560
        sk = Sk(420, 560).curve((300, 650), (130, 590), (150, 460))
        sk.curve((170, 360), (330, 330), (440, 360))
        p = union(st(sk, start_free=True, end_free=True),
                  st(Sk(440, 360).line(110, 220), end_free=True))
        return p, W, 290, 290, {}

    SHAPES = dict(beh=beh, noon=noon, yeh=yeh, hah=hah, dal=dal, reh=reh, seen=seen,
                  sad=sad, tah=lambda f: sad(f, tah=True), ain=ain, feh=feh,
                  qaf=lambda f: feh(f, qaf=True), kaf=kaf, lam=lam, meem=meem, heh=heh,
                  waw=waw, alef=alef, tatweel=tatweel, hamza=hamza, hehdo=hehdo, barree=barree)

    # --- small marks used inside letters (hamza, madda, kaf mark) ------------
    hz, _, _, _, _ = hamza("isol")
    hzb = hz.bounds

    def small_hamza(cx, cy, s=0.5):
        return transformed(hz, Transform().translate(cx, cy).scale(s).translate(-(hzb[0] + hzb[2]) / 2,
                                                                                 -(hzb[1] + hzb[3]) / 2))

    thin_pen = Pen(pen.thick * 0.7, pen.thin * 0.75, math.degrees(pen.angle))

    def madda(cx, cy, w=520):
        sk = Sk(cx - w / 2, cy - 30).curve((cx - w / 4, cy + 90), (cx - 60, cy + 60), (cx, cy))
        sk.curve((cx + 60, cy - 60), (cx + w / 4, cy - 90), (cx + w / 2, cy + 30))
        return stroke(sk, thin_pen)

    # --- assemble every letter in every form --------------------------------
    glyphs = {}
    forms_of = {"D": ("isol", "init", "medi", "fina"), "R": ("isol", "fina"), "U": ("isol",),
                "C": ("isol",)}
    for name, (cp, jt, shape, extra) in LETTERS.items():
        for form in forms_of[jt]:
            p, W, tx, bx, spot = SHAPES[shape](form)
            top_y = None
            add = []
            if extra:
                above = spot.get("above")
                below = spot.get("below")
                inside = spot.get("inside", below)
                if extra == "smalltah":
                    sp = Pen(pen.thick * 0.6, pen.thin * 0.66, math.degrees(pen.angle))
                    x0, y0 = above[0], above[1] - 140
                    add.append(union(stroke_closed(ellipse_sk(x0 + 40, y0 + 70, 110, 70), sp),
                                     stroke(Sk(x0 - 30, y0 + 20).line(x0 - 30, y0 + 330), sp)))
                elif extra == "1a_medial":
                    if form in ("init", "medi"):
                        add.append(dots(1, above[0], above[1]))
                elif extra in ("1a", "2a", "3a"):
                    n = int(extra[0])
                    y = above[1] - (60 if n == 3 else 0)
                    add.append(dots(n, above[0], y))
                elif extra in ("1b", "2b", "3b") or (extra == "2b_medial" and form in ("init", "medi")):
                    n = int(extra[0])
                    add.append(dots(n, below[0], below[1], below=True))
                elif extra in ("1j", "3j"):
                    n = int(extra[0])
                    add.append(dots(n, inside[0], inside[1] + (60 if n == 3 else 0), below=True))
                elif extra == "hamza_above":
                    add.append(small_hamza(above[0], above[1] - 20, 0.62))
                elif extra == "hamza_below":
                    add.append(small_hamza(below[0], below[1] - 20, 0.62))
                elif extra == "hamza_above_yeh":
                    pos = (tx, TOOTH + 260) if form in ("init", "medi") else (above[0], above[1] - 120)
                    add.append(small_hamza(pos[0], pos[1], 0.62))
                elif extra == "madda":
                    add.append(madda(above[0], above[1] - 60))
                elif extra == "wasla":
                    sk = Sk(above[0] - 160, above[1] - 40).curve((above[0] - 120, above[1] + 120),
                                                                 (above[0] + 140, above[1] + 120),
                                                                 (above[0] + 200, above[1]))
                    add.append(stroke(sk, thin_pen))
                elif extra == "kafmark" and form in ("init", "medi"):
                    pass
                elif extra == "kafmark":
                    ins = spot["inside"]
                    add.append(small_hamza(ins[0], ins[1], 0.55))
                elif extra == "gafbar":
                    if form in ("isol", "fina"):
                        x = SB + vw / 2
                        add.append(st(Sk(x + 120, ALEF_H + 40).line(x + 560, ALEF_H + 220),
                                      start_free=True, end_free=True))
                    else:
                        add.append(st(Sk(260, ALEF_H + 120).line(620, ALEF_H + 210),
                                      start_free=True, end_free=True))
            if add:
                p = union(p, *add)
            gname = "%s-ar%s" % (name, "" if form == "isol" else "." + form)
            glyphs[gname] = dict(path=p, width=round(W), unicode=cp if form == "isol" else None,
                                 top_x=tx, bottom_x=bx, form=form, base=name)

    # lam-alef ligatures
    for suffix, extra in (("", None), ("Madda", "madda"), ("HamzaAbove", "hamza_above"),
                          ("HamzaBelow", "hamza_below")):
        for form in ("isol", "fina"):
            W = 820
            xr = W - SB - vw / 2 if form == "isol" else W - 240
            xa = SB + vw / 2 + 30
            lam_s = Sk(xr, ALEF_H).line(xr, 300).curve((xr, 120), (xr - 80, JY), (xr - 220, JY))
            lam_s.line(xa + 120, JY)
            alef_s = Sk(xa - 30, ALEF_H).line(xa + 160, JY + 30)
            parts = [st(lam_s, start_free=True), st(alef_s, start_free=True, ea=0)]
            if form == "fina":
                parts.append(join(xr, W))
            if extra == "madda":
                parts.append(madda(xa, ALEF_H + 160, 420))
            elif extra == "hamza_above":
                parts.append(small_hamza(xa, ALEF_H + 200, 0.62))
            elif extra == "hamza_below":
                parts.append(small_hamza(xa + 130, -240, 0.62))
            p = union(*parts)
            gname = "lam_alef%s-ar%s" % (suffix, "" if form == "isol" else ".fina")
            glyphs[gname] = dict(path=p, width=W, unicode=None, top_x=(xa + xr) / 2,
                                 bottom_x=W / 2, form=form, base="lam_alef" + suffix)

    # --- harakat --------------------------------------------------------------
    marks = {}
    mpen = Pen(pen.thick * 0.62, pen.thin * 0.62, math.degrees(pen.angle))

    def fatha(cx, cy):
        return stroke(Sk(cx + 110, cy + 60).line(cx - 110, cy - 60), mpen)

    def damma(cx, cy, s=0.42):
        loop = stroke_closed(ellipse_sk(cx + 40, cy + 40, 80 * s / 0.42, 80 * s / 0.42), mpen)
        tail = stroke(Sk(cx + 120 * s / 0.42, cy + 20).curve((cx + 120, cy - 100), (cx - 20, cy - 160),
                                                              (cx - 140, cy - 170)), mpen)
        return union(loop, tail)

    MY = 0            # marks are drawn around y=0 and positioned by anchors
    marks["fatha"] = fatha(0, MY)
    marks["kasra"] = fatha(0, MY)
    marks["fathatan"] = union(fatha(0, MY + 85), fatha(0, MY - 85))
    marks["kasratan"] = union(fatha(0, MY + 85), fatha(0, MY - 85))
    marks["damma"] = damma(0, MY)
    marks["dammatan"] = union(damma(-90, MY), damma(110, MY + 40))
    marks["sukun"] = stroke_closed(ellipse_sk(0, MY, 95, 95), mpen)
    sh = Sk(-200, MY + 120).curve((-200, MY - 30), (-90, MY - 40), (-70, MY + 40))
    sh.curve((-60, MY - 50), (60, MY - 50), (70, MY + 40))
    sh.curve((90, MY - 40), (200, MY - 30), (200, MY + 120))
    marks["shadda"] = stroke(sh, mpen)
    marks["maddaAbove"] = madda(0, MY, 440)
    marks["hamzaAbove"] = small_hamza(0, MY, 0.62)
    marks["hamzaBelow"] = small_hamza(0, MY, 0.62)
    marks["alefSuperscript"] = stroke(Sk(0, MY - 150).line(0, MY + 150), mpen)

    # --- digits ------------------------------------------------------------
    digits = {}
    DH = 1100
    dpen = pen
    W = 860
    c = W / 2

    def dg(*sks, ends=True):
        return union(*[st(s, start_free=ends, end_free=ends) for s in sks])

    one = dg(Sk(c - 40, DH).curve((c + 10, DH * 0.6), (c + 20, DH * 0.3), (c + 10, 0)))
    one2 = dg(Sk(c - 120, DH - 40).curve((c - 80, DH * 0.6), (c - 70, DH * 0.3), (c - 80, 0)))
    two = union(one2, st(Sk(c - 115, DH - 60).curve((c + 20, DH - 120), (c + 200, DH - 100), (c + 240, DH + 20)),
                         end_free=True))
    three = union(one2, st(Sk(c - 115, DH - 80).curve((c - 40, DH - 200), (c + 70, DH - 190), (c + 60, DH + 20))
                           .curve((c + 80, DH - 200), (c + 220, DH - 210), (c + 270, DH + 30)),
                           end_free=True))
    four = dg(Sk(c + 160, DH).curve((c - 220, DH - 40), (c - 200, DH * 0.55), (c + 60, DH * 0.55))
              .curve((c - 260, DH * 0.5), (c - 240, 40), (c + 200, 20)))
    five = stroke_closed(Sk(c, 20).curve((c + 330, 20), (c + 300, DH * 0.6), (c + 80, DH * 0.8))
                         .curve((c + 20, DH * 0.85), (c - 20, DH * 0.85), (c - 80, DH * 0.8))
                         .curve((c - 300, DH * 0.6), (c - 330, 20), (c, 20)), pen)
    six = dg(Sk(c - 250, DH - 20).curve((c - 30, DH), (c + 120, DH * 0.95), (c + 110, DH * 0.7))
             .line(c + 100, 0))
    seven = dg(Sk(c - 300, DH).line(c, 30), Sk(c + 300, DH).line(c, 30), ends=False)
    seven = union(st(Sk(c - 300, DH).line(c - 10, 30), start_free=True, ea=0),
                  st(Sk(c + 300, DH).line(c + 10, 30), start_free=True, ea=0))
    eight = transformed(seven, Transform(1, 0, 0, -1, 0, DH + 30))
    nine = union(stroke_closed(ellipse_sk(c - 80, DH * 0.72, 190, 240), pen),
                 st(Sk(c + 100, DH * 0.72).line(c + 100, 0), end_free=True))
    zero = dot_at(c, DH * 0.45) if S.dot != "round" else blob(ellipse_sk(c, DH * 0.45, 120, 140))
    ar = [zero, one, two, three, four, five, six, seven, eight, nine]
    for i, p in enumerate(ar):
        digits[DIGITS_AR[i]] = (p, W)
    # Persian 4, 5, 6 differ
    fa4 = union(one2, st(Sk(c - 115, DH - 20).curve((c - 10, DH - 40), (c + 70, DH - 70), (c + 40, DH - 170))
                         .curve((c + 150, DH - 140), (c + 240, DH - 150), (c + 250, DH - 250)),
                         end_free=True))
    fa5 = stroke_closed(Sk(c, DH).curve((c + 330, DH * 0.6), (c + 300, 20), (c, 20))
                        .curve((c - 300, 20), (c - 330, DH * 0.6), (c, DH)), pen)
    fa6 = dg(Sk(c + 260, DH).curve((c - 100, DH * 0.9), (c - 220, DH * 0.6), (c - 40, DH * 0.5))
             .curve((c + 100, DH * 0.45), (c + 60, 300), (c - 240, 0)))
    for i, p in enumerate(ar):
        q = {4: fa4, 5: fa5, 6: fa6}.get(i, p)
        digits[DIGITS_FA[i]] = (q, W)
    return glyphs, marks, digits, S

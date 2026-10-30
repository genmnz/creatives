"""True lowercase for Nymph Heading.

Drawn with the stroke engine in the idiom of the capitals: plain stems with
the I's softened corners, bowls with the O's vertical stress, right-hand stems
that finish in the curled foot of R and K, and hooks taken from J and the
figures.  c o s v w x z keep the capitals' shapes (as in almost every
typeface) and are re-proportioned and re-weighted from them.
"""

import math

from fontTools.misc.transform import Transform

from geometry import (difference, intersection, path_of, rect, runs_at_y,
                      transformed, union)
from strokes import (Pen, Sk, ellipse_sk, profile, rounded_rect, stroke,
                     stroke_closed)

X = 1010            # x-height
ASC = 1640          # ascender
DESC = -500         # descender
OS = 16             # overshoot of rounds
ST = 186            # stem
TH = 96             # hairline
BOWL = 204          # thickest part of bowls

PEN = Pen(BOWL, TH, 0)          # vertical stress, like the O
STEM_PEN = Pen(ST, TH, 0)
DIAG = Pen(ST + 6, TH, 52)      # diagonals: thick down-right, thin up-right


def stem(x, y0, y1, w=ST):
    return rounded_rect(x - w / 2, y0, x + w / 2, y1, 26)


def foot(x, top, reach=150, end=(None, None)):
    """Right-hand stem that ends in a curled foot (the R / K leg idiom)."""
    ex = x + reach
    sk = Sk(x, top).line(x, 210).curve((x, 70), (x + 40, OS + TH / 2 - 10),
                                       (x + 95, OS + TH / 2 - 8))
    sk.curve((x + 125, OS + TH / 2 - 8), (ex - 15, 40), (ex, 78))
    return stroke(sk, STEM_PEN, profile(end=0.42, end_len=0.3), start_angle=0)


def dot(cx, cy, r=118):
    sk = ellipse_sk(cx, cy, r, r * 1.02)
    from strokes import blob
    return blob(sk)


def ring(cx, cy, rx, ry, pen=PEN):
    return stroke_closed(ellipse_sk(cx, cy, rx, ry), pen)


def bowl_dims(x0, x1):
    """Centre-line ellipse for an x-height bowl whose ink spans x0..x1."""
    rx = (x1 - x0 - BOWL) / 2
    ry = (X + 2 * OS - TH) / 2
    return (x0 + x1) / 2, X / 2, rx, ry


def arch(x_stem, x_right, top=X, start_y=None):
    """The n-arch: springs thin out of the stem, full stroke on the right."""
    start_y = start_y if start_y is not None else top - 330
    peak = top + OS - TH / 2
    mid = (x_stem + x_right) / 2 + 30
    sk = Sk(x_stem, start_y)
    sk.curve((x_stem + 40, top - 120), (mid - 190, peak), (mid, peak))
    sk.curve((x_right - 90, peak), (x_right, top - 150), (x_right, top - 330))
    sk.line(x_right, top - 340)
    return stroke(sk, STEM_PEN, profile(start=0.42, start_len=0.35))


def hook_down(x, y_top, reach_left=330, depth=DESC, ball=True):
    """Stem descending into a hook curling left (the J tail)."""
    bot = depth + OS + TH / 2
    sk = Sk(x, y_top).line(x, depth + 330)
    sk.curve((x, depth + 120), (x - 80, bot), (x - 190, bot))
    sk.curve((x - 270, bot), (x - reach_left + 10, depth + 60), (x - reach_left, depth + 160))
    out = stroke(sk, STEM_PEN, profile(end=0.75, end_len=0.25), start_angle=0)
    if ball:
        out = union(out, dot(x - reach_left + 52, depth + 150, 64))
    return out


def build(font, derive_x):
    """Return {name: (path, advance)}.  derive_x(src, dst, sx) re-proportions caps."""
    g = {}

    # --- n m h -------------------------------------------------------------
    def n_like(left=100, width=1110, asc=False):
        xs = left + ST / 2
        xr = width - 260
        parts = [stem(xs, 0, ASC if asc else X), arch(xs, xr), foot(xr, X - 330)]
        return union(*parts)

    g["n"] = (n_like(), 1130)
    g["h"] = (n_like(asc=True), 1130)
    xs = 100 + ST / 2
    m = union(stem(xs, 0, X), arch(xs, 700), stem(700, 0, X - 330),
              arch(700, 1300), foot(1300, X - 330))
    g["m"] = (m, 1580)

    # --- u ---------------------------------------------------------------
    xl, xr = 100 + ST / 2, 870
    bot = -OS + TH / 2
    sk = Sk(xl, X).line(xl, 330).curve((xl, 90), (360, bot), (500, bot))
    sk.curve((700, bot), (xr, 150), (xr, 380))
    u = union(stroke(sk, STEM_PEN, profile(end=0.5, end_len=0.3), start_angle=0),
              foot(xr, X))
    g["u"] = (u, 1130)

    # --- l i j dotless -----------------------------------------------------
    g["l"] = (foot(100 + ST / 2, ASC), 560)
    g["dotlessi"] = (stem(100 + ST / 2, 0, X), 386)
    g["i"] = (union(stem(100 + ST / 2, 0, X), dot(100 + ST / 2, X + 260)), 386)
    jx = 330
    g["uni0237"] = (hook_down(jx, X, 300), 540)
    g["j"] = (union(hook_down(jx, X, 300), dot(jx, X + 260)), 540)

    # --- b d p q ---------------------------------------------------------
    sx = 100 + ST / 2
    cx, cy, rx, ry = bowl_dims(sx - BOWL / 2, 1060)
    g["b"] = (union(stem(sx, 0, ASC), ring(cx, cy, rx, ry)), 1130)
    g["p"] = (union(stem(sx, DESC, X), ring(cx, cy, rx, ry)), 1130)
    cx, cy, rx, ry = bowl_dims(70, 960 + BOWL / 2 - ST / 2)
    dx = 960
    g["d"] = (union(ring(cx, cy, rx, ry), foot(dx, ASC)), 1180)
    g["q"] = (union(ring(cx, cy, rx, ry), stem(dx, DESC, X)), 1140)

    # --- g -----------------------------------------------------------------
    gx = 930
    cx, cy, rx, ry = bowl_dims(70, gx + BOWL / 2 - ST / 2)
    g["g"] = (union(ring(cx, cy + 20, rx, ry - 20), hook_down(gx, X, 470, DESC, True)), 1120)

    # --- a -------------------------------------------------------------------
    ax = 820
    peak = X + OS - TH / 2
    sk = Sk(170, X - 210).curve((240, X - 40), (370, peak), (520, peak))
    sk.curve((720, peak), (ax, X - 120), (ax, X - 330))
    top = stroke(sk, STEM_PEN, profile(start=0.95, start_len=0.2))
    term = dot(205, X - 230, 92)
    bowl_top = 560
    sk = Sk(ax, bowl_top).curve((620, bowl_top + 10), (460, bowl_top - 10), (330, bowl_top - 60))
    sk.curve((170, bowl_top - 120), (110, 360), (110, 260))
    sk.curve((110, 90), (230, -OS + TH / 2), (390, -OS + TH / 2))
    sk.curve((580, -OS + TH / 2), (720, 70), (ax, 210))
    bwl = stroke(sk, PEN, profile(start=0.55, start_len=0.25))
    g["a"] = (union(top, term, bwl, foot(ax, X - 330)), 1060)

    # --- e -----------------------------------------------------------------
    cx, cy, rx, ry = bowl_dims(70, 1020)
    bar_y = cy + 40
    sk = Sk(cx + rx, bar_y).arc(cx, cy, rx, ry, math.degrees(math.asin(40 / ry)), 325)
    e_bowl = stroke(sk, PEN, profile(end=0.6, end_len=0.25))
    bar = rect(cx - rx, bar_y - TH / 2, cx + rx + BOWL / 2 - 10, bar_y + TH / 2)
    g["e"] = (union(e_bowl, bar), 1090)

    # --- f t r -----------------------------------------------------------
    fx = 100 + ST / 2 + 60
    sk = Sk(fx, 0).line(fx, ASC - 360)
    sk.curve((fx, ASC - 90), (fx + 110, ASC + OS - TH / 2), (fx + 260, ASC + OS - TH / 2))
    sk.curve((fx + 360, ASC + OS - TH / 2), (fx + 420, ASC - 50), (fx + 440, ASC - 110))
    f = union(stroke(sk, STEM_PEN, profile(end=0.75, end_len=0.2), start_angle=0),
              dot(fx + 430, ASC - 150, 62),
              rect(60, X - TH, fx + 290, X))
    g["f"] = (f, 700)

    tx = 100 + ST / 2 + 40
    sk = Sk(tx, X + 300).line(tx, 260).curve((tx, 80), (tx + 80, -OS + TH / 2), (tx + 210, -OS + TH / 2))
    sk.curve((tx + 300, -OS + TH / 2), (tx + 360, 30), (tx + 390, 90))
    t = union(stroke(sk, STEM_PEN, profile(end=0.55, end_len=0.25), start_angle=-28),
              rect(50, X - TH, tx + 300, X))
    g["t"] = (t, 720)

    rx_ = 100 + ST / 2
    sk = Sk(rx_, X - 300).curve((rx_ + 40, X - 110), (rx_ + 170, X + OS - TH / 2),
                                (rx_ + 330, X + OS - TH / 2))
    sk.curve((rx_ + 420, X + OS - TH / 2), (rx_ + 480, X - 20), (rx_ + 500, X - 70))
    r = union(stem(rx_, 0, X), stroke(sk, STEM_PEN, profile(start=0.42, start_len=0.35, end=0.8)),
              dot(rx_ + 486, X - 110, 70))
    g["r"] = (r, 800)

    # --- k (K's arm and leg, brought down to the x-height) ------------------
    kp = path_of(font, "K")
    kstem_r = runs_at_y(font, "K", 300)[0][1]
    arm = intersection(kp, rect(kstem_r - 30, -200, 3000, 3000))
    sy = (X + 10) / 1573
    arm = transformed(arm, Transform().translate(100 + ST - 30, 0).scale(0.78, sy)
                      .translate(-(kstem_r - 30), 0))
    g["k"] = (union(stem(100 + ST / 2, 0, ASC), arm), 1040)

    # --- y: v-shape whose thin arm runs on into the J tail -----------------
    sk = Sk(80, X).line(500, 60)
    left = stroke(sk, DIAG, start_angle=0, end_angle=0)
    sk = Sk(940, X).line(520, -120).curve((450, -290), (380, DESC + OS + 48), (250, DESC + OS + 48))
    sk.curve((170, DESC + OS + 48), (110, DESC + 90), (100, DESC + 150))
    right = stroke(sk, DIAG, profile(end=1.4, end_len=0.15), start_angle=0)
    y = union(left, right, dot(128, DESC + 150, 62))
    g["y"] = (y, 1020)

    # --- c o s v w x z: the capitals re-proportioned ------------------------
    for ch, sx_ in (("c", 0.64), ("o", 0.62), ("s", 0.7), ("v", 0.66), ("w", 0.64),
                    ("x", 0.66), ("z", 0.7)):
        derive_x(ch.upper(), ch, sx_)
    return g


def build_extras(font):
    """Letters built from the new lowercase: ß æ œ ø ð þ ł ħ ŧ đ ŋ ĸ ə."""
    g = {}
    P = lambda n: path_of(font, n)
    W = lambda n: font[n].width

    # sharp s: a tall stem arching into the B's double bowl, scaled to ascender
    sx = 100 + ST / 2
    bp = path_of(font, "B")
    b_stem_r = runs_at_y(font, "B", 800)[0][1]
    bowls = intersection(bp, rect(b_stem_r - 20, -100, 3000, 3000))
    sc = (ASC - 40) / 1573
    bowls = transformed(bowls, Transform().translate(sx + ST / 2 - 20, 0).scale(0.74, sc)
                        .translate(-(b_stem_r - 20), 0))
    g["germandbls"] = (union(stem(sx, 0, ASC - 300), bowls,
                             stroke(Sk(sx, ASC - 320).curve((sx, ASC - 120), (sx + 80, ASC + OS - TH / 2),
                                                            (sx + 230, ASC + OS - TH / 2)), STEM_PEN)),
                       1050)
    # ae / oe: a + e, o + e sharing a stroke
    g["ae"] = (union(P("a"), transformed(P("e"), Transform().translate(W("a") - 300, 0))),
               W("a") + W("e") - 300)
    g["oe"] = (union(P("o"), transformed(P("e"), Transform().translate(W("o") - 260, 0))),
               W("o") + W("e") - 260)
    ob = P("o").bounds
    slash = Sk(ob[0] + 20, -60).line(ob[2] - 20, X + 60)
    g["oslash"] = (union(P("o"), stroke(slash, Pen(TH + 10, TH + 10, 0))), W("o"))
    # eth: round bowl with a tall curved back and a crossing stroke
    cx, cy, rx, ry = bowl_dims(70, 960)
    sk = Sk(cx + rx, cy + 40).curve((cx + rx, X + 250), (cx + 80, ASC - 220), (cx - 200, ASC - 30))
    back = stroke(sk, PEN, profile(end=0.6, end_len=0.3))
    cross = stroke(Sk(cx - 160, ASC - 420).line(cx + 340, ASC - 200), Pen(TH, TH, 0))
    g["eth"] = (union(ring(cx, cy, rx, ry), back, cross), 1030)
    # thorn: p with the stem running up to the ascender
    g["thorn"] = (union(P("p"), stem(sx, X - 50, ASC)), W("p"))
    # stroked letters
    def bar_at(x0, x1, y):
        return rect(x0, y - TH / 2, x1, y + TH / 2)
    g["lslash"] = (union(transformed(P("l"), Transform().translate(60, 0)),
                         stroke(Sk(sx + 60 - 200, X - 60).line(sx + 60 + 200, X + 220), Pen(TH, TH, 0))),
                   W("l") + 60)
    g["hbar"] = (union(P("h"), bar_at(20, sx + 320, ASC - 300)), W("h"))
    g["tbar"] = (union(P("t"), bar_at(90, 520, X - 380)), W("t"))
    g["dcroat"] = (union(P("d"), bar_at(700, 1150, ASC - 300)), W("d") + 30)
    # eng: n whose right stem runs down into the J tail
    xr = 1130 - 260
    g["eng"] = (union(stem(sx, 0, X), arch(sx, xr), hook_down(xr, X - 330, 300, DESC, True)), 1130)
    # kra: the k arm on a short stem
    kb = font["k"]
    g["kgreenlandic"] = (union(intersection(P("k"), rect(-100, -100, 3000, X + 20)),
                               stem(sx, 0, X)), W("k"))
    # schwa: e turned round
    eb = P("e").bounds
    g["uni0259"] = (transformed(P("e"), Transform(-1, 0, 0, -1, eb[0] + eb[2], eb[1] + eb[3])), W("e"))
    return g

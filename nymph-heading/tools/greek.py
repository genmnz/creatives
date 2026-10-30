"""Monotonic Greek for Nymph Heading.

Capitals that share a shape with Latin are components of the Latin glyphs.
The rest are built from the capitals' own parts (E's flared arms, H's stems,
O's bowl...).  Lowercase is drawn with the same stroke engine and idiom as
the Latin lowercase.
"""

import math

from fontTools.misc.transform import Transform

from geometry import (difference, intersection, path_of, rect, runs_at_x,
                      runs_at_y, transformed, union)
import lowercase as LC
from lowercase import ASC, BOWL, DESC, OS, ST, TH, X, dot, foot, hook_down, ring, stem
from strokes import Pen, Sk, profile, stroke

CAP = 1573
THIN = 111

SHARED_CAPS = {
    0x0391: "A", 0x0392: "B", 0x0395: "E", 0x0396: "Z", 0x0397: "H", 0x0399: "I",
    0x039A: "K", 0x039C: "M", 0x039D: "N", 0x039F: "O", 0x03A1: "P", 0x03A4: "T",
    0x03A5: "Y", 0x03A7: "X",
}
SHARED_LOWER = {0x03BF: "o", 0x03BD: "v", 0x03BC: "mu", 0x03BA: "kgreenlandic"}


def caps(font):
    """{name: (path, width, codepoint)} for the Greek capitals that need drawing."""
    g = {}
    P = lambda n: path_of(font, n)
    W = lambda n: font[n].width

    # E's arms, isolated, give flared bars; mirrored they flare at both ends
    e_stem_r = runs_at_y(font, "E", 800)[0][1]
    e = P("E")
    top_arm = intersection(e, rect(e_stem_r - 5, CAP - 200, 3000, CAP + 100))
    bot_arm = intersection(e, rect(e_stem_r - 5, -100, 3000, 200))
    mid_arm = intersection(e, rect(e_stem_r - 5, 600, 3000, 1000))

    def flared_bar(arm, x0, x1):
        """A bar spanning x0..x1 with the E arm's flared terminal at both ends."""
        b = arm.bounds
        tip = intersection(arm, rect(b[2] - 200, -1000, b[2] + 10, 3000))
        tb = tip.bounds
        right = transformed(tip, Transform().translate(x1 - tb[2], 0))
        left = transformed(right, Transform(-1, 0, 0, 1, x0 + x1, 0))
        core = rect(x0 + 150, tb[1] if tb[1] > 100 else b[1], x1 - 150,
                    (tb[1] if tb[1] > 100 else b[1]) + THIN)
        # the arm's straight part: take its thickness where it leaves the stem
        y0 = runs_at_x_arm(arm, b[0] + 60)
        core = rect(x0 + 150, y0[0], x1 - 150, y0[1])
        return union(left, right, core)

    def runs_at_x_arm(arm, x):
        cut = intersection(arm, rect(x - 1, -1000, x + 1, 3000)).bounds
        return cut[1], cut[3]

    # Gamma: L turned over
    lb = font["L"].getBounds(font)
    g["Gamma"] = (transformed(P("L"), Transform(1, 0, 0, -1, 0, CAP)), W("L"), 0x0393)

    # Lambda and Delta: A without its crossbar
    a = P("A")
    inner_hi = runs_at_y(font, "A", 640)
    inner_lo = runs_at_y(font, "A", 250)
    hole = [(inner_lo[0][1], 250), (inner_hi[0][1], 640), (inner_hi[-1][0], 640),
            (inner_lo[-1][0], 250)]
    from geometry import polygon
    poly = polygon([(hole[0][0] + 2, 200), (hole[1][0] + 2, 700), (hole[2][0] - 2, 700),
                    (hole[3][0] - 2, 200)])
    legs = difference(a, intersection(poly, rect(-100, 330, 3000, 560)))
    g["uni039B"] = (legs, W("A"), 0x039B)
    ab = a.bounds
    g["uni0394"] = (union(legs, flared_bar(bot_arm, ab[0] + 30, ab[2] - 30)), W("A"), 0x0394)

    # Theta: O with a bar
    ob = P("O").bounds
    cx = (ob[0] + ob[2]) / 2
    g["Theta"] = (union(P("O"), rect(cx - 380, CAP / 2 - 60, cx + 380, CAP / 2 + 60)), W("O"), 0x0398)

    # Xi: three flared bars
    w = 1180
    xi = union(flared_bar(top_arm, 110, w - 110), flared_bar(mid_arm, 240, w - 240),
               flared_bar(bot_arm, 90, w - 90))
    g["Xi"] = (xi, w, 0x039E)

    # Pi: H's stems under a top bar
    h = P("H")
    hstems = difference(h, rect(340, 400, 1073, 1100))
    g["Pi"] = (union(hstems, rect(143, CAP - THIN - 5, 1270, CAP)), W("H"), 0x03A0)

    # Sigma: flared top and bottom bars, a thick and a thin diagonal
    diag = Pen(200, 104, 52)
    sig = union(intersection(e, rect(-100, CAP - 200, 3000, CAP + 100)),
                intersection(e, rect(-100, -100, 3000, 200)),
                stroke(Sk(150, CAP - 60).line(640, CAP / 2), diag, start_angle=0),
                stroke(Sk(640, CAP / 2).line(150, 60), diag, end_angle=0))
    sig = difference(sig, rect(-100, 200, 140, CAP - 200))
    g["Sigma"] = (sig, W("E"), 0x03A3)

    # Phi: stem through a flattened bowl
    o_small = transformed(P("O"), Transform().translate(cx, CAP / 2).scale(0.72, 0.62)
                          .translate(-cx, -(ob[1] + ob[3]) / 2))
    g["Phi"] = (union(o_small, rect(cx - 98, 0, cx + 98, CAP)), W("O") - 200, 0x03A6)

    # Psi: U's arms on a stem
    ub = P("U").bounds
    ucx = (ub[0] + ub[2]) / 2
    arms = transformed(P("U"), Transform().translate(ucx, CAP).scale(1.0, 0.62).translate(-ucx, -CAP))
    g["Psi"] = (union(arms, rect(ucx - 98, 0, ucx + 98, CAP)), W("U"), 0x03A8)

    # Omega: the O opened at the foot, standing on two short feet
    om = difference(P("O"), rect(cx - 260, -100, cx + 260, 330))
    feet = union(rect(cx - 640, 0, cx - 250, THIN), rect(cx + 250, 0, cx + 640, THIN))
    g["Omega"] = (union(om, feet), W("O"), 0x03A9)
    return g


def lower(font):
    """{name: (path, width, codepoint)} for the Greek lowercase."""
    g = {}
    P = lambda n: path_of(font, n)
    W = lambda n: font[n].width
    pen = LC.PEN
    sp = LC.STEM_PEN

    # alpha: bowl with a right stroke ending in the curled foot
    cx, cy, rx, ry = LC.bowl_dims(70, 900)
    g["alpha"] = (union(ring(cx, cy, rx, ry), foot(900 - LC.BOWL / 2 + ST / 2 - 10, X - 60)), 1120, 0x03B1)

    # beta: the sharp-s construction on a descending stem
    beta = union(P("germandbls"), stem(100 + ST / 2, DESC, 200))
    g["beta"] = (beta, W("germandbls"), 0x03B2)

    # gamma: v whose arms meet below the line in a small loop
    diag = LC.DIAG
    gm = union(stroke(Sk(80, X).line(470, -120), diag, start_angle=0),
               stroke(Sk(900, X).line(490, -120), diag, start_angle=0),
               ring(480, -300, 90, 170, Pen(TH + 30, TH, 0)))
    g["gamma"] = (gm, 1000, 0x03B3)

    # delta: bowl with a hooked stroke rising from its top
    cx, cy, rx, ry = LC.bowl_dims(70, 960)
    sk = Sk(cx + 60, X).curve((cx - 260, X + 140), (cx - 220, ASC - 80), (cx + 60, ASC - 50))
    sk.curve((cx + 200, ASC - 40), (cx + 300, ASC - 90), (cx + 340, ASC - 160))
    g["delta"] = (union(ring(cx, cy, rx, ry), stroke(sk, pen, profile(start=0.6, end=0.7)),
                        dot(cx + 330, ASC - 190, 64)), 1030, 0x03B4)

    # epsilon: two small open bowls, like a reversed 3
    sk = Sk(760, X - 150).curve((700, X + 10), (520, X + OS - TH / 2), (420, X + OS - TH / 2))
    sk.curve((240, X + OS - TH / 2), (170, X - 120), (170, X - 230))
    sk.curve((170, 600), (300, 540), (470, 540))
    top = stroke(sk, pen, profile(start=0.55, start_len=0.2))
    sk = Sk(470, 540).curve((260, 540), (120, 450), (120, 290))
    sk.curve((120, 90), (290, -OS + TH / 2), (450, -OS + TH / 2))
    sk.curve((600, -OS + TH / 2), (730, 40), (800, 170))
    bot = stroke(sk, pen, profile(end=0.6, end_len=0.25))
    g["epsilon"] = (union(top, bot, rect(420, 540 - TH / 2, 560, 540 + TH / 2)), 900, 0x03B5)

    # zeta: bar, long diagonal sweep, tail below the line
    sk = Sk(760, ASC - 220).curve((450, ASC - 330), (130, 900), (130, 450))
    sk.curve((130, 150), (300, 40), (520, 40))
    sk.curve((720, 40), (780, -60), (760, -170))
    sk.curve((740, -300), (640, -380), (520, -400))
    zeta = union(rect(200, ASC - 220 - TH / 2, 780, ASC - 220 + TH / 2),
                 stroke(sk, pen, profile(start=0.6, end=0.6)))
    g["zeta"] = (zeta, 900, 0x03B6)

    # eta: n whose right stem runs straight down
    xs = 100 + ST / 2
    xr = 1110 - 260
    g["eta"] = (union(stem(xs, 0, X), LC.arch(xs, xr), stem(xr, DESC, X - 330)), 1110, 0x03B7)

    # theta: tall oval with a bar
    cx, cy = 530, ASC / 2 - 10
    th = union(ring(cx, cy, 340, (ASC + 2 * OS - TH) / 2), rect(cx - 330, cy - TH / 2, cx + 330, cy + TH / 2))
    g["theta"] = (th, 1060, 0x03B8)

    # iota: short stem with the curled foot
    g["iota"] = (foot(100 + ST / 2, X), 520, 0x03B9)

    # lambda: long thick diagonal and a short thin leg
    lam = union(stroke(Sk(160, ASC - 40).line(880, 0), diag, start_angle=0, end_angle=0),
                stroke(Sk(520, X * 0.62).line(90, 0), diag, end_angle=0))
    g["lambda"] = (lam, 1000, 0x03BB)

    # xi: bar, epsilon-like double bowl stretched tall, and the zeta tail
    sk = Sk(820, ASC - 230).curve((500, ASC - 230), (240, ASC - 360), (240, X + 120))
    sk.curve((240, X - 60), (400, 760), (560, 760))
    top = stroke(sk, pen, profile(start=0.7))
    sk = Sk(560, 760).curve((300, 760), (130, 600), (130, 380))
    sk.curve((130, 120), (330, 40), (540, 40))
    sk.curve((740, 40), (780, -60), (760, -170))
    sk.curve((740, -300), (640, -380), (520, -400))
    xi = union(rect(240, ASC - 220 - TH / 2, 840, ASC - 220 + TH / 2), top,
               stroke(sk, pen, profile(end=0.6)))
    g["xi"] = (xi, 920, 0x03BE)

    # pi: two stems under a long bar
    pi = union(rect(60, X - TH, 1060, X), stem(300, 0, X - 40), foot(800, X - 40))
    g["pi"] = (pi, 1120, 0x03C0)

    # rho: bowl on a descending stem
    cx, cy, rx, ry = LC.bowl_dims(100 + ST / 2 - BOWL / 2, 1040)
    g["rho"] = (union(ring(cx, cy, rx, ry), stem(100 + ST / 2, DESC, cy)), 1110, 0x03C1)

    # sigma: bowl with a bar running out to the right at the top
    cx, cy, rx, ry = LC.bowl_dims(70, 900)
    sg = union(ring(cx, cy, rx, ry), rect(cx, X + OS - TH, 1080, X + OS))
    g["sigma"] = (sg, 1130, 0x03C3)

    # final sigma: c-shape whose foot turns down into a hook
    sk = Sk(820, X - 130).curve((760, X + 5), (600, X + OS - TH / 2), (470, X + OS - TH / 2))
    sk.curve((250, X + OS - TH / 2), (110, X - 220), (110, 500))
    sk.curve((110, 230), (260, 60), (480, 40))
    sk.curve((720, 20), (760, -100), (720, -220))
    sk.curve((690, -310), (600, -360), (500, -380))
    g["uni03C2"] = (stroke(sk, pen, profile(start=0.6, end=0.6)), 900, 0x03C2)

    # tau: bar and stem with the curled foot
    g["tau"] = (union(rect(60, X - TH, 760, X), foot(400, X - 40)), 860, 0x03C4)

    # upsilon: round cup, no stem
    def cup(x0, x1, top=X):
        mid = (x0 + x1) / 2
        bot = -OS + TH / 2
        sk = Sk(x0, top).line(x0, 400).curve((x0, 120), (mid - 200, bot), (mid, bot))
        sk.curve((mid + 220, bot), (x1, 150), (x1, 520)).curve((x1, 760), (x1 - 30, 900), (x1 - 80, top))
        return stroke(sk, sp, profile(end=0.6, end_len=0.2), start_angle=0)
    g["upsilon"] = (cup(100 + ST / 2, 900), 1060, 0x03C5)

    # phi: bowl with a stem through it
    cx, cy, rx, ry = LC.bowl_dims(70, 1160)
    g["phi"] = (union(ring(cx, cy, rx, ry), stem(cx, DESC, ASC - 200)), 1230, 0x03C6)

    # chi: x stretched below the line
    xb = P("x").bounds
    chi = transformed(P("x"), Transform().translate(0, DESC + 60).scale(1, (X - DESC - 60) / X))
    g["chi"] = (chi, W("x"), 0x03C7)

    # psi: cup on a stem
    cx = 560
    g["psi"] = (union(cup(100 + ST / 2, 1020), stem(cx, DESC, ASC - 200)), 1170, 0x03C8)

    # omega: two cups joined
    bot = -OS + TH / 2
    sk = Sk(170, X).curve((90, 700), (90, 300), (170, 140)).curve((230, 30), (300, bot), (390, bot))
    sk.curve((520, bot), (610, 120), (620, 520))
    left = stroke(sk, sp, profile(start=0.6, start_len=0.2))
    sk = Sk(620, 520).curve((630, 120), (720, bot), (850, bot)).curve((940, bot), (1010, 30), (1070, 140))
    sk.curve((1150, 300), (1150, 700), (1070, X))
    right = stroke(sk, sp, profile(end=0.6, end_len=0.2))
    g["omega"] = (union(left, right), 1240, 0x03C9)
    return g

# Generates res/soundmesh.ico (32x32 and 16x16, 32-bit): a headphone on a blue disc.
import math, struct, sys

def render(n):
    px = []
    for y in range(n):
        row = []
        for x in range(n):
            cx, cy = (x + 0.5) / n * 2 - 1, (y + 0.5) / n * 2 - 1
            r = math.hypot(cx, cy)
            a = max(0.0, min(1.0, (0.98 - r) * n / 2))  # anti-aliased disc
            col = (0x2b, 0x6c, 0xd6)
            hx, hy = cx, cy + 0.12
            band = abs(math.hypot(hx, hy) - 0.52) < 0.09 and hy < 0.05
            cup = any(abs(hx - s * 0.52) < 0.15 and -0.02 < hy < 0.38 for s in (-1, 1))
            if band or cup:
                col = (255, 255, 255)
            row.append((col[2], col[1], col[0], int(a * 255)))
        px.append(row)
    pixels = b"".join(bytes(p) for row in reversed(px) for p in row)
    mask = b"\0" * (((n + 31) // 32) * 4 * n)
    hdr = struct.pack("<IiiHHIIiiII", 40, n, 2 * n, 1, 32, 0, len(pixels) + len(mask), 0, 0, 0, 0)
    return hdr + pixels + mask

imgs = [render(32), render(16)]
out = struct.pack("<HHH", 0, 1, len(imgs))
off = 6 + 16 * len(imgs)
for n, img in zip((32, 16), imgs):
    out += struct.pack("<BBBBHHII", n, n, 0, 0, 1, 32, len(img), off)
    off += len(img)
out += b"".join(imgs)
open(sys.argv[1], "wb").write(out)

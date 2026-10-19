#!/usr/bin/env python3
"""Synthetic jigsaw-piece photos for tests/test_segment.mjs (PIL + numpy only).

Writes four 1600x1200 JPEGs plus one sidecar JSON each into tests/fixtures/:
    white_24.jpg / .json              24 coloured pieces on white paper
    dark_20.jpg / .json               20 light pieces on dark-grey cloth
    noisy_vignette_24.jpg / .json     24 pieces, noise + vignette + dust specks
    touching_20.jpg / .json           20 pieces, two of them touch (expect "merged")
Sidecar: { "count": N, "centers": [[x, y], ...], "touching_pairs": [[i, j]] }

Each piece is a rounded square (70-110 px) with 1-2 round tabs and 1-2 round blanks,
a photo-like gradient/pattern fill, a random rotation and a soft drop shadow.
Run:  python3 tests/gen_synthetic.py        (seeds are fixed, so output is repeatable)
"""
import colorsys
import json
import os

import numpy as np
from PIL import Image, ImageDraw, ImageFilter

W, H = 1600, 1200
SS = 4                                  # supersampling factor for the piece masks
HERE = os.path.dirname(os.path.abspath(__file__))
OUT_DIR = os.path.join(HERE, "fixtures")
DIRS = [(1, 0), (0, 1), (-1, 0), (0, -1)]   # side 0..3 = right, bottom, left, top (y points down)


def hsv(h, s, v):
    """HSV (0..1) -> float RGB array (0..255)."""
    return np.array(colorsys.hsv_to_rgb(h, s, v)) * 255.0


def random_config(rng):
    """Random tab/blank layout: 1-2 tabs, 1-2 blanks, each on its own side. Returns (tabs, blanks)."""
    sides = list(rng.permutation(4))
    n_tabs, n_blanks = int(rng.integers(1, 3)), int(rng.integers(1, 3))
    return sides[:n_tabs], sides[n_tabs:n_tabs + n_blanks]


def piece_mask(a, tabs, blanks, rng):
    """Draws a puzzle-piece silhouette (L image, 255 inside) with body side `a` px.
    The canvas is 1.9*a square and the body centre is the canvas centre."""
    size = int(round(1.9 * a))
    S, A = size * SS, a * SS
    c = S / 2.0
    m = Image.new("L", (S, S), 0)
    d = ImageDraw.Draw(m)
    d.rounded_rectangle([c - A / 2, c - A / 2, c + A / 2, c + A / 2], radius=0.09 * A, fill=255)

    def along(side, dist, off):
        ux, uy = DIRS[side]
        return c + ux * dist - uy * off, c + uy * dist + ux * off      # (normal, tangent) -> x, y

    def stem(side, d0, d1, off, width, fill):
        """Rectangle from distance d0 to d1 along the side normal, `width` wide."""
        pts = [along(side, d0, off - width / 2), along(side, d1, off - width / 2),
               along(side, d1, off + width / 2), along(side, d0, off + width / 2)]
        d.polygon(pts, fill=fill)

    for side in tabs:                                     # knobs sticking out
        off = rng.uniform(-0.08, 0.08) * A
        r = rng.uniform(0.15, 0.18) * A
        reach = 0.5 * A + rng.uniform(0.10, 0.13) * A
        stem(side, 0.5 * A - 0.05 * A, reach, off, rng.uniform(0.12, 0.15) * A, 255)
        x, y = along(side, reach, off)
        d.ellipse([x - r, y - r, x + r, y + r], fill=255)
    for side in blanks:                                   # sockets cut in
        off = rng.uniform(-0.08, 0.08) * A
        r = rng.uniform(0.14, 0.165) * A
        depth = 0.5 * A - rng.uniform(0.10, 0.13) * A
        stem(side, depth, 0.5 * A + 0.03 * A, off, rng.uniform(0.11, 0.14) * A, 0)
        x, y = along(side, depth, off)
        d.ellipse([x - r, y - r, x + r, y + r], fill=0)
    return m.resize((size, size), Image.Resampling.LANCZOS)


def make_texture(size, rng, light, min_dist, bg):
    """Photo-like colour field (size x size x 3, float 0..255): gradient + one pattern + grain.
    Every pixel is pushed at least `min_dist` (RGB distance) away from the background colour."""
    yy, xx = np.mgrid[0:size, 0:size].astype(np.float32)
    u, v = xx / size - 0.5, yy / size - 0.5

    def pick():
        if light:
            return hsv(rng.random(), rng.uniform(0.12, 0.65), rng.uniform(0.78, 1.0))
        return hsv(rng.random(), rng.uniform(0.45, 0.95), rng.uniform(0.30, 0.85))

    c1, c2, c3 = pick(), pick(), pick()
    ang = rng.uniform(0, 2 * np.pi)
    t = np.clip(u * np.cos(ang) + v * np.sin(ang) + 0.5, 0, 1)[..., None]
    tex = c1 * (1 - t) + c2 * t
    kind = int(rng.integers(0, 4))
    if kind == 0:                                         # soft blobs
        for _ in range(int(rng.integers(3, 6))):
            cx, cy = rng.uniform(-0.5, 0.5, 2)
            r = rng.uniform(0.08, 0.25)
            g = (0.8 * np.exp(-((u - cx) ** 2 + (v - cy) ** 2) / (2 * r * r)))[..., None]
            tex = tex * (1 - g) + c3 * g
    elif kind == 1:                                       # stripes
        f, ph, a2 = rng.uniform(4, 9), rng.uniform(0, 6.28), rng.uniform(0, np.pi)
        s = (0.55 * (0.5 + 0.5 * np.sin(2 * np.pi * f * (u * np.cos(a2) + v * np.sin(a2)) + ph)))[..., None]
        tex = tex * (1 - s) + c3 * s
    elif kind == 2:                                       # rings
        cx, cy = rng.uniform(-0.3, 0.3, 2)
        s = (0.5 * (0.5 + 0.5 * np.sin(2 * np.pi * rng.uniform(5, 11) * np.sqrt((u - cx) ** 2 + (v - cy) ** 2))))[..., None]
        tex = tex * (1 - s) + c3 * s
    else:                                                 # horizon with a wavy edge
        edge = rng.uniform(-0.15, 0.15) + rng.uniform(0.02, 0.07) * np.sin(2 * np.pi * rng.uniform(2, 5) * u + rng.uniform(0, 6.28))
        s = (1 / (1 + np.exp(-(v - edge) / 0.012)))[..., None]
        tex = tex * (1 - s) + c3 * s
    tex = tex + rng.normal(0, 3.0, tex.shape)
    diff = tex - bg
    dist = np.sqrt((diff ** 2).sum(-1, keepdims=True))
    tex = bg + diff * np.maximum(1.0, min_dist / np.maximum(dist, 1e-3))
    return np.clip(tex, 0, 255)


def render_piece(a, rng, tabs, blanks, angle, light, min_dist, bg):
    """One finished piece: dict(rgb float HxWx3, alpha float 0..1, size, radius).
    Texture and mask are rotated together, so the pattern turns with the piece."""
    mask = piece_mask(a, tabs, blanks, rng)
    size = mask.size[0]
    tex = make_texture(size, rng, light, min_dist, bg)
    inner = np.asarray(mask.filter(ImageFilter.MinFilter(3)), np.float32)
    edge = (np.asarray(mask, np.float32) - inner) / 255.0           # thin cut edge, darkened
    tex = tex * (1 - 0.30 * edge[..., None])
    rgb = Image.fromarray(np.clip(tex, 0, 255).astype(np.uint8)).rotate(angle, Image.Resampling.BICUBIC)
    alpha = mask.rotate(angle, Image.Resampling.BICUBIC)
    al = np.asarray(alpha, np.float32) / 255.0
    ys, xs = np.nonzero(al > 0.05)
    radius = float(np.sqrt((ys - size / 2.0) ** 2 + (xs - size / 2.0) ** 2).max())
    return {"rgb": np.asarray(rgb, np.float32), "alpha": al, "alpha_img": alpha, "size": size, "radius": radius}


def lowfreq(rng, amp, gx=9, gy=7):
    """Smooth random field in [-amp, amp] (coarse noise upsampled bicubically), shape (H, W)."""
    small = rng.uniform(-1, 1, (gy, gx)).astype(np.float32)
    big = Image.fromarray(small).resize((W, H), Image.Resampling.BICUBIC)
    return np.asarray(big, np.float32) * amp


def make_background(kind, rng):
    """Returns (float RGB background H x W x 3, nominal background colour)."""
    yy, xx = np.mgrid[0:H, 0:W].astype(np.float32)
    if kind == "white":                                   # paper with a faint lighting ramp
        base = np.array([245, 244, 241], np.float32)
        bg = base * (1.0 - 0.03 * xx / W - 0.02 * yy / H)[..., None]
    elif kind == "cloth":                                 # dark-grey woven cloth
        base = np.array([58, 60, 64], np.float32)
        weave = (3.0 * np.sin(xx * 2 * np.pi / 5.0) * np.sin(yy * 2 * np.pi / 5.0)
                 + 2.0 * np.sin((xx + yy) * 2 * np.pi / 9.0))
        bg = base + (weave + lowfreq(rng, 4.0))[..., None]
    else:                                                 # "vignette": corners 15 % darker, tilted light
        base = np.array([240, 238, 232], np.float32)
        r2 = ((xx - W / 2) / (W / 2)) ** 2 + ((yy - H / 2) / (H / 2)) ** 2      # 0 centre .. 2 corners
        light = (1.0 - 0.15 * r2 / 2.0) * (1.0 - 0.05 * xx / W)
        bg = base * light[..., None] + lowfreq(rng, 3.0)[..., None]
    return bg.astype(np.float32), base


def window(cx, cy, size):
    """(canvas slices, patch slices) for a size x size patch centred on (cx, cy), clipped to the canvas."""
    x0, y0 = cx - size // 2, cy - size // 2
    ax0, ay0, ax1, ay1 = max(0, x0), max(0, y0), min(W, x0 + size), min(H, y0 + size)
    return ((slice(ay0, ay1), slice(ax0, ax1)),
            (slice(ay0 - y0, ay1 - y0), slice(ax0 - x0, ax1 - x0)))


def draw_shadow(canvas, p, dx, dy, blur, strength):
    """Soft drop shadow: blurred piece alpha, offset by (dx, dy), darkens the background."""
    sa = np.asarray(p["alpha_img"].filter(ImageFilter.GaussianBlur(blur)), np.float32) / 255.0 * strength
    dst, src = window(p["cx"] + dx, p["cy"] + dy, p["size"])
    canvas[dst] *= (1.0 - sa[src])[..., None]


def draw_piece(canvas, p):
    """Alpha-composites one rendered piece onto the canvas."""
    dst, src = window(p["cx"], p["cy"], p["size"])
    a = p["alpha"][src][..., None]
    canvas[dst] = canvas[dst] * (1.0 - a) + p["rgb"][src] * a


def overlap_px(A, B, dx, dy):
    """Pixels where piece A (centred at 0, 0) and piece B (centred at dx, dy) are both opaque."""
    sa, sb = A["size"], B["size"]
    ax0, ay0, bx0, by0 = -(sa // 2), -(sa // 2), dx - sb // 2, dy - sb // 2
    ix0, iy0, ix1, iy1 = max(ax0, bx0), max(ay0, by0), min(ax0 + sa, bx0 + sb), min(ay0 + sa, by0 + sb)
    if ix1 <= ix0 or iy1 <= iy0:
        return 0
    a = A["alpha"][iy0 - ay0:iy1 - ay0, ix0 - ax0:ix1 - ax0] > 0.5
    b = B["alpha"][iy0 - by0:iy1 - by0, ix0 - bx0:ix1 - bx0] > 0.5
    return int(np.count_nonzero(a & b))


def make_touching_pair(rng, mid, spec, base):
    """Two large pieces, flat sides facing, pressed together (about 1-2 px overlap along the side).
    Returns two placed pieces centred around the point `mid`."""
    phi = float(rng.uniform(-6, 6))                       # same rotation -> facing edges stay parallel
    a_a, a_b = int(rng.integers(106, 111)), int(rng.integers(106, 111))
    kw = dict(light=spec["light"], min_dist=spec["min_dist"], bg=base)
    A = render_piece(a_a, rng, [3, 2], [1], phi, **kw)    # tabs top+left, blank bottom, flat right
    B = render_piece(a_b, rng, [1], [3, 0], phi, **kw)    # tab bottom, blanks top+right, flat left
    nx, ny = np.cos(np.radians(phi)), -np.sin(np.radians(phi))      # rotated "right" direction (y down)
    d = int(2.6 * max(a_a, a_b))
    while d > 0 and overlap_px(A, B, int(round(d * nx)), int(round(d * ny))) == 0:
        d -= 1
    d -= 1                                                # press a bit so the contact is solid
    for p, s in ((A, -0.5), (B, 0.5)):
        p["cx"], p["cy"] = int(round(mid[0] + s * d * nx)), int(round(mid[1] + s * d * ny))
    return [A, B]


def find_spot(rng, c0, R, placed, jitter, gap, clear):
    """Random jittered position near c0 that keeps `gap` px between bounding circles and the border clear."""
    for _ in range(400):
        cx, cy = c0[0] + rng.uniform(-jitter[0], jitter[0]), c0[1] + rng.uniform(-jitter[1], jitter[1])
        if cx - R < clear or cx + R > W - clear or cy - R < clear or cy + R > H - clear:
            continue
        if all(np.hypot(cx - q["cx"], cy - q["cy"]) >= R + q["radius"] + gap for q in placed):
            return int(round(cx)), int(round(cy))
    raise RuntimeError("could not place a piece near %s" % (c0,))


def layout(spec, rng, base):
    """Renders and places all pieces of one fixture. Returns (pieces, touching_pairs)."""
    cols, rows = spec["grid"]
    margin, gap, clear = 70, 18, 56
    cw, ch = (W - 2 * margin) / cols, (H - 2 * margin) / rows
    cells = [(margin + (c + 0.5) * cw, margin + (r + 0.5) * ch) for r in range(rows) for c in range(cols)]
    pieces, pairs = [], []
    if spec.get("touch"):                                 # pair sits across cells 1 and 2 of row 1
        i0 = cols + 1
        mid = ((cells[i0][0] + cells[i0 + 1][0]) / 2.0, (cells[i0][1] + cells[i0 + 1][1]) / 2.0)
        pieces += make_touching_pair(rng, mid, spec, base)
        pairs.append([0, 1])
        cells = [c for k, c in enumerate(cells) if k not in (i0, i0 + 1)]
    for c0 in cells:
        a = int(rng.integers(70, 111))
        tabs, blanks = random_config(rng)
        p = render_piece(a, rng, tabs, blanks, float(rng.uniform(0, 360)),
                         spec["light"], spec["min_dist"], base)
        p["cx"], p["cy"] = find_spot(rng, c0, p["radius"], pieces, (0.10 * cw, 0.10 * ch), gap, clear)
        pieces.append(p)
    return pieces, pairs


def finish(canvas, pieces, spec, rng):
    """Dust specks, camera blur, sensor noise -> uint8 array."""
    img = Image.fromarray(np.clip(canvas, 0, 255).astype(np.uint8))
    d = ImageDraw.Draw(img)
    for _ in range(spec.get("specks", 0)):                # tiny dark dust specks on the background only
        x, y, r = rng.uniform(70, W - 70), rng.uniform(70, H - 70), rng.uniform(1.0, 2.6)
        if all(np.hypot(x - q["cx"], y - q["cy"]) > q["radius"] + 14 for q in pieces):
            g = int(rng.integers(90, 150))
            d.ellipse([x - r, y - r, x + r, y + r], fill=(g, g, g))
    img = img.filter(ImageFilter.GaussianBlur(spec["blur"]))
    arr = np.asarray(img, np.float32) + rng.standard_normal((H, W, 3), dtype=np.float32) * spec["noise"]
    return np.clip(arr, 0, 255).astype(np.uint8)


def build(spec):
    """Generates one fixture; writes <name>.jpg and <name>.json into tests/fixtures/."""
    rng = np.random.default_rng(spec["seed"])
    canvas, base = make_background(spec["bg"], rng)
    pieces, pairs = layout(spec, rng, base)
    dx, dy = int(rng.integers(3, 6)), int(rng.integers(3, 6))       # shadow offset 3-5 px
    for p in pieces:
        draw_shadow(canvas, p, dx, dy, spec["shadow_blur"], spec["shadow"])
    for p in pieces:
        draw_piece(canvas, p)
    arr = finish(canvas, pieces, spec, rng)
    Image.fromarray(arr).save(os.path.join(OUT_DIR, spec["name"] + ".jpg"), "JPEG",
                              quality=spec["quality"], subsampling=2)
    side = {"count": len(pieces), "centers": [[p["cx"], p["cy"]] for p in pieces], "touching_pairs": pairs}
    with open(os.path.join(OUT_DIR, spec["name"] + ".json"), "w") as f:
        json.dump(side, f)
    print("wrote %-22s %2d pieces, touching pairs %s" % (spec["name"] + ".jpg", len(pieces), pairs))


FIXTURES = [
    dict(name="white_24", seed=11, grid=(6, 4), bg="white", light=False, min_dist=150,
         shadow=0.34, shadow_blur=3.5, blur=0.7, noise=2.5, quality=90),
    dict(name="dark_20", seed=22, grid=(5, 4), bg="cloth", light=True, min_dist=130,
         shadow=0.50, shadow_blur=3.5, blur=0.7, noise=3.0, quality=88),
    dict(name="noisy_vignette_24", seed=33, grid=(6, 4), bg="vignette", light=False, min_dist=95,
         shadow=0.34, shadow_blur=3.5, blur=1.0, noise=6.0, quality=70, specks=30),
    dict(name="touching_20", seed=44, grid=(5, 4), bg="white", light=False, min_dist=150,
         shadow=0.34, shadow_blur=3.5, blur=0.7, noise=2.5, quality=88, touch=True),
]

if __name__ == "__main__":
    os.makedirs(OUT_DIR, exist_ok=True)
    for fx in FIXTURES:
        build(fx)

"""Generate the Piece Finder app icons with Pillow.

Usage: python3 tests/gen_icons.py
Writes icons/icon-180.png, icons/icon-192.png and icons/icon-512.png in the repo root.
"""
import os

from PIL import Image, ImageDraw

BG = (0x0F, 0x11, 0x15, 255)      # #0f1115, background
YELLOW = (0xFF, 0xD4, 0x00, 255)  # #ffd400, piece color
MASTER = 1024                     # size of the master icon
SS = 4                            # supersampling factor used for drawing
SIZES = (180, 192, 512)           # output sizes
RESAMPLE = getattr(Image, 'Resampling', Image).LANCZOS


def box(*vals):
    """Round coordinates to integers for PIL drawing calls."""
    return [round(v) for v in vals]


def background(n):
    """Return an n x n RGBA image: a rounded square in BG (radius 22%), transparent corners."""
    img = Image.new('RGBA', (n, n), (0, 0, 0, 0))
    ImageDraw.Draw(img).rounded_rectangle(box(0, 0, n - 1, n - 1), radius=round(0.22 * n), fill=BG)
    return img


def piece_mask(n):
    """Return an n x n 'L' mask of the centered piece: square body, top and right tabs, bottom blank."""
    side = 0.55 * n               # body square: 55% of the icon width
    r = 0.15 * side               # knob radius: diameter is 30% of the square
    d = 0.10 * side               # knob center sits d outside its edge, which leaves a neck
    extent = side + d + r         # width and height of the whole silhouette
    origin = (n - extent) / 2     # top-left corner of the silhouette box (centered)
    left = origin                 # no tab on the left side, so the body sets the left edge
    top = origin + d + r          # the top tab rises above the body by d + r
    right, bottom = left + side, top + side
    mask = Image.new('L', (n, n), 0)
    draw = ImageDraw.Draw(mask)
    draw.rectangle(box(left, top, right, bottom), fill=255)
    for cx, cy in ((left + side / 2, top - d), (right + d, top + side / 2)):  # top tab, right tab
        draw.ellipse(box(cx - r, cy - r, cx + r, cy + r), fill=255)
    cx, cy = left + side / 2, bottom - d    # bottom blank: a circle cut into the body
    draw.ellipse(box(cx - r, cy - r, cx + r, cy + r), fill=0)
    return mask


def draw_icon(n):
    """Return the full icon at size n: the rounded background with the yellow piece on top."""
    piece = Image.new('RGBA', (n, n), YELLOW)
    piece.putalpha(piece_mask(n))
    return Image.alpha_composite(background(n), piece)


def main():
    """Draw at MASTER * SS, reduce to MASTER, then write each output size with LANCZOS."""
    repo = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    out_dir = os.path.join(repo, 'icons')
    os.makedirs(out_dir, exist_ok=True)
    master = draw_icon(MASTER * SS).resize((MASTER, MASTER), RESAMPLE)
    for size in SIZES:
        path = os.path.join(out_dir, 'icon-%d.png' % size)
        master.resize((size, size), RESAMPLE).save(path, optimize=True)
        print('wrote', path)


if __name__ == '__main__':
    main()

#!/usr/bin/env python3
"""Generate the Power Fund PWA icon set.

Draws the Feather-style "zap" bolt (the app's ⚡ mark) in Power Fund accent
orange (#F5A623) on the app's dark navy (#0D1B2A). Pure Pillow — no network,
no external assets, no build step.

Outputs (into ../icons/ relative to this file):
  icon-192.png              192x192  any-purpose (manifest)
  icon-512.png              512x512  any-purpose (manifest + splash)
  icon-maskable-512.png     512x512  maskable   (bolt kept inside the safe zone)
  apple-touch-icon-180.png  180x180  iOS home screen (opaque square; iOS rounds it)
  favicon-32.png            32x32    browser tab

Run:  python scripts/make-icons.py
Requires: Pillow  (pip install pillow)
"""
import os

from PIL import Image, ImageDraw

NAVY = (13, 27, 42, 255)      # #0D1B2A  --bg-primary
ACCENT = (245, 166, 35, 255)  # #F5A623  --accent

# Feather "zap" polygon, defined in a 24x24 viewBox (MIT-licensed icon shape).
BOLT = [(13, 2), (3, 14), (12, 14), (11, 22), (21, 10), (12, 10)]

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.normpath(os.path.join(HERE, "..", "icons"))

SUPERSAMPLE = 4  # render big, downscale once -> clean edges


def render(size, content_frac):
    """One icon. `content_frac` = fraction of the canvas width spanned by the
    24x24 bolt viewBox. Background is a full-bleed navy square (works for
    `any` and `maskable`; iOS masks the apple-touch-icon corners itself)."""
    s = size * SUPERSAMPLE
    img = Image.new("RGBA", (s, s), NAVY)
    draw = ImageDraw.Draw(img)

    box = s * content_frac
    offset = (s - box) / 2
    pts = [(offset + x / 24 * box, offset + y / 24 * box) for (x, y) in BOLT]
    draw.polygon(pts, fill=ACCENT)

    return img.resize((size, size), Image.LANCZOS)


JOBS = [
    ("icon-192.png", 192, 0.62),
    ("icon-512.png", 512, 0.62),
    ("icon-maskable-512.png", 512, 0.52),   # smaller -> stays in the safe zone
    ("apple-touch-icon-180.png", 180, 0.64),
    ("favicon-32.png", 32, 0.72),
]


def main():
    os.makedirs(OUT, exist_ok=True)
    for name, size, frac in JOBS:
        path = os.path.join(OUT, name)
        render(size, frac).save(path)
        print("wrote", os.path.relpath(path, os.path.join(HERE, "..")))


if __name__ == "__main__":
    main()

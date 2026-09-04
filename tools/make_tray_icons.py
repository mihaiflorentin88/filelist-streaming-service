#!/usr/bin/env python3
"""Generate the tray state icons from the app master icon.

States: running (as-is), stopped (grayscale), failed (grayscale + red dot).
Sizes: 16/24/32/64 px PNGs, written to internal/gui/assets/tray/.

Usage: python3 tools/make_tray_icons.py
"""

from pathlib import Path

from PIL import Image, ImageDraw

MASTER = Path("clients/tizen/icon.png")
OUT_DIR = Path("internal/gui/assets/tray")
SIZES = (16, 24, 32, 64)
FAILED_RED = (229, 68, 77, 255)  # #e5484d


def square_crop(img: Image.Image) -> Image.Image:
    side = min(img.size)
    left = (img.width - side) // 2
    top = (img.height - side) // 2
    return img.crop((left, top, left + side, top + side))


def grayscale(img: Image.Image) -> Image.Image:
    return img.convert("LA").convert("RGBA")


def red_dot(img: Image.Image, px: int) -> Image.Image:
    # The dot is 6 px at the 64 px master: scale it with the size.
    radius = max(2, round(px * 6 / 64 / 2))
    d = ImageDraw.Draw(img)
    cx, cy = px - radius - 1, px - radius - 1
    d.ellipse((cx - radius, cy - radius, cx + radius, cy + radius), fill=FAILED_RED)
    return img


def main() -> None:
    master = square_crop(Image.open(MASTER).convert("RGBA"))
    states = {
        "running": master,
        "stopped": grayscale(master),
        "failed": red_dot(grayscale(master), master.width),
    }
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    for state, img in states.items():
        for size in SIZES:
            resized = img.resize((size, size), Image.LANCZOS)
            dest = OUT_DIR / f"tray-{state}-{size}.png"
            resized.save(dest)
            print(f"wrote {dest}")


if __name__ == "__main__":
    main()

#!/usr/bin/env python3
"""Prepare transparent Agent Hub assets from light and dark logo renders."""

from collections import deque
from pathlib import Path
import sys

from PIL import Image


def extract_logo(source: Image.Image, dark_background: bool) -> Image.Image:
    """Remove the edge-connected matte while preserving enclosed glyphs."""
    image = source.convert("RGBA")
    pixels = image.load()
    width, height = image.size
    background = bytearray(width * height)
    queue: deque[tuple[int, int]] = deque()

    for x in range(width):
        queue.append((x, 0))
        queue.append((x, height - 1))
    for y in range(height):
        queue.append((0, y))
        queue.append((width - 1, y))

    def is_matte(x: int, y: int) -> bool:
        red, green, blue, _ = pixels[x, y]
        luminance = (red * 299 + green * 587 + blue * 114) // 1000
        return luminance < 128 if dark_background else luminance > 128

    while queue:
        x, y = queue.popleft()
        index = y * width + x
        if background[index] or not is_matte(x, y):
            continue
        background[index] = 1
        if x:
            queue.append((x - 1, y))
        if x + 1 < width:
            queue.append((x + 1, y))
        if y:
            queue.append((x, y - 1))
        if y + 1 < height:
            queue.append((x, y + 1))

    for y in range(height):
        for x in range(width):
            if background[y * width + x]:
                pixels[x, y] = (0, 0, 0, 0)

    bounds = image.getbbox()
    if bounds is None:
        raise RuntimeError("logo extraction produced an empty image")
    image = image.crop(bounds)

    padding = max(16, round(image.height * 0.04))
    canvas = Image.new("RGBA", (image.width + padding * 2, image.height + padding * 2))
    canvas.alpha_composite(image, (padding, padding))
    return canvas


def save_height(image: Image.Image, path: Path, height: int) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    width = round(image.width * height / image.height)
    image.resize((width, height), Image.Resampling.LANCZOS).save(path, optimize=True)


def save_square(image: Image.Image, path: Path, size: int) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    image.resize((size, size), Image.Resampling.LANCZOS).save(path, optimize=True)


if __name__ == "__main__":
    if len(sys.argv) != 4:
        raise SystemExit("usage: prepare-logo.py LIGHT_LOGO DARK_LOGO OUTPUT_DIR")

    output = Path(sys.argv[3])
    light_lockup = extract_logo(Image.open(sys.argv[1]), dark_background=False)
    dark_lockup = extract_logo(Image.open(sys.argv[2]), dark_background=True)
    save_height(light_lockup, output / "agent-hub-lockup-light.png", 128)
    save_height(dark_lockup, output / "agent-hub-lockup-dark.png", 128)

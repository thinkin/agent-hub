#!/usr/bin/env python3
"""Remove baked mattes from the supplied 28px Codex and TraeX marks."""

from pathlib import Path
import sys

from PIL import Image


def codex(source: Path, output: Path, foreground: tuple[int, int, int]) -> None:
    image = Image.open(source).convert("RGB")
    result = Image.new("RGBA", image.size)
    for point in ((x, y) for y in range(image.height) for x in range(image.width)):
        red, green, blue = image.getpixel(point)
        luminance = (299 * red + 587 * green + 114 * blue) / 1000
        alpha = round(max(0, min(1, (246 - luminance) / 205)) * 255)
        result.putpixel(point, (*foreground, alpha))
    result.save(output, optimize=True)


def traex(source: Path, output: Path) -> None:
    image = Image.open(source).convert("RGB")
    result = Image.new("RGBA", image.size)
    for point in ((x, y) for y in range(image.height) for x in range(image.width)):
        red, green, blue = image.getpixel(point)
        green_signal = max(green - red, green - blue, 0)
        alpha = round(max(0, min(1, (green_signal - 5) / 75)) * 255)
        if alpha:
            result.putpixel(point, (max(0, red - 4), min(255, green + 8), max(0, blue - 2), alpha))
    result.save(output, optimize=True)


if __name__ == "__main__":
    if len(sys.argv) != 4:
        raise SystemExit("usage: prepare-agent-icons.py CODEX_WEBP TRAEX_WEBP OUTPUT_DIR")
    output = Path(sys.argv[3])
    output.mkdir(parents=True, exist_ok=True)
    codex(Path(sys.argv[1]), output / "codex-icon-light.png", (20, 20, 22))
    codex(Path(sys.argv[1]), output / "codex-icon-dark.png", (244, 244, 246))
    traex(Path(sys.argv[2]), output / "traex-icon.png")

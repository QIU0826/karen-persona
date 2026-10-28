#!/usr/bin/env python3
"""Hybrid 自拍 contact sheet：三列对照（MOSS base / Qwen direct / Hybrid），按场景一行。"""
from __future__ import annotations

import argparse
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

FONT_CANDIDATES = [
    "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
    "/usr/share/fonts/truetype/liberation/LiberationSans-Regular.ttf",
]


def load_font(size: int) -> ImageFont.ImageFont:
    for candidate in FONT_CANDIDATES:
        if Path(candidate).is_file():
            try:
                return ImageFont.truetype(candidate, size)
            except OSError:
                continue
    return ImageFont.load_default()


def collect(directory: Path, pattern: str) -> dict[str, Path]:
    found: dict[str, Path] = {}
    for path in sorted(directory.glob(pattern)):
        for scene in ("cafe", "home", "night", "rain", "sea"):
            if f"-{scene}-" in path.name or path.name.startswith(f"{scene}."):
                found[scene] = path
    return found


def fit(image: Image.Image, width: int, height: int) -> Image.Image:
    image = image.convert("RGB")
    ratio = min(width / image.width, height / image.height)
    resized = image.resize((max(1, int(image.width * ratio)), max(1, int(image.height * ratio))), Image.LANCZOS)
    canvas = Image.new("RGB", (width, height), (22, 22, 26))
    canvas.paste(resized, ((width - resized.width) // 2, (height - resized.height) // 2))
    return canvas


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--dir", required=True, help="含 moss-base/qwen-direct/hybrid 三子目录的根目录")
    parser.add_argument("--out", required=True)
    parser.add_argument("--cell-width", type=int, default=352)
    parser.add_argument("--cell-height", type=int, default=516)
    args = parser.parse_args()

    root = Path(args.dir)
    groups = [
        ("moss-base", "MOSS v2 base"),
        ("qwen-direct", "Qwen direct"),
        ("hybrid", "MOSS→Qwen hybrid"),
    ]
    files = {key: collect(root / key, "*.png") for key, _ in groups}
    scenes = [scene for scene in ("cafe", "home", "night", "rain", "sea") if any(scene in f for f in files.values())]
    if not scenes:
        raise SystemExit(f"no images under {root}")
    label_h = 24
    header_h = 34
    sheet = Image.new("RGB", (len(groups) * args.cell_width, header_h + len(scenes) * (args.cell_height + label_h)), (18, 18, 22))
    draw = ImageDraw.Draw(sheet)
    title_font = load_font(16)
    label_font = load_font(13)
    for col, (_, title) in enumerate(groups):
        draw.text((col * args.cell_width + 8, 8), title, fill=(238, 238, 242), font=title_font)
    for row, scene in enumerate(scenes):
        for col, (key, _) in enumerate(groups):
            path = files[key].get(scene)
            x = col * args.cell_width
            y = header_h + row * (args.cell_height + label_h)
            if path is None:
                draw.text((x + 8, y + 8), f"{scene}: missing", fill=(200, 120, 120), font=label_font)
                continue
            with Image.open(path) as image:
                sheet.paste(fit(image, args.cell_width, args.cell_height), (x, y))
            draw.text((x + 6, y + args.cell_height + 4), f"{scene} · {path.name[:36]}", fill=(198, 198, 208), font=label_font)
    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    sheet.save(out, quality=90)
    print(f"contact sheet: {out} ({sheet.width}x{sheet.height})")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

#!/usr/bin/env python3
"""人物 LoRA 自拍 benchmark 的 contact sheet：左列 MOSS+LoRA，右列 Qwen-Image-Edit。"""
from __future__ import annotations

import argparse
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

DEFAULT_FONT_PATHS = [
    "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
    "/usr/share/fonts/truetype/liberation/LiberationSans-Regular.ttf",
]


def load_font(size: int) -> ImageFont.ImageFont:
    for candidate in DEFAULT_FONT_PATHS:
        if Path(candidate).is_file():
            try:
                return ImageFont.truetype(candidate, size)
            except OSError:
                continue
    return ImageFont.load_default()


def collect(directory: Path) -> list[Path]:
    return sorted(p for p in directory.glob("*.png") if p.is_file())


def fit(image: Image.Image, width: int, height: int) -> Image.Image:
    image = image.convert("RGB")
    ratio = min(width / image.width, height / image.height)
    resized = image.resize((max(1, int(image.width * ratio)), max(1, int(image.height * ratio))), Image.LANCZOS)
    canvas = Image.new("RGB", (width, height), (24, 24, 28))
    canvas.paste(resized, ((width - resized.width) // 2, (height - resized.height) // 2))
    return canvas


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--moss-dir", required=True)
    parser.add_argument("--qwen-dir", default="")
    parser.add_argument("--out", required=True)
    parser.add_argument("--cell-width", type=int, default=384)
    parser.add_argument("--cell-height", type=int, default=576)
    args = parser.parse_args()

    moss = collect(Path(args.moss_dir))
    qwen = collect(Path(args.qwen_dir)) if args.qwen_dir else []
    if not moss:
        raise SystemExit(f"no moss png in {args.moss_dir}")
    rows = min(len(moss), len(qwen) if qwen else len(moss))
    cols = 2 if qwen else 1
    label_h = 28
    header = 34
    sheet = Image.new(
        "RGB",
        (cols * args.cell_width, header + rows * (args.cell_height + label_h)),
        (18, 18, 22),
    )
    draw = ImageDraw.Draw(sheet)
    font = load_font(16)
    small = load_font(13)
    draw.text((10, 8), f"MOSS-Image-SFT + Karen LoRA ({len(moss)})  vs  Qwen-Image-Edit ({len(qwen)})", fill=(235, 235, 240), font=font)
    for row in range(rows):
        for col, files in enumerate([moss, qwen] if qwen else [moss]):
            if row >= len(files):
                continue
            x = col * args.cell_width
            y = header + row * (args.cell_height + label_h)
            with Image.open(files[row]) as image:
                sheet.paste(fit(image, args.cell_width, args.cell_height), (x, y))
            label = f"{'MOSS' if col == 0 else 'Qwen'} {files[row].stem}"[:64]
            draw.text((x + 6, y + args.cell_height + 6), label, fill=(200, 200, 210), font=small)
    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    sheet.save(out, quality=88)
    print(f"contact sheet: {out} ({sheet.width}x{sheet.height})")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

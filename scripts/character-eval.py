#!/usr/bin/env python3
"""Karen 角色一致性评测（P3 前置）：contact sheet + ArcFace cosine 基线。

在 GPU 服务器上运行（数据盘 /mnt/data0）；模型与 venv 也在服务器，不进 git。

用法（在服务器 venv 里跑）：
  # contact sheet：训练/评测拼图，方便人工筛选
  python scripts/character-eval.py --mode contact \
    --raw-dir /mnt/data0/lwh/karen-stack/datasets/karen-character/raw \
    --refs-dir /mnt/data0/lwh/karen-stack/datasets/karen-character/refs \
    --out-dir /mnt/data0/lwh/karen-stack/datasets/karen-character

  # ArcFace 基线：参考图两两 cosine、缓存自拍 vs 参考图、生成图 vs 参考图
  python scripts/character-eval.py --mode baseline --model buffalo_l \
    --raw-dir .../raw --refs-dir .../refs --out-dir ... --providers CPU

  # 两者都做
  python scripts/character-eval.py --mode all ...
"""

from __future__ import annotations

import argparse
import json
import math
import os
import sys
from dataclasses import dataclass
from pathlib import Path
from statistics import mean, median, pstdev
from typing import Any, Iterable

import numpy as np
from PIL import Image, ImageDraw, ImageFont

try:  # pragma: no cover - 仅在服务器安装好 insightface 后可用
    import cv2
    from insightface.app import FaceAnalysis
except Exception as exc:  # noqa: BLE001
    cv2 = None  # type: ignore[assignment]
    FaceAnalysis = None  # type: ignore[assignment]
    _INSIGHTFACE_IMPORT_ERROR = exc
else:
    _INSIGHTFACE_IMPORT_ERROR = None


# ── 基础工具 ─────────────────────────────────────────


@dataclass
class ImageEntry:
    path: Path
    split: str
    scene: str
    seed: int
    label: str


def _read_sidecar(png: Path) -> dict[str, Any]:
    sidecar = png.with_suffix(".json")
    if not sidecar.exists():
        return {}
    try:
        return json.loads(sidecar.read_text(encoding="utf-8"))
    except Exception:  # noqa: BLE001
        return {}


def collect_entries(raw_dir: Path) -> list[ImageEntry]:
    entries: list[ImageEntry] = []
    for split in ("train", "eval"):
        split_dir = raw_dir / split
        if not split_dir.is_dir():
            continue
        for png in sorted(split_dir.glob("*.png")):
            meta = _read_sidecar(png)
            scene = str(meta.get("scene") or png.stem.rsplit("-", 1)[0])
            seed = int(meta.get("seed") or 0)
            ident = str(meta.get("id") or png.stem)
            entries.append(ImageEntry(path=png, split=split, scene=scene, seed=seed, label=ident))
    return entries


def _load_rgb(path: Path) -> np.ndarray:
    return np.asarray(Image.open(path).convert("RGB"))


def _load_bgr(path: Path) -> np.ndarray:
    rgb = _load_rgb(path)
    return rgb[:, :, ::-1].copy()


def _font(size: int) -> ImageFont.FreeTypeFont | ImageFont.ImageFont:
    candidates = [
        "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
        "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
    ]
    for candidate in candidates:
        if os.path.exists(candidate):
            try:
                return ImageFont.truetype(candidate, size)
            except Exception:  # noqa: BLE001
                continue
    return ImageFont.load_default()


def _wrap_text(draw: ImageDraw.ImageDraw, text: str, font: Any, max_width: int) -> list[str]:
    """按像素宽度粗略断行（标签都是 ASCII，按字符宽度估算即可）。"""
    if draw.textlength(text, font=font) <= max_width:
        return [text]
    lines: list[str] = []
    current = ""
    for ch in text:
        trial = current + ch
        if draw.textlength(trial, font=font) > max_width and current:
            lines.append(current)
            current = ch
        else:
            current = trial
    if current:
        lines.append(current)
    return lines


def _stat_block(values: Iterable[float]) -> dict[str, float | int | None]:
    vals = [float(v) for v in values if v is not None and math.isfinite(float(v))]
    if not vals:
        return {"count": 0, "mean": None, "std": None, "min": None, "max": None, "median": None}
    return {
        "count": len(vals),
        "mean": round(mean(vals), 4),
        "std": round(pstdev(vals), 4) if len(vals) > 1 else 0.0,
        "min": round(min(vals), 4),
        "max": round(max(vals), 4),
        "median": round(median(vals), 4),
    }


# ── Contact sheet ────────────────────────────────────


def make_contact_sheet(
    entries: list[ImageEntry],
    out_path: Path,
    title: str,
    cols: int = 5,
    thumb_w: int = 360,
    pad: int = 14,
    label_h: int = 34,
) -> Path:
    if not entries:
        raise SystemExit(f"contact sheet: no images for {title}")
    sample = _load_rgb(entries[0].path)
    ratio = sample.shape[0] / sample.shape[1]
    thumb_h = int(thumb_w * ratio)
    rows = math.ceil(len(entries) / cols)
    title_h = 56
    width = cols * thumb_w + (cols + 1) * pad
    height = title_h + rows * (thumb_h + label_h) + (rows + 1) * pad
    sheet = Image.new("RGB", (width, height), (12, 14, 20))
    draw = ImageDraw.Draw(sheet)
    title_font = _font(26)
    label_font = _font(13)
    draw.text((pad, 16), f"{title}  ({len(entries)} images)", fill=(235, 240, 250), font=title_font)
    for idx, entry in enumerate(entries):
        col = idx % cols
        row = idx // cols
        x = pad + col * (thumb_w + pad)
        y = title_h + pad + row * (thumb_h + label_h + pad)
        image = Image.open(entry.path).convert("RGB").resize((thumb_w, thumb_h), Image.LANCZOS)
        sheet.paste(image, (x, y))
        lines = _wrap_text(draw, f"{idx + 1:02d} [{entry.split}] {entry.label}", label_font, thumb_w)
        for line_idx, line in enumerate(lines[:2]):
            draw.text((x, y + thumb_h + 4 + line_idx * 15), line, fill=(190, 200, 216), font=label_font)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    sheet.save(out_path, quality=88)
    return out_path


# ── ArcFace ──────────────────────────────────────────


def build_face_app(model: str, model_root: str | None, providers: list[str]) -> Any:
    if FaceAnalysis is None:
        raise SystemExit(f"insightface 不可用: {_INSIGHTFACE_IMPORT_ERROR}")
    kwargs: dict[str, Any] = {"name": model, "providers": providers}
    if model_root:
        kwargs["root"] = model_root
    app = FaceAnalysis(**kwargs)
    app.prepare(ctx_id=-1, det_size=(640, 640))
    return app


def embed_images(app: Any, paths: list[Path]) -> dict[str, dict[str, Any]]:
    """返回 {path: {embedding, faces, width, height, error}}；取图中面积最大的脸。"""
    results: dict[str, dict[str, Any]] = {}
    for path in paths:
        key = str(path)
        try:
            img = _load_bgr(path)
            faces = app.get(img)
        except Exception as exc:  # noqa: BLE001
            results[key] = {"embedding": None, "faces": 0, "error": f"{type(exc).__name__}: {exc}"}
            continue
        height, width = img.shape[:2]
        if not faces:
            results[key] = {
                "embedding": None,
                "faces": 0,
                "width": int(width),
                "height": int(height),
                "error": "no_face",
            }
            continue
        best = max(faces, key=lambda f: float((f.bbox[2] - f.bbox[0]) * (f.bbox[3] - f.bbox[1])))
        emb = np.asarray(best.embedding, dtype=np.float64)
        norm = float(np.linalg.norm(emb))
        if norm <= 1e-12:
            results[key] = {"embedding": None, "faces": len(faces), "error": "zero_embedding"}
            continue
        results[key] = {
            "embedding": emb / norm,
            "faces": len(faces),
            "width": int(width),
            "height": int(height),
            "det_score": round(float(getattr(best, "det_score", 0.0)), 4),
        }
    return results




def embed_images_with_fallback(app: Any, paths: list[Path]) -> dict[str, dict[str, Any]]:
    """先用 640 检测；未检出的图用 1024 再试一次（参考图 character-1 是极端特写）。"""
    first = embed_images(app, paths)
    missing = [Path(key) for key, value in first.items() if value.get("embedding") is None]
    if missing:
        try:
            app.prepare(ctx_id=-1, det_size=(1024, 1024))
            retried = embed_images(app, missing)
            for key, value in retried.items():
                if value.get("embedding") is not None:
                    value["det_size"] = 1024
                    first[key] = value
            app.prepare(ctx_id=-1, det_size=(640, 640))
        except Exception as exc:  # noqa: BLE001
            print(f"[baseline] det_size 1024 fallback failed: {exc}", file=sys.stderr)
    return first


def cosine(a: np.ndarray, b: np.ndarray) -> float:
    return float(np.clip(np.dot(a, b), -1.0, 1.0))


# ── 基线 ─────────────────────────────────────────────


def run_baseline(
    *,
    app: Any,
    raw_dir: Path,
    refs_dir: Path,
    out_dir: Path,
    model: str,
) -> dict[str, Any]:
    entries = collect_entries(raw_dir)
    ref_paths = sorted(
        [p for p in refs_dir.iterdir() if p.suffix.lower() in {".jpg", ".jpeg", ".png"}]
    )
    if not ref_paths:
        raise SystemExit(f"refs 目录没有图片: {refs_dir}")
    ref_meta_png = [p for p in ref_paths if p.suffix.lower() in {".jpg", ".jpeg", ".png"}]
    ref_embeds = embed_images_with_fallback(app, ref_meta_png)
    gen_paths = [entry.path for entry in entries]
    gen_embeds = embed_images_with_fallback(app, gen_paths)

    ref_names = {str(p): p.name for p in ref_meta_png}
    ref_ok = {str(p): v for p, v in ref_embeds.items() if v.get("embedding") is not None}

    # 1) 参考图之间两两 cosine
    pair_rows: list[dict[str, Any]] = []
    names = list(ref_ok.keys())
    for i in range(len(names)):
        for j in range(i + 1, len(names)):
            a, b = names[i], names[j]
            pair_rows.append(
                {
                    "a": ref_names[a],
                    "b": ref_names[b],
                    "cosine": round(cosine(ref_ok[a]["embedding"], ref_ok[b]["embedding"]), 4),
                }
            )
    ref_pair_cos = [row["cosine"] for row in pair_rows]

    # 2) 缓存自拍 / 参考立绘 / 已批准终稿 分组统计
    def is_selfie(name: str) -> bool:
        return name.startswith("karen-selfie-")

    def is_character(name: str) -> bool:
        return name.startswith("character-")

    def is_approved(name: str) -> bool:
        return name.startswith("selfie-promo-final")

    ref_selfies = [p for p in ref_ok if is_selfie(ref_names[p])]
    ref_characters = [p for p in ref_ok if is_character(ref_names[p])]
    ref_approved = [p for p in ref_ok if is_approved(ref_names[p])]
    character_vs_character = [
        row["cosine"]
        for row in pair_rows
        if is_character(row["a"]) and is_character(row["b"])
    ]
    selfie_vs_character = [
        row["cosine"]
        for row in pair_rows
        if (is_selfie(row["a"]) and is_character(row["b"])) or (is_character(row["a"]) and is_selfie(row["b"]))
    ]
    approved_vs_character = [
        row["cosine"]
        for row in pair_rows
        if (is_approved(row["a"]) and is_character(row["b"]))
        or (is_character(row["a"]) and is_approved(row["b"]))
    ]
    selfie_vs_selfie = [
        row["cosine"]
        for row in pair_rows
        if is_selfie(row["a"]) and is_selfie(row["b"])
    ]

    # 3) 每张参考图与其余参考图的平均相似度
    ref_rows: list[dict[str, Any]] = []
    for p, data in ref_embeds.items():
        name = ref_names[p]
        others = (
            [
                cosine(data["embedding"], ref_ok[q]["embedding"])
                for q in ref_ok
                if q != p
            ]
            if data.get("embedding") is not None
            else []
        )
        ref_rows.append(
            {
                "name": name,
                "detected": data.get("embedding") is not None,
                "faces": data.get("faces", 0),
                "mean_to_others": round(mean(others), 4) if others else None,
                "min_to_others": round(min(others), 4) if others else None,
                "max_to_others": round(max(others), 4) if others else None,
            }
        )

    # 4) 生成图 vs 参考图
    gen_rows: list[dict[str, Any]] = []
    for entry in entries:
        data = gen_embeds.get(str(entry.path), {})
        embedding = data.get("embedding")
        row: dict[str, Any] = {
            "file": str(entry.path),
            "split": entry.split,
            "scene": entry.scene,
            "seed": entry.seed,
            "faces": data.get("faces", 0),
            "detected": embedding is not None,
        }
        if embedding is not None and ref_ok:
            sims = {
                ref_names[p]: round(cosine(embedding, ref_ok[p]["embedding"]), 4)
                for p in ref_ok
            }
            row["cosine_by_ref"] = sims
            row["best_ref"] = max(sims, key=lambda k: sims[k])
            row["best_cosine"] = max(sims.values())
            row["mean_cosine"] = round(mean(sims.values()), 4)
            # 主参考图（宣传页 character-2.jpg）单独一列
            primary = "character-2.jpg"
            if primary in sims:
                row["cosine_primary"] = sims[primary]
        gen_rows.append(row)

    for split in ("train", "eval"):
        split_rows = [r for r in gen_rows if r["split"] == split and r.get("best_cosine") is not None]
        rows = [r for r in gen_rows if r["split"] == split]
        best = [r["best_cosine"] for r in split_rows]
        primary = [r["cosine_primary"] for r in split_rows if "cosine_primary" in r]
        print(
            f"[baseline] {split}: detected={len(split_rows)}/{len(rows)} "
            f"best={_stat_block(best)} primary={_stat_block(primary)}"
        )

    all_detected = [r for r in gen_rows if r.get("best_cosine") is not None]
    all_best = [r["best_cosine"] for r in all_detected]
    all_primary = [r["cosine_primary"] for r in all_detected if "cosine_primary" in r]

    summary = {
        "generated_at": __import__("datetime").datetime.utcnow().isoformat() + "Z",
        "model": model,
        "counts": {
            "refs": len(ref_paths),
            "refs_detected": len(ref_ok),
            "generated": len(gen_rows),
            "generated_detected": len(all_detected),
            "train": sum(1 for r in gen_rows if r["split"] == "train"),
            "eval": sum(1 for r in gen_rows if r["split"] == "eval"),
        },
        "identity": {
            "ref_ref_baseline": _stat_block(ref_pair_cos),
            "character_vs_character": _stat_block(character_vs_character),
            "selfie_vs_character": _stat_block(selfie_vs_character),
            "selfie_vs_selfie": _stat_block(selfie_vs_selfie),
            "approved_vs_character": _stat_block(approved_vs_character),
            "generated_vs_refs_best": _stat_block(all_best),
            "generated_vs_refs_primary": _stat_block(all_primary),
            "train_vs_refs_best": _stat_block(
                [r["best_cosine"] for r in gen_rows if r["split"] == "train" and r.get("best_cosine") is not None]
            ),
            "eval_vs_refs_best": _stat_block(
                [r["best_cosine"] for r in gen_rows if r["split"] == "eval" and r.get("best_cosine") is not None]
            ),
        },
        "ref_pairs": pair_rows,
        "refs": ref_rows,
        "generated": gen_rows,
    }

    out_dir.mkdir(parents=True, exist_ok=True)
    (out_dir / "baseline.json").write_text(json.dumps(summary, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    (out_dir / "baseline.md").write_text(render_baseline_markdown(summary), encoding="utf-8")
    print(json.dumps({k: summary["identity"][k] for k in (
        "ref_ref_baseline",
        "character_vs_character",
        "selfie_vs_character",
        "approved_vs_character",
        "generated_vs_refs_best",
        "generated_vs_refs_primary",
        "train_vs_refs_best",
        "eval_vs_refs_best",
    )}, ensure_ascii=False, indent=2))
    return summary


def _fmt(stat: dict[str, Any]) -> str:
    if not stat or stat.get("count", 0) == 0:
        return "n=0"
    return (
        f"n={stat['count']} mean={stat['mean']} std={stat['std']} "
        f"min={stat['min']} max={stat['max']}"
    )


def render_baseline_markdown(summary: dict[str, Any]) -> str:
    identity = summary["identity"]
    counts = summary["counts"]
    lines = [
        "# Karen 角色一致性 ArcFace 基线（自动生成）",
        "",
        f"- 生成时间（UTC）：{summary['generated_at']}",
        f"- 模型：insightface `{summary['model']}`（ONNX，CPU）",
        f"- 参考图：{counts['refs']} 张（检出 {counts['refs_detected']}）；"
        f"生成图：{counts['generated']} 张（检出 {counts['generated_detected']}）"
        f"，其中 train={counts['train']} / eval={counts['eval']}",
        "- 指标：cosine（越大越像同一个 identity；1.0 = 完全相同）",
        "",
        "| 对比 | 统计 |",
        "|---|---|",
        f"| 参考图两两（全部） | {_fmt(identity['ref_ref_baseline'])} |",
        f"| 参考立绘之间（character-1/2/3） | {_fmt(identity['character_vs_character'])} |",
        f"| 缓存自拍 vs 参考立绘 | {_fmt(identity['selfie_vs_character'])} |",
        f"| 缓存自拍之间 | {_fmt(identity['selfie_vs_selfie'])} |",
        f"| 已批准终稿 vs 参考立绘 | {_fmt(identity['approved_vs_character'])} |",
        f"| 生成图（全部）vs 最像的参考图 | {_fmt(identity['generated_vs_refs_best'])} |",
        f"| 生成图（全部）vs character-2 主参考 | {_fmt(identity['generated_vs_refs_primary'])} |",
        f"| 训练集 vs 最像的参考图 | {_fmt(identity['train_vs_refs_best'])} |",
        f"| 评测集 vs 最像的参考图 | {_fmt(identity['eval_vs_refs_best'])} |",
        "",
        "## 参考图明细",
        "",
        "| 参考图 | 检出 | faces | 与其余参考图 mean | min | max |",
        "|---|---|---|---|---|---|",
    ]
    for row in summary["refs"]:
        lines.append(
            f"| {row['name']} | {'✅' if row['detected'] else '❌'} | {row['faces']} | "
            f"{row['mean_to_others']} | {row['min_to_others']} | {row['max_to_others']} |"
        )
    misses = [r for r in summary["generated"] if not r["detected"]]
    noisy = [r for r in summary["generated"] if r.get("faces", 0) > 1]
    lines += [
        "",
        "## 异常项",
        "",
        f"- 未检出脸：{len(misses)} 张" + ("：" + "、".join(Path(r["file"]).name for r in misses) if misses else ""),
        f"- 多张脸：{len(noisy)} 张" + ("：" + "、".join(Path(r["file"]).name for r in noisy) if noisy else ""),
        "",
        "## 生成图明细（best cosine）",
        "",
        "| split | scene | seed | faces | best_ref | best | mean | primary |",
        "|---|---|---|---|---|---|---|---|",
    ]
    for row in sorted(summary["generated"], key=lambda r: (r["split"], r["scene"], r["seed"])):
        lines.append(
            f"| {row['split']} | {row['scene']} | {row['seed']} | {row['faces']} | "
            f"{row.get('best_ref', '-')} | {row.get('best_cosine', '-')} | "
            f"{row.get('mean_cosine', '-')} | {row.get('cosine_primary', '-')} |"
        )
    lines.append("")
    return "\n".join(lines)


# ── 入口 ─────────────────────────────────────────────


def main() -> None:
    parser = argparse.ArgumentParser(description="Karen 角色一致性评测（contact sheet + ArcFace cosine）")
    parser.add_argument("--mode", choices=["contact", "baseline", "all"], default="all")
    parser.add_argument("--raw-dir", type=Path, required=True, help="包含 train/ 与 eval/ 的生成图目录")
    parser.add_argument("--refs-dir", type=Path, required=True, help="参考图目录（含 9 张指定参考图）")
    parser.add_argument("--out-dir", type=Path, required=True, help="输出目录（contact sheet / baseline.json）")
    parser.add_argument("--model", default="buffalo_l", help="insightface 模型名（默认 buffalo_l）")
    parser.add_argument("--model-root", default=None, help="insightface root（默认 ~/.insightface）")
    parser.add_argument("--providers", default="CPU", help="CPU（默认）或 CUDA；避免与 P2 抢 GPU 用 CPU")
    parser.add_argument("--cols", type=int, default=5, help="contact sheet 列数")
    parser.add_argument("--thumb-width", type=int, default=360)
    args = parser.parse_args()

    entries = collect_entries(args.raw_dir)
    if args.mode in {"contact", "all"}:
        train = [e for e in entries if e.split == "train"]
        evals = [e for e in entries if e.split == "eval"]
        if train:
            out = make_contact_sheet(train, args.out_dir / "contact-train.jpg", "TRAIN", cols=args.cols, thumb_w=args.thumb_width)
            print(f"[contact] -> {out}")
        if evals:
            out = make_contact_sheet(evals, args.out_dir / "contact-eval.jpg", "EVAL", cols=4, thumb_w=args.thumb_width)
            print(f"[contact] -> {out}")

    if args.mode in {"baseline", "all"}:
        providers = [f"{args.providers}ExecutionProvider"] if args.providers.upper() in {"CPU", "CUDA"} else [args.providers]
        providers = ["CUDAExecutionProvider", "CPUExecutionProvider"] if args.providers.upper() == "CUDA" else ["CPUExecutionProvider"]
        app = build_face_app(args.model, args.model_root, providers)
        run_baseline(app=app, raw_dir=args.raw_dir, refs_dir=args.refs_dir, out_dir=args.out_dir, model=args.model)


if __name__ == "__main__":
    main()

#!/usr/bin/env python3
"""Karen MOSS-Image identity LoRA —— 验证与评测（P3 / task-25）。

分两个阶段，分别在不同环境跑（脚本自身不 import torch / insightface 顶层）：

1) generate（在训练容器内跑，需要 sd-scripts + torch/diffusers）
   用 sd-scripts 的 `moss_image_minimal_inference.py`（支持加载并 merge LoRA）按
   eval-prompts.txt 批量生成图片；base（不加载 LoRA）与 lora 各跑一遍，prompt/seed 完全一致，
   这样 identity cosine 的对比是同模型、同输入的 A/B，而不是跨模型比较。

   python moss-lora-eval.py generate \
     --sdscripts /workspace/training/sd-scripts \
     --model-dir /workspace/models/MOSS-Image-SFT \
     --prompts /workspace/datasets/karen-lora/eval-prompts.txt \
     --out /workspace/datasets/karen-lora/eval-out/base \
     --label base
   # 加 --lora /workspace/models/karen-moss-lora/karen_style_moss_v1.safetensors --label lora --out .../lora

2) metrics（在 host 的 karen-arcface venv 里跑；insightface + onnxruntime，CPU 即可）
   计算 ArcFace cosine（vs 参考图 best/mean/primary）、base→lora 的逐图提升、contact sheet、
   metrics.json + report.md；并与 task-24 的 baseline.json 对照（注明跨模型不可直接比）。

   /mnt/data0/lwh/karen-stack/venvs/karen-arcface/bin/python moss-lora-eval.py metrics \
     --refs /mnt/data0/lwh/karen-stack/datasets/karen-character/refs \
     --dirs base=/path/base lora=/path/lora \
     --baseline-json /mnt/data0/lwh/karen-stack/datasets/karen-character/baseline.json \
     --out /mnt/data0/lwh/karen-stack/datasets/karen-lora/eval-report

不含密钥；所有大文件写 /mnt/data0。
"""

from __future__ import annotations

import argparse
import json
import math
import os
import re
import subprocess
import sys
import time
from dataclasses import dataclass
from pathlib import Path
from statistics import mean, median, pstdev
from typing import Any, Iterable

# ── 公共小工具 ───────────────────────────────────────

IMAGE_EXT = {".png", ".jpg", ".jpeg", ".webp"}


def log(msg: str) -> None:
    print(f"[moss-lora-eval] {msg}", flush=True)


def parse_prompt_file(path: Path) -> list[dict[str, Any]]:
    """解析 minimal inference 的 batch prompt 文件：`prompt --w 832 --h 912 --d 123 ...`。"""
    rows: list[dict[str, Any]] = []
    for line in path.read_text(encoding="utf-8").splitlines():
        text = line.strip()
        if not text or text.startswith("#"):
            continue
        parts = text.split(" --")
        row: dict[str, Any] = {"prompt": parts[0].strip(), "seed": None, "width": None, "height": None}
        for part in parts[1:]:
            kv = part.split(" ", 1)
            if len(kv) != 2:
                continue
            key, value = kv[0].strip(), kv[1].strip()
            if key == "d":
                row["seed"] = int(value)
            elif key == "w":
                row["width"] = int(value)
            elif key == "h":
                row["height"] = int(value)
        rows.append(row)
    return rows


def read_json(path: Path) -> Any:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except Exception:  # noqa: BLE001
        return None


# ── 1) generate：在训练容器内批量生成（base / lora） ──


def cmd_generate(args: argparse.Namespace) -> int:
    model_dir = Path(args.model_dir)
    dit = model_dir / "transformer" / "diffusion_pytorch_model-00001-of-00003.safetensors"
    text_encoder = model_dir / "text_encoder" / "model-00001-of-00004.safetensors"
    vae = model_dir / "vae" / "diffusion_pytorch_model.safetensors"
    tokenizer = model_dir / "tokenizer"
    for p in (dit, text_encoder, vae, tokenizer):
        if not p.exists():
            raise SystemExit(f"模型文件缺失: {p}")

    prompts = Path(args.prompts)
    rows = parse_prompt_file(prompts)
    if args.limit:
        rows = rows[: args.limit]
    if not rows:
        raise SystemExit(f"prompt 文件为空: {prompts}")

    out_dir = Path(args.out)
    out_dir.mkdir(parents=True, exist_ok=True)
    if args.clean and any(out_dir.iterdir()):
        for old in out_dir.glob("*.png"):
            old.unlink()

    inference = Path(args.sdscripts) / "moss_image_minimal_inference.py"
    if not inference.exists():
        raise SystemExit(f"找不到 {inference}（--sdscripts 指向 sd-scripts clone）")

    cmd = [
        sys.executable,
        str(inference),
        "--dit",
        str(dit),
        "--text_encoder",
        str(text_encoder),
        "--vae",
        str(vae),
        "--tokenizer_cache_dir",
        str(tokenizer),
        "--from_file",
        str(prompts),
        "--save_path",
        str(out_dir),
        "--no_metadata",
    ]
    if args.lora:
        cmd += ["--lora_weight", str(Path(args.lora).expanduser()), "--lora_multiplier", "1.0"]
    if args.limit:
        # 用截断后的临时 prompt 文件，保证分批检查 checkpoint 时只跑前 N 条
        limited = out_dir / "_prompts_limited.txt"
        limited.write_text(
            "\n".join(
                Path(args.prompts).read_text(encoding="utf-8").splitlines()[: args.limit + 0]
            )
            + "\n",
            encoding="utf-8",
        )
        # 上面按原始行截断（含空行时可能偏移），改为直接由 rows 重建：
        lines = []
        for r in rows:
            line = f"{r['prompt']}"
            if r["width"]:
                line += f" --w {r['width']}"
            if r["height"]:
                line += f" --h {r['height']}"
            line += " --s 50 --l 3.0 --fs 5.0"
            if r["seed"] is not None:
                line += f" --d {r['seed']}"
            lines.append(line)
        limited.write_text("\n".join(lines) + "\n", encoding="utf-8")
        cmd[cmd.index(str(prompts))] = str(limited)

    log(f"label={args.label} lora={args.lora or '(base)'}")
    log("run: " + " ".join(cmd))
    if args.dry_run:
        log("--dry-run: 只打印命令，不加载模型")
        return 0
    env = dict(os.environ)
    env.setdefault("HF_HUB_OFFLINE", "1")
    env.setdefault("TRANSFORMERS_OFFLINE", "1")
    env.setdefault("PYTHONUNBUFFERED", "1")
    log_path = out_dir / "generate.log"
    started = time.time()
    with log_path.open("w", encoding="utf-8") as logf:
        proc = subprocess.run(cmd, stdout=logf, stderr=subprocess.STDOUT, env=env)
    elapsed = time.time() - started
    if proc.returncode != 0:
        tail = "\n".join(log_path.read_text(encoding="utf-8", errors="replace").splitlines()[-30:])
        raise SystemExit(f"生成失败（exit={proc.returncode}，日志 {log_path}）:\n{tail}")

    # 输出文件名为 `{time}_{seed}.png`（batch 模式无 original name）；按 seed 映射回 prompt 序号
    pngs = sorted(out_dir.glob("*.png"), key=lambda p: p.stat().st_mtime)
    used: set[Path] = set()
    manifest: list[dict[str, Any]] = []
    for index, row in enumerate(rows, start=1):
        matched: Path | None = None
        if row["seed"] is not None:
            suffix = f"_{row['seed']}.png"
            for png in pngs:
                if png not in used and png.name.endswith(suffix):
                    matched = png
                    break
        if matched is None:
            for png in pngs:
                if png not in used:
                    matched = png
                    break
        if matched is None:
            manifest.append({"index": index, "seed": row["seed"], "file": None, "error": "missing"})
            continue
        used.add(matched)
        target = out_dir / f"{index:02d}-s{row['seed']}-{args.label}.png"
        if matched != target:
            if target.exists():
                target.unlink()
            matched.rename(target)
        manifest.append(
            {
                "index": index,
                "seed": row["seed"],
                "file": target.name,
                "width": row["width"],
                "height": row["height"],
                "prompt": row["prompt"],
            }
        )

    meta = {
        "label": args.label,
        "lora": str(args.lora) if args.lora else None,
        "prompts": str(prompts),
        "out": str(out_dir),
        "elapsed_sec": round(elapsed, 1),
        "count": len([m for m in manifest if m.get("file")]),
        "expected": len(rows),
        "log": str(log_path),
        "items": manifest,
    }
    (out_dir / "generate-manifest.json").write_text(json.dumps(meta, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    log(f"完成: {meta['count']}/{meta['expected']} 张，耗时 {meta['elapsed_sec']}s → {out_dir}")
    return 0


# ── 2) metrics：ArcFace（host venv） ─────────────────

@dataclass
class ImageEntry:
    path: Path
    label: str
    index: int
    scene: str = ""
    seed: int | None = None


def stat_block(values: Iterable[float]) -> dict[str, Any]:
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


def cosine(a: Any, b: Any) -> float:
    import numpy as np

    return float(np.clip(np.dot(a, b), -1.0, 1.0))


def build_face_app(model: str, providers: list[str]) -> Any:
    try:
        from insightface.app import FaceAnalysis
    except Exception as exc:  # noqa: BLE001
        raise SystemExit(f"insightface 不可用（请用 karen-arcface venv 运行 metrics）: {exc}") from exc
    # insightface 需要完整的 provider 名（CPU → CPUExecutionProvider），否则会打印 EP Error 再回退
    normalized = ["CPUExecutionProvider" if p.upper() == "CPU" else "CUDAExecutionProvider" if p.upper() == "CUDA" else p for p in providers]
    app = FaceAnalysis(name=model, providers=normalized)
    app.prepare(ctx_id=-1, det_size=(640, 640))
    return app


def embed_paths(app: Any, paths: list[Path]) -> dict[str, dict[str, Any]]:
    import numpy as np
    from PIL import Image

    results: dict[str, dict[str, Any]] = {}

    def embed_batch(batch: list[Path], det_size: int, mark_retry: bool) -> None:
        for path in batch:
            try:
                rgb = np.asarray(Image.open(path).convert("RGB"))
                bgr = rgb[:, :, ::-1].copy()
                faces = app.get(bgr)
            except Exception as exc:  # noqa: BLE001
                results[str(path)] = {"embedding": None, "faces": 0, "error": f"{type(exc).__name__}: {exc}"}
                continue
            if not faces:
                results.setdefault(str(path), {"embedding": None, "faces": 0, "error": "no_face"})
                continue
            best = max(faces, key=lambda f: float((f.bbox[2] - f.bbox[0]) * (f.bbox[3] - f.bbox[1])))
            emb = np.asarray(best.embedding, dtype=np.float64)
            norm = float(np.linalg.norm(emb))
            if norm <= 1e-12:
                results[str(path)] = {"embedding": None, "faces": len(faces), "error": "zero_embedding"}
                continue
            results[str(path)] = {
                "embedding": emb / norm,
                "faces": len(faces),
                "det_score": round(float(getattr(best, "det_score", 0.0)), 4),
            }
            if mark_retry:
                results[str(path)]["det_size"] = det_size

    embed_batch(paths, 640, False)
    missing = [Path(k) for k, v in results.items() if v.get("embedding") is None]
    if missing:
        try:
            app.prepare(ctx_id=-1, det_size=(1024, 1024))
            embed_batch(missing, 1024, True)
        finally:
            app.prepare(ctx_id=-1, det_size=(640, 640))
    return results


def collect_dir_entries(directory: Path, label: str) -> list[ImageEntry]:
    entries: list[ImageEntry] = []
    for i, path in enumerate(sorted(p for p in directory.iterdir() if p.suffix.lower() in IMAGE_EXT)):
        match = re.match(r"^(\d+)-s(\d+)", path.name)
        entries.append(
            ImageEntry(
                path=path,
                label=label,
                index=int(match.group(1)) if match else i + 1,
                seed=int(match.group(2)) if match else None,
            )
        )
    return entries


def make_contact_sheet(entries: list[ImageEntry], scores: dict[str, dict[str, Any]], out_path: Path, title: str, cols: int = 4, thumb_w: int = 380) -> Path | None:
    try:
        from PIL import Image, ImageDraw, ImageFont
    except Exception:  # noqa: BLE001
        log("PIL 不可用，跳过 contact sheet")
        return None
    entries = [e for e in entries if e.path.exists()]
    if not entries:
        return None
    sample = Image.open(entries[0].path).convert("RGB")
    ratio = sample.height / sample.width
    thumb_h = int(thumb_w * ratio)
    rows = math.ceil(len(entries) / cols)
    pad, label_h, title_h = 14, 40, 58
    width = cols * thumb_w + (cols + 1) * pad
    height = title_h + rows * (thumb_h + label_h) + (rows + 1) * pad
    sheet = Image.new("RGB", (width, height), (12, 14, 20))
    draw = ImageDraw.Draw(sheet)
    font_candidates = [
        "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
        "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
    ]
    def font(size: int) -> Any:
        for candidate in font_candidates:
            if os.path.exists(candidate):
                try:
                    return ImageFont.truetype(candidate, size)
                except Exception:  # noqa: BLE001
                    continue
        return ImageFont.load_default()

    draw.text((pad, 16), f"{title}  ({len(entries)} images)", fill=(235, 240, 250), font=font(26))
    label_font = font(14)
    for idx, entry in enumerate(entries):
        col, row = idx % cols, idx // cols
        x = pad + col * (thumb_w + pad)
        y = title_h + pad + row * (thumb_h + label_h + pad)
        image = Image.open(entry.path).convert("RGB").resize((thumb_w, thumb_h), Image.LANCZOS)
        sheet.paste(image, (x, y))
        info = scores.get(str(entry.path), {})
        best = info.get("best_cosine")
        line = f"{entry.index:02d} {entry.label} best={best if best is not None else 'n/a'}"
        draw.text((x, y + thumb_h + 5), line, fill=(190, 200, 216), font=label_font)
        if entry.seed is not None:
            draw.text((x, y + thumb_h + 21), f"seed={entry.seed}", fill=(140, 150, 166), font=label_font)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    sheet.save(out_path, quality=88)
    return out_path


def dir_metrics(entries: list[ImageEntry], embeds: dict[str, dict[str, Any]], ref_ok: dict[str, Any], ref_names: dict[str, str]) -> dict[str, Any]:
    rows: list[dict[str, Any]] = []
    for entry in entries:
        data = embeds.get(str(entry.path), {})
        embedding = data.get("embedding")
        row: dict[str, Any] = {
            "file": entry.path.name,
            "index": entry.index,
            "seed": entry.seed,
            "faces": data.get("faces", 0),
            "detected": embedding is not None,
        }
        if embedding is not None and ref_ok:
            sims = {ref_names[p]: round(cosine(embedding, ref_ok[p]["embedding"]), 4) for p in ref_ok}
            row["best_ref"] = max(sims, key=lambda k: sims[k])
            row["best_cosine"] = max(sims.values())
            row["mean_cosine"] = round(mean(sims.values()), 4)
            if "character-2.jpg" in sims:
                row["cosine_primary"] = sims["character-2.jpg"]
        rows.append(row)

    detected = [r for r in rows if r.get("best_cosine") is not None]
    best = [r["best_cosine"] for r in detected]
    primary = [r["cosine_primary"] for r in detected if "cosine_primary" in r]
    return {
        "count": len(rows),
        "detected": len(detected),
        "best_cosine": stat_block(best),
        "mean_cosine": stat_block([r["mean_cosine"] for r in detected]),
        "primary_cosine": stat_block(primary),
        "rows": rows,
    }


def cmd_metrics(args: argparse.Namespace) -> int:
    import numpy as np  # noqa: F401  (embed 阶段使用)

    refs_dir = Path(args.refs)
    if not refs_dir.is_dir():
        raise SystemExit(f"refs 目录不存在: {refs_dir}")
    ref_paths = sorted(p for p in refs_dir.iterdir() if p.suffix.lower() in IMAGE_EXT)
    if not ref_paths:
        raise SystemExit(f"refs 目录没有图片: {refs_dir}")

    labelled_dirs: list[tuple[str, Path]] = []
    for spec in args.dirs:
        if "=" not in spec:
            raise SystemExit(f"--dirs 需要 label=path 形式: {spec}")
        label, path = spec.split("=", 1)
        d = Path(path)
        if not d.is_dir():
            raise SystemExit(f"生成目录不存在: {d}")
        labelled_dirs.append((label, d))

    app = build_face_app(args.model, [p.strip() for p in args.providers.split(",") if p.strip()])
    log(f"ArcFace model={args.model} refs={len(ref_paths)}")
    started = time.time()
    ref_embeds = embed_paths(app, ref_paths)
    ref_names = {str(p): p.name for p in ref_paths}
    ref_ok = {str(p): v for p, v in ref_embeds.items() if v.get("embedding") is not None}
    log(f"参考图检出 {len(ref_ok)}/{len(ref_paths)}")

    dir_entries: dict[str, list[ImageEntry]] = {}
    dir_results: dict[str, dict[str, Any]] = {}
    all_embeds: dict[str, dict[str, Any]] = {}
    for label, directory in labelled_dirs:
        entries = collect_dir_entries(directory, label)
        embeds = embed_paths(app, [e.path for e in entries])
        all_embeds.update(embeds)
        metrics = dir_metrics(entries, embeds, ref_ok, ref_names)
        dir_entries[label] = entries
        dir_results[label] = metrics
        best = metrics["best_cosine"]
        log(
            f"{label}: n={metrics['count']} detected={metrics['detected']} "
            f"best mean={best['mean']} std={best['std']} min={best['min']} max={best['max']}"
        )

    # base → lora 逐图对比（按 index 配对）
    pair_rows: list[dict[str, Any]] = []
    labels = [label for label, _ in labelled_dirs]
    if len(labels) == 2:
        a, b = labels[0], labels[1]
        map_a = {r["index"]: r for r in dir_results[a]["rows"]}
        for row_b in dir_results[b]["rows"]:
            row_a = map_a.get(row_b["index"])
            if not row_a or row_a.get("best_cosine") is None or row_b.get("best_cosine") is None:
                continue
            pair_rows.append(
                {
                    "index": row_b["index"],
                    "seed": row_b.get("seed"),
                    f"{a}_best": row_a["best_cosine"],
                    f"{b}_best": row_b["best_cosine"],
                    "delta": round(row_b["best_cosine"] - row_a["best_cosine"], 4),
                }
            )
    deltas = [r["delta"] for r in pair_rows]
    delta_stats = stat_block(deltas)

    # 与 task-24 baseline 对照（跨模型，仅作参考）
    baseline = read_json(Path(args.baseline_json)) if args.baseline_json else None
    baseline_identity = (baseline or {}).get("identity", {}) if isinstance(baseline, dict) else {}

    out_dir = Path(args.out)
    out_dir.mkdir(parents=True, exist_ok=True)
    contact_sheets: dict[str, str | None] = {}
    for label, entries in dir_entries.items():
        # contact sheet 需要每张图的 best_cosine（dir_metrics 的 rows 才有），不能用 embedding 原始 dict
        score_by_path = {str(e.path): r for e, r in zip(entries, dir_results[label]["rows"])}
        path = make_contact_sheet(entries, score_by_path, out_dir / f"contact-{label}.jpg", f"{label} eval")
        contact_sheets[label] = str(path) if path else None

    report = {
        "generated_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "model": args.model,
        "providers": args.providers,
        "elapsed_sec": round(time.time() - started, 1),
        "refs": {
            "dir": str(refs_dir),
            "count": len(ref_names),
            "detected": len(ref_ok),
            "detail": [
                {
                    "name": ref_names[p],
                    "detected": ref_embeds[p].get("embedding") is not None,
                    "faces": ref_embeds[p].get("faces", 0),
                }
                for p in ref_names
            ],
        },
        "dirs": {
            label: {
                "path": str(dict(labelled_dirs)[label]),
                "count": dir_results[label]["count"],
                "detected": dir_results[label]["detected"],
                "best_cosine": dir_results[label]["best_cosine"],
                "mean_cosine": dir_results[label]["mean_cosine"],
                "primary_cosine": dir_results[label]["primary_cosine"],
                "rows": dir_results[label]["rows"],
            }
            for label in dir_results
        },
        "pairwise": {"pairs": pair_rows, "delta": delta_stats},
        "baseline_reference": {
            "path": args.baseline_json,
            "note": "task-24 的 baseline 是 Qwen-Image-Edit 生成图 vs 参考图的最像 cosine，不是 MOSS base；只能作为量级参考。",
            "eval_vs_refs_best": baseline_identity.get("eval_vs_refs_best"),
            "generated_vs_refs_best": baseline_identity.get("generated_vs_refs_best"),
        },
        "contact_sheets": contact_sheets,
    }
    (out_dir / "metrics.json").write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

    # report.md（中文，给产品/工程看）
    lines: list[str] = []
    lines.append("# Karen MOSS-Image identity LoRA —— 评测报告（自动生成）\n")
    lines.append(f"- 生成时间（UTC）：{report['generated_at']}")
    lines.append(f"- ArcFace：insightface `{args.model}`（providers: {', '.join(p.strip() for p in args.providers.split(',') if p.strip())}）")
    lines.append(f"- 参考图：{len(ref_names)} 张（检出 {len(ref_ok)}）")
    lines.append("")
    lines.append("## 各目录 identity cosine（vs 9 张参考图，取最像）\n")
    lines.append("| 目录 | 图片数 | 检出脸 | best mean | std | min | max | primary mean |")
    lines.append("|---|---|---|---|---|---|---|---|")
    for label in labels:
        m = dir_results[label]
        lines.append(
            f"| {label} | {m['count']} | {m['detected']} | {m['best_cosine']['mean']} | {m['best_cosine']['std']} | "
            f"{m['best_cosine']['min']} | {m['best_cosine']['max']} | {m['primary_cosine']['mean']} |"
        )
    if baseline_identity:
        b = baseline_identity.get("eval_vs_refs_best") or {}
        lines.append("")
        lines.append(
            f"> task-24 基线（Qwen-Image-Edit 生成图 vs 参考图，跨模型参考量级）：eval best mean={b.get('mean')}、"
            f"std={b.get('std')}、min={b.get('min')}、max={b.get('max')}。**不是同模型对比**。"
        )
    if pair_rows:
        lines.append("")
        lines.append("## 同 prompt / 同 seed 的 base → LoRA 提升\n")
        lines.append("| # | seed | base best | lora best | Δ |")
        lines.append("|---|---|---|---|---|")
        for row in pair_rows:
            a, b = labels[0], labels[1]
            lines.append(
                f"| {row['index']} | {row['seed']} | {row[f'{a}_best']} | {row[f'{b}_best']} | {row['delta']:+.4f} |"
            )
        lines.append("")
        lines.append(
            f"Δ 统计：n={delta_stats['count']}，mean={delta_stats['mean']}，std={delta_stats['std']}，"
            f"min={delta_stats['min']}，max={delta_stats['max']}"
        )
    lines.append("")
    lines.append("## 产物\n")
    for label, path in contact_sheets.items():
        lines.append(f"- contact sheet（{label}）：`{path}`")
    lines.append(f"- 原始指标：`{out_dir / 'metrics.json'}`")
    lines.append("")
    lines.append("## 判读注意\n")
    lines.append("- ArcFace cosine 对角度/遮挡/侧脸敏感；侧脸、回眸、近景构图会天然降低分数。")
    lines.append("- 单张图不达标不代表 LoRA 无效；看均值、逐图 Δ 与 contact sheet 的人工观感。")
    lines.append("- 若 lora 组检出脸数下降，优先检查脸部崩坏/遮挡，而不是只看 cosine。")
    (out_dir / "report.md").write_text("\n".join(lines) + "\n", encoding="utf-8")
    log(f"报告: {out_dir / 'report.md'}（contact sheets: {list(contact_sheets.values())}）")
    return 0


# ── CLI ──────────────────────────────────────────────

def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Karen MOSS-Image LoRA 生成与评测")
    sub = parser.add_subparsers(dest="command", required=True)

    gen = sub.add_parser("generate", help="批量生成 eval 图（在训练容器内跑）")
    gen.add_argument("--sdscripts", default="/workspace/training/sd-scripts")
    gen.add_argument("--model-dir", default="/workspace/models/MOSS-Image-SFT")
    gen.add_argument("--prompts", required=True)
    gen.add_argument("--out", required=True)
    gen.add_argument("--label", default="base")
    gen.add_argument("--lora", default=None, help="LoRA safetensors 路径；不传 = base")
    gen.add_argument("--limit", type=int, default=0, help="只跑前 N 条（checkpoint 粗筛用）")
    gen.add_argument("--clean", action="store_true", help="清空输出目录里旧 png")
    gen.add_argument("--dry-run", action="store_true", help="只校验路径并打印推理命令")
    gen.set_defaults(func=cmd_generate)

    met = sub.add_parser("metrics", help="ArcFace cosine + contact sheet + 报告（host venv）")
    met.add_argument("--refs", required=True)
    met.add_argument("--dirs", nargs="+", required=True, help="label=dir，如 base=/path/base lora=/path/lora")
    met.add_argument("--out", required=True)
    met.add_argument("--baseline-json", default=None)
    met.add_argument("--model", default="buffalo_l")
    met.add_argument("--providers", default="CPU")
    met.set_defaults(func=cmd_metrics)
    return parser


def main() -> int:
    args = build_parser().parse_args()
    if args.command == "generate":
        return args.func(args)
    return args.func(args)


if __name__ == "__main__":
    raise SystemExit(main())

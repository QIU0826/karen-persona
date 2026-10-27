#!/usr/bin/env python3
"""把 kohya sd-scripts 训练出的 MOSS DiT LoRA merge 进 diffusers MOSSImageTransformer。

背景：训练用 sd-scripts `moss_image_train_network.py`，产出 kohya 格式 `lora_unet_*`
（DiT-only：252 modules × alpha/down/up）。推理侧是 diffusers 的 MOSSImagePipeline，
不能直接加载该格式；本脚本把 ΔW = (up @ down) * (alpha/rank) * multiplier 合并进
`layers.N.proj.{q,k,v,o,ffn_up_gate,ffn_down}.weight`，再保存为新的 diffusers
transformer 目录，并组装成一个完整可 `from_pretrained` 的模型目录（大组件用软链）。

关键映射（实测 252/252 全部命中，无形状不匹配）：
  kohya module `lora_unet_layers_0_proj_ffn_down`
  → 目标 module `layers.0.proj.ffn_down`（把目标 module 的 "." 换成 "_" 反查，
    避免 `ffn_down` / `ffn_up_gate` 这类含下划线的名字被错误拆开）

用法（服务器容器内，不需要 GPU）：
  podman run --rm -v /mnt/data0/lwh/karen-stack:/workspace \
    --entrypoint /workspace/moss-image/venv/bin/python localhost/karen-qwen-image-edit:0.1 \
    /workspace/moss-image/merge_lora.py \
      --base-model-dir /workspace/models/MOSS-Image-SFT \
      --lora /workspace/models/karen-moss-lora/karen_style_moss_v1.safetensors \
      --out-dir /workspace/models/MOSS-Image-SFT-karen-lora \
      --multiplier 1.0

产物：
  <out-dir>/transformer/（merged safetensors + config/index）
  <out-dir>/{model_index.json,pipeline_moss_image.py,scheduler/}（复制）
  <out-dir>/{text_encoder,tokenizer,vae} → 软链到 base model（不重复占 20GB）
  <out-dir>/merge-report.json
"""
from __future__ import annotations

import argparse
import hashlib
import importlib.util
import json
import os
import shutil
import sys
import time
from pathlib import Path

import torch
from safetensors import safe_open


def log(msg: str) -> None:
    print(f"[merge] {msg}", flush=True)


def load_pipeline_module(base_model_dir: Path):
    module_path = base_model_dir / "pipeline_moss_image.py"
    if not module_path.is_file():
        raise FileNotFoundError(f"pipeline_moss_image.py not found in {base_model_dir}")
    spec = importlib.util.spec_from_file_location("pipeline_moss_image", module_path)
    if spec is None or spec.loader is None:
        raise ImportError(f"cannot import {module_path}")
    module = importlib.util.module_from_spec(spec)
    sys.modules["pipeline_moss_image"] = module
    spec.loader.exec_module(module)
    return module


def read_lora(path: Path) -> tuple[dict[str, torch.Tensor], dict[str, str]]:
    tensors: dict[str, torch.Tensor] = {}
    with safe_open(str(path), framework="pt") as handle:
        metadata = handle.metadata() or {}
        for key in handle.keys():
            tensors[key] = handle.get_tensor(key)
    return tensors, metadata


def build_reverse_map(state_dict: dict[str, torch.Tensor]) -> dict[str, str]:
    """目标 module（'.'→'_'）→ 参数名；只收 .weight，用于反查 kohya module。"""
    reverse: dict[str, str] = {}
    for key in state_dict:
        if not key.endswith(".weight"):
            continue
        module = key[: -len(".weight")]
        normalized = module.replace(".", "_")
        if normalized in reverse:
            raise RuntimeError(f"normalized module collision: {normalized}")
        reverse[normalized] = key
    return reverse


def tensor_sha256(tensor: torch.Tensor) -> str:
    return hashlib.sha256(tensor.detach().float().cpu().numpy().tobytes()).hexdigest()[:16]


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--base-model-dir", default="/workspace/models/MOSS-Image-SFT")
    parser.add_argument("--lora", required=True)
    parser.add_argument("--out-dir", required=True)
    parser.add_argument("--multiplier", type=float, default=1.0)
    parser.add_argument(
        "--scale-mode",
        choices=["alpha_over_rank", "alpha", "none"],
        default="alpha_over_rank",
        help="kohya 默认 alpha/rank；部分实现只用 alpha；none=不加缩放",
    )
    parser.add_argument("--dtype", choices=["bf16", "fp32"], default="bf16")
    parser.add_argument("--dry-run", action="store_true", help="只做映射与统计，不写文件")
    args = parser.parse_args()

    base_dir = Path(args.base_model_dir)
    out_dir = Path(args.out_dir)
    lora_path = Path(args.lora)
    if not (base_dir / "transformer").is_dir():
        raise FileNotFoundError(f"base transformer not found: {base_dir / 'transformer'}")
    if not lora_path.is_file():
        raise FileNotFoundError(f"lora not found: {lora_path}")

    started = time.time()
    module = load_pipeline_module(base_dir)
    dtype = torch.bfloat16 if args.dtype == "bf16" else torch.float32
    log(f"loading base transformer from {base_dir / 'transformer'} (dtype={dtype})")
    model = module.MOSSImageTransformer.from_pretrained(
        str(base_dir / "transformer"), torch_dtype=dtype, local_files_only=True
    )
    model.eval()

    lora, metadata = read_lora(lora_path)
    log(f"lora keys={len(lora)} metadata_dim={metadata.get('ss_network_dim')} alpha={metadata.get('ss_network_alpha')}")

    # 从 LoRA 里收集 module：以 .alpha 为准（每个 module 一个 alpha）
    modules = sorted(key.rsplit(".", 1)[0] for key, _ in lora.items() if key.endswith(".alpha"))
    target_by_normalized = build_reverse_map(model.state_dict())

    merged: list[dict[str, object]] = []
    missing: list[str] = []
    skipped: list[dict[str, str]] = []
    params = dict(model.named_parameters())

    for module_name in modules:
        tail = module_name[len("lora_unet_") :] if module_name.startswith("lora_unet_") else module_name
        target_name = target_by_normalized.get(tail)
        if target_name is None:
            missing.append(module_name)
            continue
        down = lora.get(f"{module_name}.lora_down.weight")
        up = lora.get(f"{module_name}.lora_up.weight")
        alpha_t = lora.get(f"{module_name}.alpha")
        if down is None or up is None:
            skipped.append({"module": module_name, "reason": "missing_down_or_up"})
            continue
        if down.ndim != 2 or up.ndim != 2:
            skipped.append({"module": module_name, "reason": f"unsupported_ndim {tuple(down.shape)} {tuple(up.shape)}"})
            continue
        param = params[target_name]
        if tuple(param.shape) != (up.shape[0], down.shape[1]):
            skipped.append(
                {"module": module_name, "reason": f"shape_mismatch target={tuple(param.shape)} down={tuple(down.shape)} up={tuple(up.shape)}"}
            )
            continue
        rank = int(down.shape[0])
        alpha = float(alpha_t.float().reshape(-1)[0]) if alpha_t is not None else float(metadata.get("ss_network_alpha", rank))
        if args.scale_mode == "alpha_over_rank":
            scale = alpha / rank
        elif args.scale_mode == "alpha":
            scale = alpha
        else:
            scale = 1.0
        scale *= args.multiplier
        with torch.no_grad():
            delta = (up.float() @ down.float()) * scale
            before = tensor_sha256(param)
            new_weight = param.detach().float() + delta
            finite = bool(torch.isfinite(new_weight).all())
            if not finite:
                raise RuntimeError(f"NaN/Inf after merge at {target_name}")
            param.copy_(new_weight.to(param.dtype))
            after = tensor_sha256(param)
        merged.append(
            {
                "lora_module": module_name,
                "target": target_name,
                "rank": rank,
                "alpha": alpha,
                "scale": scale,
                "delta_abs_max": float(delta.abs().max()),
                "delta_fro": float(delta.norm()),
                "changed": before != after,
            }
        )

    if missing:
        raise RuntimeError(f"unmapped lora modules ({len(missing)}): {missing[:10]}")
    if skipped:
        raise RuntimeError(f"skipped lora modules ({len(skipped)}): {skipped[:10]}")
    if len(merged) != len(modules):
        raise RuntimeError(f"merged {len(merged)} != lora modules {len(modules)}")
    # 全量权重健康检查
    nan_params = [name for name, param in params.items() if not bool(torch.isfinite(param).all())]
    if nan_params:
        raise RuntimeError(f"non-finite params after merge: {nan_params[:10]}")

    report = {
        "base_model_dir": str(base_dir),
        "lora": str(lora_path),
        "out_dir": str(out_dir),
        "multiplier": args.multiplier,
        "scale_mode": args.scale_mode,
        "dtype": args.dtype,
        "lora_metadata": {
            "ss_network_dim": metadata.get("ss_network_dim"),
            "ss_network_alpha": metadata.get("ss_network_alpha"),
            "ss_steps": metadata.get("ss_steps"),
            "ss_base_model_version": metadata.get("ss_base_model_version"),
            "modelspec_architecture": metadata.get("modelspec.architecture"),
        },
        "modules_total": len(modules),
        "modules_merged": len(merged),
        "modules_changed": sum(1 for item in merged if item["changed"]),
        "params_total": len(params),
        "params_non_finite": 0,
        "delta_abs_max": max(item["delta_abs_max"] for item in merged),
        "delta_abs_max_module": max(merged, key=lambda item: item["delta_abs_max"])["target"],
        "merge_seconds": None,
        "merged_at": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
    }
    log(
        f"merged {report['modules_merged']}/{len(modules)} modules, changed={report['modules_changed']}, "
        f"max|delta|={report['delta_abs_max']:.6f} @ {report['delta_abs_max_module']}"
    )

    if args.dry_run:
        report["dry_run"] = True
        report["merge_seconds"] = round(time.time() - started, 2)
        print(json.dumps(report, ensure_ascii=False, indent=2))
        return 0

    # 1) 保存 merged transformer
    transformer_out = out_dir / "transformer"
    if transformer_out.exists():
        shutil.rmtree(transformer_out)
    transformer_out.mkdir(parents=True, exist_ok=True)
    log(f"saving merged transformer -> {transformer_out}")
    model.save_pretrained(str(transformer_out), safe_serialization=True)
    # 组件自定义代码副本（diffusers 自定义组件也会在 transformer/ 里找模块）
    shutil.copy2(base_dir / "transformer" / "pipeline_moss_image.py", transformer_out / "pipeline_moss_image.py")

    # 2) 组装完整模型目录：小文件复制、大组件软链（不重复占 20GB+）
    for name in ("model_index.json", "pipeline_moss_image.py"):
        shutil.copy2(base_dir / name, out_dir / name)
    if (out_dir / "scheduler").exists():
        shutil.rmtree(out_dir / "scheduler")
    shutil.copytree(base_dir / "scheduler", out_dir / "scheduler")
    for name in ("text_encoder", "tokenizer", "vae"):
        link = out_dir / name
        if link.is_symlink() or link.is_file():
            link.unlink()
        elif link.is_dir():
            shutil.rmtree(link)
        os.symlink(base_dir / name, link)

    report["merge_seconds"] = round(time.time() - started, 2)
    (out_dir / "merge-report.json").write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    log(f"done in {report['merge_seconds']}s -> {out_dir}")
    print(json.dumps(report, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

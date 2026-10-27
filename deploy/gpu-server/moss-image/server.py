#!/usr/bin/env python3
"""MOSS-Image-SFT text-to-image HTTP service (single GPU, 50-step default).

基于官方推理约定：
- bf16 transformer/text encoder，VAE 与初始噪声 float32；
- 50 步 Flow-matching Euler（scheduler shift=5.0）、guidance 3.0、负分支跳过第 22 层；
- 宽高必须为 16 的正整数倍。

端口约定（均为回环，Mac 侧通过 scripts/gpu-tunnel.sh 的 19114/19115 访问）：
- 18114：/generate（PNG）+ /health
- 18115：/edit（当前返回 501，参考图编辑需要另行部署 Moss-Image-Edit）+ /health

模型加载放后台线程：进程先起 HTTP，/health 报 loaded=false/loading=true，
加载完成后再置 loaded=true；这样隧道/探活/健康检查在加载期也能连上。
"""
from __future__ import annotations

import asyncio
import importlib.util
import io
import os
import sys
import threading
import time
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any

import torch
import uvicorn
from fastapi import FastAPI, HTTPException, Response
from pydantic import BaseModel, Field

MODEL_DIR = Path(os.environ.get("MOSS_IMAGE_MODEL_DIR", "/workspace/models/MOSS-Image-SFT")).expanduser()
HOST = os.environ.get("MOSS_IMAGE_HOST", "0.0.0.0")
PORT = int(os.environ.get("MOSS_IMAGE_PORT", "18114"))
EDIT_PORT = int(os.environ.get("MOSS_IMAGE_EDIT_PORT", "18115"))
DEVICE = os.environ.get("MOSS_IMAGE_DEVICE", "cuda")
DEFAULT_STEPS = int(os.environ.get("MOSS_IMAGE_STEPS", "50"))
DEFAULT_GUIDANCE = float(os.environ.get("MOSS_IMAGE_GUIDANCE", "3.0"))
DEFAULT_SKIP_LAYERS = os.environ.get("MOSS_IMAGE_UNCOND_SKIP_LAYERS", "22")
DEFAULT_SIZE = int(os.environ.get("MOSS_IMAGE_DEFAULT_SIZE", "1024"))
MIN_SIDE = int(os.environ.get("MOSS_IMAGE_MIN_SIDE", "256"))
MAX_SIDE = int(os.environ.get("MOSS_IMAGE_MAX_SIDE", "1536"))
MULTIPLE = 16

_pipe: Any = None
_loaded = False
_loading = False
_load_error: str | None = None
_load_ms = 0
_loaded_at = 0.0
_load_mode = ""
_lock = threading.Lock()
_generate_count = 0
_last_generate: dict[str, Any] | None = None


def _skip_layers_from_env() -> list[int]:
    raw = (DEFAULT_SKIP_LAYERS or "").strip()
    if raw in ("", "none", "None", "[]"):
        return []
    layers: list[int] = []
    for part in raw.replace(";", ",").split(","):
        part = part.strip()
        if not part:
            continue
        try:
            layers.append(int(part))
        except ValueError:
            raise ValueError(f"invalid MOSS_IMAGE_UNCOND_SKIP_LAYERS entry: {part!r}")
    return layers


def _gpu_info() -> dict[str, Any]:
    if not torch.cuda.is_available():
        return {"available": False}
    index = torch.cuda.current_device()
    free, total = torch.cuda.mem_get_info(index)
    props = torch.cuda.get_device_properties(index)
    return {
        "available": True,
        "name": torch.cuda.get_device_name(index),
        "total_gb": round(total / 1024**3, 2),
        "free_gb": round(free / 1024**3, 2),
        "allocated_gb": round(torch.cuda.memory_allocated(index) / 1024**3, 2),
        "peak_allocated_gb": round(torch.cuda.max_memory_allocated(index) / 1024**3, 2),
        "capability": f"{props.major}.{props.minor}",
    }


def _load_pipeline() -> Any:
    """按官方 README 路径加载；失败时回退到显式的自定义类导入。

    MOSS_IMAGE_LOAD_MODE 可强制单一模式（pipeline|custom|components|auto），
    便于在依赖版本不匹配时快速定位，而不是每次都等前一种失败。
    """
    from diffusers import DiffusionPipeline

    dtype = {"default": torch.bfloat16, "vae": torch.float32}
    mode = (os.environ.get("MOSS_IMAGE_LOAD_MODE") or "auto").strip().lower()
    errors: list[str] = []

    def via_pretrained(custom_pipeline: str | None) -> Any:
        kwargs: dict[str, Any] = {"trust_remote_code": True, "local_files_only": True}
        if custom_pipeline:
            kwargs["custom_pipeline"] = custom_pipeline
        last_error: Exception | None = None
        # diffusers 新旧版本对 dtype 参数名不一致：依次尝试 torch_dtype / dtype
        for key in ("torch_dtype", "dtype"):
            try:
                return DiffusionPipeline.from_pretrained(str(MODEL_DIR), **{key: dtype}, **kwargs)
            except Exception as exc:  # noqa: BLE001
                last_error = exc
                errors.append(f"{custom_pipeline or 'pipeline'}({key}): {type(exc).__name__}: {exc}")
        raise last_error if last_error is not None else RuntimeError("from_pretrained failed")

    # A. README 推荐路径（local dir + trust_remote_code）
    if mode in ("auto", "pipeline"):
        try:
            pipe = via_pretrained(None)
            print("[moss] loaded via DiffusionPipeline.from_pretrained(local_dir)", flush=True)
            return pipe
        except Exception:  # noqa: BLE001
            pass

    # B. 显式指定 custom_pipeline
    if mode in ("auto", "custom"):
        try:
            pipe = via_pretrained("pipeline_moss_image")
            print("[moss] loaded via from_pretrained(custom_pipeline=pipeline_moss_image)", flush=True)
            return pipe
        except Exception:  # noqa: BLE001
            pass

    # C. 直接从模型目录里的 pipeline_moss_image.py 导入类，分组件加载
    if mode in ("auto", "components"):
        try:
            module_path = MODEL_DIR / "pipeline_moss_image.py"
            spec = importlib.util.spec_from_file_location("pipeline_moss_image", module_path)
            if spec is None or spec.loader is None:
                raise ImportError(f"cannot load module from {module_path}")
            module = importlib.util.module_from_spec(spec)
            sys.modules["pipeline_moss_image"] = module
            spec.loader.exec_module(module)
            pipe = module.MOSSImagePipeline.from_components_pretrained(
                transformer_path=str(MODEL_DIR / "transformer"),
                text_encoder_path=str(MODEL_DIR / "text_encoder"),
                vae_path=str(MODEL_DIR / "vae"),
                torch_dtype=torch.bfloat16,
                vae_dtype=torch.float32,
                local_files_only=True,
            )
            print(
                "[moss] loaded via local module MOSSImagePipeline.from_components_pretrained",
                flush=True,
            )
            return pipe
        except Exception as exc:  # noqa: BLE001
            errors.append(f"from_components: {type(exc).__name__}: {exc}")

    raise RuntimeError(" | ".join(errors) or f"unknown load mode: {mode}")


def _load_worker() -> None:
    global _pipe, _loaded, _loading, _load_error, _load_ms, _loaded_at, _load_mode
    started = time.time()
    try:
        if not MODEL_DIR.is_dir():
            raise FileNotFoundError(f"model dir not found: {MODEL_DIR}")
        torch.cuda.init()
        torch.backends.cuda.matmul.allow_tf32 = True
        pipe = _load_pipeline()
        pipe.scheduler = type(pipe.scheduler).from_config(pipe.scheduler.config)
        pipe.set_progress_bar_config(disable=True)
        pipe.to(DEVICE)
        # DiffusionPipeline 本身不是 nn.Module（没有 .eval()）；对组件逐个 eval。
        for component in ("transformer", "text_encoder", "vae"):
            module = getattr(pipe, component, None)
            if isinstance(module, torch.nn.Module):
                module.eval()
        _load_ms = int((time.time() - started) * 1000)
        _loaded_at = time.time()
        _load_mode = type(pipe).__module__ + "." + type(pipe).__name__
        _pipe = pipe
        _loaded = True
        _load_error = None
        print(
            f"[moss] loaded model={MODEL_DIR} mode={_load_mode} device={DEVICE} "
            f"load_ms={_load_ms} gpu={_gpu_info()}",
            flush=True,
        )
    except Exception as exc:  # noqa: BLE001
        _load_error = f"{type(exc).__name__}: {exc}"
        print(f"[moss] LOAD FAILED: {_load_error}", flush=True)
    finally:
        _loading = False


@asynccontextmanager
async def lifespan(app: FastAPI):
    global _loading
    if not _loading and not _loaded:
        _loading = True
        thread = threading.Thread(target=_load_worker, name="moss-load", daemon=True)
        thread.start()
    yield


app = FastAPI(title="Karen MOSS-Image", version="0.1.0", lifespan=lifespan)
# /edit 与 /generate 分端口：共享同一进程/同一份模型，不再加载第二份权重。
edit_app = FastAPI(title="Karen MOSS-Image Edit", version="0.1.0")


class GenerateRequest(BaseModel):
    prompt: str = Field(..., min_length=1, max_length=4000)
    width: int = DEFAULT_SIZE
    height: int = DEFAULT_SIZE
    steps: int = DEFAULT_STEPS
    seed: int = 0
    guidance_scale: float = DEFAULT_GUIDANCE
    negative_prompt: str = ""
    uncond_skip_layers: list[int] | None = None


class EditRequest(BaseModel):
    prompt: str = Field(..., min_length=1, max_length=4000)
    image_paths: list[str] = Field(default_factory=list)
    width: int = DEFAULT_SIZE
    height: int = DEFAULT_SIZE
    steps: int = DEFAULT_STEPS
    seed: int = 0


def _health_payload() -> dict[str, Any]:
    gpu = _gpu_info()
    return {
        "ok": bool(_loaded and _load_error is None),
        "loaded": bool(_loaded),
        "loading": bool(_loading),
        "model": str(MODEL_DIR),
        "model_exists": MODEL_DIR.is_dir(),
        "load_error": _load_error,
        "load_mode": _load_mode,
        "load_mode_setting": (os.environ.get("MOSS_IMAGE_LOAD_MODE") or "auto"),
        "load_ms": _load_ms,
        "loaded_at": _loaded_at,
        "device": DEVICE,
        "generate_count": _generate_count,
        "last_generate": _last_generate,
        "defaults": {
            "steps": DEFAULT_STEPS,
            "guidance_scale": DEFAULT_GUIDANCE,
            "uncond_skip_layers": _skip_layers_from_env(),
            "default_size": DEFAULT_SIZE,
            "min_side": MIN_SIDE,
            "max_side": MAX_SIDE,
            "multiple": MULTIPLE,
        },
        "gpu": gpu,
    }


def _validate_size(width: int, height: int) -> tuple[int, int]:
    for name, value in (("width", width), ("height", height)):
        if value < MIN_SIDE or value > MAX_SIDE:
            raise HTTPException(status_code=400, detail=f"{name} must be in [{MIN_SIDE}, {MAX_SIDE}]")
        if value % MULTIPLE != 0:
            raise HTTPException(status_code=400, detail=f"{name} must be a multiple of {MULTIPLE}")
    return int(width), int(height)


@app.get("/health")
def health():
    return _health_payload()


@edit_app.get("/health")
def edit_health():
    return {**_health_payload(), "role": "edit"}


def _generate_png(req: GenerateRequest) -> Response:
    global _generate_count, _last_generate
    if _load_error is not None:
        raise HTTPException(status_code=503, detail=f"model load failed: {_load_error}")
    if not _loaded or _pipe is None:
        raise HTTPException(status_code=503, detail="model not loaded yet")
    width, height = _validate_size(req.width, req.height)
    steps = max(1, min(100, int(req.steps)))
    guidance = max(0.0, min(10.0, float(req.guidance_scale)))
    skip_layers = (
        req.uncond_skip_layers
        if req.uncond_skip_layers is not None
        else _skip_layers_from_env()
    )
    started = time.time()
    with _lock:
        try:
            torch.cuda.synchronize()
            torch.cuda.reset_peak_memory_stats()
            generator = torch.Generator("cpu").manual_seed(int(req.seed))
            image = _pipe(
                prompt=req.prompt,
                height=height,
                width=width,
                num_inference_steps=steps,
                guidance_scale=guidance,
                negative_prompt=req.negative_prompt or "",
                uncond_skip_layers=skip_layers,
                generator=generator,
                output_type="pil",
            ).images[0]
            torch.cuda.synchronize()
        except Exception as exc:  # noqa: BLE001
            raise HTTPException(status_code=500, detail=f"generate failed: {type(exc).__name__}: {exc}") from exc
        elapsed_ms = int((time.time() - started) * 1000)
        peak_gb = round(torch.cuda.max_memory_allocated() / 1024**3, 2)
        _generate_count += 1
        _last_generate = {
            "elapsed_ms": elapsed_ms,
            "width": width,
            "height": height,
            "steps": steps,
            "seed": int(req.seed),
            "guidance_scale": guidance,
            "uncond_skip_layers": skip_layers,
            "peak_allocated_gb": peak_gb,
            "finished_at": time.time(),
        }
        print(
            f"[moss] generate ok {width}x{height} steps={steps} seed={req.seed} "
            f"elapsed_ms={elapsed_ms} peak_gb={peak_gb}",
            flush=True,
        )
    buf = io.BytesIO()
    image.save(buf, format="PNG")
    body = buf.getvalue()
    return Response(
        content=body,
        media_type="image/png",
        headers={
            "X-Image-Width": str(image.width),
            "X-Image-Height": str(image.height),
            "X-Image-Steps": str(steps),
            "X-Image-Seed": str(int(req.seed)),
            "X-Elapsed-Ms": str(elapsed_ms),
            "X-Gpu-Peak-Gb": str(peak_gb),
        },
    )


@app.post("/generate")
def generate(req: GenerateRequest):
    return _generate_png(req)


@edit_app.post("/edit")
def edit(req: EditRequest):
    # MOSS-Image-SFT 只有文生图分支（pipeline 没有 reference image 输入）；
    # 参考图编辑需要 Moss-Image-Edit（GPLv3，另行部署），这里先明确 501。
    raise HTTPException(
        status_code=501,
        detail=(
            "MOSS-Image-SFT is text-to-image only; reference-image editing requires "
            "Moss-Image-Edit, which is not deployed. Use the existing Qwen-Image-Edit "
            "backend (KAREN_SELFIE_BACKEND=qwen) until the edit model is available."
        ),
    )


async def _serve() -> None:
    main_cfg = uvicorn.Config(app, host=HOST, port=PORT, log_level=os.environ.get("MOSS_LOG_LEVEL", "info"))
    edit_cfg = uvicorn.Config(
        edit_app, host=HOST, port=EDIT_PORT, log_level=os.environ.get("MOSS_EDIT_LOG_LEVEL", "warning")
    )
    await asyncio.gather(
        uvicorn.Server(main_cfg).serve(),
        uvicorn.Server(edit_cfg).serve(),
    )


if __name__ == "__main__":
    print(f"[moss] starting ports generate={PORT} edit={EDIT_PORT} model={MODEL_DIR}", flush=True)
    asyncio.run(_serve())

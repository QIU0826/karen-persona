#!/usr/bin/env python3
"""Minimal Qwen-Image-Edit-2511 HTTP service (multi-reference image editing)."""
from __future__ import annotations

import io
import os
import time
from contextlib import asynccontextmanager
from pathlib import Path

import torch
import uvicorn
from fastapi import FastAPI, HTTPException, Response
from PIL import Image
from pydantic import BaseModel, Field

MODEL_DIR = os.environ.get("QWEN_IMAGE_EDIT_MODEL_DIR", "/workspace/models/Qwen-Image-Edit-2511")
REF_DIR = os.environ.get("QWEN_IMAGE_EDIT_REF_DIR", "/workspace/data/karen-ref-clean")
MAX_SIDE = int(os.environ.get("QWEN_IMAGE_MAX_SIDE", "896"))
SIMPLE_CROP = float(os.environ.get("QWEN_IMAGE_SIMPLE_CROP", "0.72"))
DEFAULT_NEG = (
    "bad hands, extra fingers, missing fingers, fused fingers, deformed hands, "
    "distorted anatomy, extra limbs, low quality, blurry"
)
SIMPLE_SUFFIX = "，胸部以上近景，不出现手部和手臂，背景简洁"
HOST = os.environ.get("QWEN_IMAGE_EDIT_HOST", "0.0.0.0")
PORT = int(os.environ.get("QWEN_IMAGE_EDIT_PORT", "18110"))

_pipe = None
_refs: list[str] = []
_loaded_at = 0.0


class EditRequest(BaseModel):
    prompt: str = Field(..., min_length=1, max_length=2000)
    image_paths: list[str] | None = None
    negative_prompt: str | None = None
    simple: bool = True
    num_inference_steps: int = 20
    true_cfg_scale: float = 4.0
    guidance_scale: float = 1.0
    seed: int = 0


def _default_refs() -> list[str]:
    exts = {".jpg", ".jpeg", ".png", ".webp"}
    paths = sorted(
        str(p)
        for p in Path(REF_DIR).glob("*")
        if p.is_file() and p.suffix.lower() in exts
    )
    return paths[:4]


@asynccontextmanager
async def lifespan(app: FastAPI):
    global _pipe, _refs, _loaded_at
    from diffusers import QwenImageEditPlusPipeline

    if not os.path.isdir(MODEL_DIR):
        raise RuntimeError(f"model dir not found: {MODEL_DIR}")
    _refs = _default_refs()
    if not _refs:
        raise RuntimeError(f"no reference images in {REF_DIR}")
    dtype = torch.bfloat16 if torch.cuda.is_available() else torch.float32
    _pipe = QwenImageEditPlusPipeline.from_pretrained(MODEL_DIR, torch_dtype=dtype)
    _pipe.to("cuda" if torch.cuda.is_available() else "cpu")
    _pipe.set_progress_bar_config(disable=True)
    _loaded_at = time.time()
    print(
        f"[qwen-image-edit] loaded model={MODEL_DIR} device={_pipe.device} refs={_refs}",
        flush=True,
    )
    yield


app = FastAPI(title="Karen Qwen-Image-Edit", version="0.1.0", lifespan=lifespan)


@app.get("/health")
def health():
    return {
        "ok": _pipe is not None,
        "model": MODEL_DIR,
        "refs": _refs,
        "device": str(_pipe.device) if _pipe is not None else None,
        "gpu": torch.cuda.get_device_name(0) if torch.cuda.is_available() else None,
        "loaded_at": _loaded_at,
    }


@app.post("/edit")
def edit(req: EditRequest):
    if _pipe is None:
        raise HTTPException(status_code=503, detail="model not loaded")
    paths = req.image_paths or _refs
    if not paths:
        raise HTTPException(status_code=400, detail="no image paths")
    images = []
    for raw in paths:
        p = Path(raw)
        if not p.is_absolute():
            p = Path("/workspace") / p
        if not p.is_file():
            raise HTTPException(status_code=400, detail=f"image not found: {p}")
        img = Image.open(p).convert("RGB")
        if MAX_SIDE > 0 and max(img.size) > MAX_SIDE:
            img.thumbnail((MAX_SIDE, MAX_SIDE), Image.LANCZOS)
        images.append(img)

    try:
        generator = torch.Generator(device="cuda" if torch.cuda.is_available() else "cpu")
        generator.manual_seed(int(req.seed))
        prompt = req.prompt
        if req.simple:
            prompt = prompt.rstrip("。") + SIMPLE_SUFFIX
        negative = DEFAULT_NEG if req.negative_prompt is None else req.negative_prompt
        out = _pipe(
            image=images,
            prompt=prompt,
            negative_prompt=negative,
            true_cfg_scale=max(1.0, min(10.0, float(req.true_cfg_scale))),
            guidance_scale=max(0.0, min(5.0, float(req.guidance_scale))),
            num_inference_steps=max(8, min(80, int(req.num_inference_steps))),
            generator=generator,
            num_images_per_prompt=1,
        )
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=500, detail=f"edit failed: {exc}") from exc

    image = out.images[0]
    if req.simple and 0.3 <= SIMPLE_CROP < 1.0:
        w, h = image.size
        image = image.crop((0, 0, w, max(1, int(h * SIMPLE_CROP))))
    buf = io.BytesIO()
    image.save(buf, format="PNG")
    return Response(
        content=buf.getvalue(),
        media_type="image/png",
        headers={"X-Image-Width": str(image.width), "X-Image-Height": str(image.height)},
    )


if __name__ == "__main__":
    uvicorn.run(app, host=HOST, port=PORT, log_level="info")

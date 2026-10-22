#!/usr/bin/env python3
"""Minimal Z-Image-Turbo text-to-image HTTP service (8-step, 1024px)."""
from __future__ import annotations

import io
import os
import time
from contextlib import asynccontextmanager

import torch
import uvicorn
from fastapi import FastAPI, HTTPException, Response
from pydantic import BaseModel, Field

MODEL_DIR = os.environ.get("ZIMAGE_MODEL_DIR", "/workspace/models/Z-Image-Turbo")
HOST = os.environ.get("ZIMAGE_HOST", "0.0.0.0")
PORT = int(os.environ.get("ZIMAGE_PORT", "18111"))

_pipe = None
_loaded_at = 0.0


class GenerateRequest(BaseModel):
    prompt: str = Field(..., min_length=1, max_length=2000)
    width: int = 1024
    height: int = 1024
    steps: int = 9
    seed: int = 0


@asynccontextmanager
async def lifespan(app: FastAPI):
    global _pipe, _loaded_at
    from diffusers import ZImagePipeline

    if not os.path.isdir(MODEL_DIR):
        raise RuntimeError(f"model dir not found: {MODEL_DIR}")
    dtype = torch.bfloat16 if torch.cuda.is_available() else torch.float32
    _pipe = ZImagePipeline.from_pretrained(MODEL_DIR, torch_dtype=dtype, low_cpu_mem_usage=False)
    _pipe.to("cuda" if torch.cuda.is_available() else "cpu")
    _pipe.set_progress_bar_config(disable=True)
    _loaded_at = time.time()
    print(f"[z-image] loaded model={MODEL_DIR} device={_pipe.device}", flush=True)
    yield


app = FastAPI(title="Karen Z-Image", version="0.1.0", lifespan=lifespan)


@app.get("/health")
def health():
    return {
        "ok": _pipe is not None,
        "model": MODEL_DIR,
        "device": str(_pipe.device) if _pipe is not None else None,
        "gpu": torch.cuda.get_device_name(0) if torch.cuda.is_available() else None,
        "loaded_at": _loaded_at,
    }


@app.post("/generate")
def generate(req: GenerateRequest):
    if _pipe is None:
        raise HTTPException(status_code=503, detail="model not loaded")
    width = max(512, min(1536, int(req.width)))
    height = max(512, min(1536, int(req.height)))
    steps = max(4, min(30, int(req.steps)))
    try:
        generator = torch.Generator(device="cuda" if torch.cuda.is_available() else "cpu")
        generator.manual_seed(int(req.seed))
        out = _pipe(
            prompt=req.prompt,
            width=width,
            height=height,
            num_inference_steps=steps,
            guidance_scale=0.0,
            generator=generator,
        )
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=500, detail=f"generate failed: {exc}") from exc
    image = out.images[0]
    buf = io.BytesIO()
    image.save(buf, format="PNG")
    return Response(
        content=buf.getvalue(),
        media_type="image/png",
        headers={"X-Image-Width": str(image.width), "X-Image-Height": str(image.height)},
    )


if __name__ == "__main__":
    uvicorn.run(app, host=HOST, port=PORT, log_level="info")

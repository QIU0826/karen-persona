"""karen 本地生图服务（v0.7）。

用 diffusers + PyTorch MPS 在本机跑 SDXL-Turbo（单步出图），通过 HTTP 给 Node 侧调用。
这样做的原因：ComfyUI 源码要从 GitHub 克隆（本机只有 ~17KB/s，不可行），而 PyPI（2MB/s）
与 HuggingFace（~30MB/s）都很快——所以直接用 diffusers，不需要 ComfyUI。

目录约定（便于清理）：
- 模型缓存：`$KAREN_MODELS_DIR/hf`（HF_HOME 指过去；默认 ~/Library/Application Support/karen/models/hf）
- 生成图：由 Node 侧写到 `KAREN_DATA_DIR/generated/日期/`（本服务只返回 PNG 字节）

启动：
    KAREN_MODELS_DIR=... services/image/.venv/bin/python services/image/server.py
环境变量：
    KAREN_IMAGE_PORT（默认 18084）、KAREN_IMAGE_MODEL（默认 stabilityai/sdxl-turbo）
"""

from __future__ import annotations

import io
import os
from pathlib import Path
from typing import Optional

from fastapi import FastAPI, HTTPException
from fastapi.responses import Response
from pydantic import BaseModel, Field

PORT = int(os.environ.get("KAREN_IMAGE_PORT", "18084"))
MODEL = os.environ.get("KAREN_IMAGE_MODEL", "stabilityai/sdxl-turbo")

# 模型统一放 KAREN_MODELS_DIR/hf，方便一键清理
_models_root = os.environ.get("KAREN_MODELS_DIR") or str(
    Path.home() / "Library" / "Application Support" / "karen" / "models"
)
os.environ.setdefault("HF_HOME", str(Path(_models_root) / "hf"))

app = FastAPI(title="karen-local-image", version="0.1.0")
_pipe = None
_device = "cpu"


class GenerateRequest(BaseModel):
    prompt: str
    negative_prompt: str = ""
    seed: Optional[int] = None
    width: int = Field(default=832, ge=384, le=1216)
    height: int = Field(default=1216, ge=384, le=1216)
    steps: int = Field(default=1, ge=1, le=8)
    guidance: float = Field(default=0.0, ge=0.0, le=8.0)


def _get_pipe():
    """懒加载 SDXL-Turbo（首次会下载 ≈6.9GB 到 HF_HOME）。"""
    global _pipe, _device
    if _pipe is not None:
        return _pipe
    try:
        import torch
        from diffusers import AutoPipelineForText2Image
    except ImportError as err:  # pragma: no cover
        raise HTTPException(status_code=503, detail="缺少 diffusers/torch") from err

    if torch.backends.mps.is_available():
        _device = "mps"
    torch_dtype = torch.float16 if _device == "mps" else torch.float32
    pipe = AutoPipelineForText2Image.from_pretrained(
        MODEL,
        torch_dtype=torch_dtype,
        variant="fp16" if torch_dtype == torch.float16 else None,
        safety_checker=None,
    )
    pipe = pipe.to(_device)
    if hasattr(pipe, "set_progress_bar_config"):
        pipe.set_progress_bar_config(disable=True)
    _pipe = pipe
    return _pipe


@app.get("/health")
def health() -> dict:
    return {
        "ok": True,
        "model": MODEL,
        "device": _device,
        "loaded": _pipe is not None,
        "hf_home": os.environ.get("HF_HOME", ""),
    }


@app.post("/generate")
def generate(req: GenerateRequest) -> Response:
    if not req.prompt.strip():
        raise HTTPException(status_code=400, detail="empty_prompt")
    try:
        import torch
        import random

        pipe = _get_pipe()
        seed = req.seed if req.seed is not None else random.randint(0, 1_000_000)
        generator = torch.Generator(device=_device).manual_seed(int(seed))
        # SDXL-Turbo：steps=1、guidance_scale=0（不需要 CFG）
        kwargs = dict(
            prompt=req.prompt,
            num_inference_steps=req.steps,
            guidance_scale=req.guidance,
            width=req.width,
            height=req.height,
            generator=generator,
        )
        if req.negative_prompt:
            kwargs["negative_prompt"] = req.negative_prompt
        image = pipe(**kwargs).images[0]
        buf = io.BytesIO()
        image.save(buf, format="PNG", optimize=False)
        return Response(content=buf.getvalue(), media_type="image/png")
    except HTTPException:
        raise
    except Exception as err:  # pragma: no cover
        raise HTTPException(status_code=503, detail=f"generate_failed: {type(err).__name__}: {err}") from err


if __name__ == "__main__":  # pragma: no cover
    import uvicorn

    uvicorn.run(app, host="127.0.0.1", port=PORT, log_level="info")

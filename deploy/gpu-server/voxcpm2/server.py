#!/usr/bin/env python3
"""Minimal VoxCPM2 HTTP service (48 kHz, zero-shot clone + style instruction)."""
from __future__ import annotations

import io
import os
import time
from contextlib import asynccontextmanager

import numpy as np
import soundfile as sf
import torch
import uvicorn
from fastapi import FastAPI, HTTPException, Response
from pydantic import BaseModel, Field

MODEL_DIR = os.environ.get("VOXCPM2_MODEL_DIR", "/workspace/models/VoxCPM2")
REF_AUDIO = os.environ.get("VOXCPM2_REF_AUDIO", "/workspace/data/voice-ref/xiaoya.wav")
REF_TEXT = os.environ.get("VOXCPM2_REF_TEXT", "").strip()
HOST = os.environ.get("VOXCPM2_HOST", "0.0.0.0")
PORT = int(os.environ.get("VOXCPM2_PORT", "18102"))

_model = None
_sample_rate = 48000
_loaded_at = 0.0


class SynthRequest(BaseModel):
    text: str = Field(..., min_length=1, max_length=2000)
    style: str | None = None
    cfg_value: float = 2.0
    inference_timesteps: int = 10


@asynccontextmanager
async def lifespan(app: FastAPI):
    global _model, _sample_rate, _loaded_at
    from voxcpm import VoxCPM

    if not os.path.isdir(MODEL_DIR):
        raise RuntimeError(f"model dir not found: {MODEL_DIR}")
    _model = VoxCPM.from_pretrained(MODEL_DIR, load_denoiser=False)
    _sample_rate = int(getattr(_model.tts_model, "sample_rate", 48000))
    _loaded_at = time.time()
    print(f"[voxcpm2] loaded model={MODEL_DIR} sr={_sample_rate} ref={REF_AUDIO}", flush=True)
    yield


app = FastAPI(title="Karen VoxCPM2", version="0.1.0", lifespan=lifespan)


@app.get("/health")
def health():
    return {
        "ok": _model is not None,
        "model": MODEL_DIR,
        "ref_audio": REF_AUDIO,
        "sample_rate": _sample_rate,
        "device": "cuda:0" if torch.cuda.is_available() else "cpu",
        "gpu": torch.cuda.get_device_name(0) if torch.cuda.is_available() else None,
        "loaded_at": _loaded_at,
    }


@app.post("/synthesize")
def synthesize(req: SynthRequest):
    if _model is None:
        raise HTTPException(status_code=503, detail="model not loaded")
    text = req.text
    if req.style and req.style.strip():
        text = f"({req.style.strip()}){text}"
    kwargs = {
        "text": text,
        "reference_wav_path": REF_AUDIO,
        "cfg_value": max(1.0, min(3.0, float(req.cfg_value))),
        "inference_timesteps": max(4, min(32, int(req.inference_timesteps))),
    }
    if REF_TEXT:
        kwargs.update(
            prompt_wav_path=REF_AUDIO,
            prompt_text=REF_TEXT,
        )
    try:
        wav = _model.generate(**kwargs)
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=500, detail=f"synthesis failed: {exc}") from exc

    arr = np.asarray(wav, dtype=np.float32).squeeze()
    buf = io.BytesIO()
    sf.write(buf, arr, _sample_rate, format="WAV", subtype="PCM_16")
    data = buf.getvalue()
    return Response(
        content=data,
        media_type="audio/wav",
        headers={
            "X-Sample-Rate": str(_sample_rate),
            "X-Audio-Seconds": f"{len(arr) / _sample_rate:.3f}",
        },
    )


if __name__ == "__main__":
    uvicorn.run(app, host=HOST, port=PORT, log_level="info")

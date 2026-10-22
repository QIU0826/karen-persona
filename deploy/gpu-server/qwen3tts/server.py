#!/usr/bin/env python3
"""Minimal Qwen3-TTS voice-clone HTTP service.

Runs inside a CUDA/PyTorch container; exposes:
  GET  /health
  POST /synthesize  {"text": "...", "language": "Chinese", "ref_audio": "...", "ref_text": "..."}
Returns a 24 kHz WAV (audio/wav).
"""
from __future__ import annotations

import io
import os
import time
from contextlib import asynccontextmanager

import soundfile as sf
import torch
import uvicorn
from fastapi import FastAPI, HTTPException, Response
from pydantic import BaseModel, Field

MODEL_DIR = os.environ.get("QWEN3_TTS_MODEL_DIR", "/workspace/models/Qwen3-TTS-12Hz-1.7B-Base")
REF_AUDIO = os.environ.get("QWEN3_TTS_REF_AUDIO", "/workspace/data/voice-ref/xiaoya.wav")
HOST = os.environ.get("QWEN3_TTS_HOST", "127.0.0.1")
PORT = int(os.environ.get("QWEN3_TTS_PORT", "18101"))

_model = None
_prompt = None
_loaded_at = 0.0


class SynthRequest(BaseModel):
    text: str = Field(..., min_length=1, max_length=2000)
    language: str = "Chinese"
    ref_audio: str | None = None
    ref_text: str | None = None
    x_vector_only_mode: bool = True


@asynccontextmanager
async def lifespan(app: FastAPI):
    global _model, _prompt, _loaded_at
    from qwen_tts import Qwen3TTSModel

    if not os.path.isdir(MODEL_DIR):
        raise RuntimeError(f"model dir not found: {MODEL_DIR}")
    device = "cuda:0" if torch.cuda.is_available() else "cpu"
    _model = Qwen3TTSModel.from_pretrained(
        MODEL_DIR,
        device_map=device,
        dtype=torch.bfloat16 if device.startswith("cuda") else torch.float32,
        attn_implementation="sdpa",
    )
    _prompt = _model.create_voice_clone_prompt(
        ref_audio=REF_AUDIO,
        x_vector_only_mode=True,
    )
    _loaded_at = time.time()
    print(f"[qwen3tts] loaded model={MODEL_DIR} device={device} ref={REF_AUDIO}", flush=True)
    yield


app = FastAPI(title="Karen Qwen3-TTS", version="0.1.0", lifespan=lifespan)


@app.get("/health")
def health():
    return {
        "ok": _model is not None,
        "model": MODEL_DIR,
        "ref_audio": REF_AUDIO,
        "device": "cuda:0" if torch.cuda.is_available() else "cpu",
        "gpu": torch.cuda.get_device_name(0) if torch.cuda.is_available() else None,
        "loaded_at": _loaded_at,
    }


@app.post("/synthesize")
def synthesize(req: SynthRequest):
    if _model is None:
        raise HTTPException(status_code=503, detail="model not loaded")
    try:
        kwargs = {
            "text": req.text,
            "language": req.language,
            "voice_clone_prompt": _prompt,
        }
        if req.ref_audio and not req.x_vector_only_mode:
            kwargs = {
                "text": req.text,
                "language": req.language,
                "ref_audio": req.ref_audio,
                "ref_text": req.ref_text,
                "x_vector_only_mode": False,
            }
        wavs, sr = _model.generate_voice_clone(**kwargs)
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=500, detail=f"synthesis failed: {exc}") from exc

    buf = io.BytesIO()
    sf.write(buf, wavs[0], sr, format="WAV")
    data = buf.getvalue()
    return Response(
        content=data,
        media_type="audio/wav",
        headers={
            "X-Sample-Rate": str(sr),
            "X-Audio-Seconds": f"{len(wavs[0]) / sr:.3f}",
        },
    )


if __name__ == "__main__":
    uvicorn.run(app, host=HOST, port=PORT, log_level="info")

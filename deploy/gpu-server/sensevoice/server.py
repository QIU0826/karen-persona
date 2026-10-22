#!/usr/bin/env python3
"""SenseVoiceSmall ASR + emotion/audio-event HTTP service (GPU3)."""
from __future__ import annotations

import io
import os
import re
import time
from contextlib import asynccontextmanager
from pathlib import Path

import soundfile as sf
import torch
import uvicorn
from fastapi import FastAPI, HTTPException, Request, Response
from fastapi.responses import JSONResponse

MODEL_DIR = os.environ.get("SENSEVOICE_MODEL_DIR", "/workspace/models/SenseVoiceSmall")
HOST = os.environ.get("SENSEVOICE_HOST", "0.0.0.0")
PORT = int(os.environ.get("SENSEVOICE_PORT", "18112"))
MAX_AUDIO_BYTES = 8 * 1024 * 1024

_model = None
_loaded_at = 0.0

# SenseVoice rich text tags: <|zh|><|HAPPY|><|Speech|><|woitn|>你好
_TAG_RE = re.compile(r"<\|([^|]+)\|>")
_EMOTIONS = {"HAPPY", "SAD", "ANGRY", "NEUTRAL", "FEARFUL", "DISGUSTED", "SURPRISED"}
_EVENTS = {"Speech", "BGM", "Applause", "Laughter", "Crying", "Cough", "Sneeze", "Breath", "Music"}


def _parse(raw: str) -> tuple[str, str | None, list[str], str | None]:
    tags = _TAG_RE.findall(raw or "")
    text = _TAG_RE.sub("", raw or "").strip()
    emotion = next((t for t in tags if t.upper() in _EMOTIONS), None)
    events = [t for t in tags if t in _EVENTS]
    language = next((t for t in tags if t.lower() in {"zh", "en", "ja", "ko", "yue"}), None)
    return text, emotion, events, language


@asynccontextmanager
async def lifespan(app: FastAPI):
    global _model, _loaded_at
    from funasr import AutoModel

    if not os.path.isdir(MODEL_DIR):
        raise RuntimeError(f"model dir not found: {MODEL_DIR}")
    _model = AutoModel(
        model=MODEL_DIR,
        trust_remote_code=True,
        device="cuda:0" if torch.cuda.is_available() else "cpu",
        disable_update=True,
    )
    _loaded_at = time.time()
    print(f"[sensevoice] loaded model={MODEL_DIR} device={_model.kwargs.get('device')}", flush=True)
    yield


app = FastAPI(title="Karen SenseVoice", version="0.1.0", lifespan=lifespan)


@app.get("/health")
def health():
    return {
        "ok": _model is not None,
        "model": MODEL_DIR,
        "device": "cuda:0" if torch.cuda.is_available() else "cpu",
        "gpu": torch.cuda.get_device_name(0) if torch.cuda.is_available() else None,
        "loaded_at": _loaded_at,
    }


@app.post("/understand")
async def understand(request: Request) -> JSONResponse:
    if _model is None:
        raise HTTPException(status_code=503, detail="model not loaded")
    body = await request.body()
    if not body or len(body) > MAX_AUDIO_BYTES:
        raise HTTPException(status_code=400, detail="empty_or_too_large")
    if not (body[:4] == b"RIFF" and body[8:12] == b"WAVE"):
        raise HTTPException(status_code=415, detail="only_wav_supported")
    tmp = "/tmp/sensevoice-input.wav"
    with open(tmp, "wb") as f:
        f.write(body)
    started = time.time()
    try:
        result = _model.generate(
            input=tmp,
            cache={},
            language="auto",
            use_itn=True,
            batch_size_s=60,
            merge_vad=True,
            merge_length_s=15,
        )
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=500, detail=f"inference_failed: {type(exc).__name__}") from exc
    raw = ""
    if isinstance(result, list) and result:
        raw = str(result[0].get("text", ""))
    elif isinstance(result, dict):
        raw = str(result.get("text", ""))
    text, emotion, events, language = _parse(raw)
    return JSONResponse(
        {
            "text": text,
            "emotion": emotion.lower() if emotion else None,
            "events": events,
            "language": language,
            "duration_s": round(len(body) / 48000.0, 2),
            "elapsed_ms": int((time.time() - started) * 1000),
        }
    )


if __name__ == "__main__":
    uvicorn.run(app, host=HOST, port=PORT, log_level="info")

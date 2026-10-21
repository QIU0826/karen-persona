"""
Kokoro 中文神经 TTS 本机服务（v0.9.15）。

背景：她发语音用的是 macOS `say -v Tingting`，音色明显偏 AI（"像广播"）。
本服务用开源模型 Kokoro-82M（Apache-2.0）+ 内置中文少女音色（zf_xiaoxiao / zf_xiaobei / zf_xiaoyi）
生成 24kHz 语音，比系统 TTS 自然、音色更年轻。

接口（HTTP，默认 127.0.0.1:18086）：
  GET  /health                  → {ok, model, voices, device, sr}
  POST /synthesize              → body: {text, voice?, speed?}；返回 audio/wav 字节
  POST /synthesize?format=wav   → 同上（默认）
错误：400（空文本/超长/非法音色）、500（合成失败），JSON {error}

启动：
  services/kokoro/.venv/bin/python services/kokoro/server.py
  （或 npm run kokoro:start）

模型文件（本机，不入库）：
  services/kokoro/models/kokoro-v1_0.pth   （327MB，hexgrad/Kokoro-82M，Apache-2.0）
  services/kokoro/models/config.json
  services/kokoro/models/voices/*.pt       （每音色 ~520KB）
"""
from __future__ import annotations

import io
import os
import threading
import time
from pathlib import Path

from fastapi import FastAPI, HTTPException
from fastapi.responses import JSONResponse, Response
from pydantic import BaseModel

HOST = os.environ.get("KOKORO_HOST", "127.0.0.1")
PORT = int(os.environ.get("KOKORO_PORT", "18086"))
MODEL_DIR = Path(os.environ.get("KOKORO_MODEL_DIR", Path(__file__).parent / "models"))
DEFAULT_VOICE = os.environ.get("KOKORO_DEFAULT_VOICE", "zf_xiaoxiao")
MAX_CHARS = int(os.environ.get("KOKORO_MAX_CHARS", "160"))
# 只暴露经过可懂度验证的音色（zf_xiaoni 实测 ASR CER 53%，弃用）
ALLOWED_VOICES = {"zf_xiaoxiao", "zf_xiaobei", "zf_xiaoyi"}
SAMPLE_RATE = 24000

app = FastAPI(title="karen-kokoro-tts")
_pipeline = None
_lock = threading.Lock()
_loaded_at: float | None = None
_load_error: str | None = None


def _load():
    """懒加载模型（首次请求/启动时）。"""
    global _pipeline, _loaded_at, _load_error
    with _lock:
        if _pipeline is not None:
            return _pipeline
        try:
            import torch
            from kokoro import KPipeline, KModel

            kmodel = KModel(
                config=str(MODEL_DIR / "config.json"),
                model=str(MODEL_DIR / "kokoro-v1_0.pth"),
            ).eval()
            _pipeline = KPipeline(lang_code="z", model=kmodel)
            _loaded_at = time.time()
            return _pipeline
        except Exception as exc:  # noqa: BLE001 - 服务层需要报告加载失败
            _load_error = f"{type(exc).__name__}: {exc}"
            raise


class SynthRequest(BaseModel):
    text: str
    voice: str | None = None
    speed: float | None = None


@app.get("/health")
def health():
    loaded = _pipeline is not None
    return {
        "ok": loaded or _load_error is None,
        "loaded": loaded,
        "model": "hexgrad/Kokoro-82M (Apache-2.0)",
        "model_dir": str(MODEL_DIR),
        "voices": sorted(ALLOWED_VOICES),
        "default_voice": DEFAULT_VOICE,
        "sr": SAMPLE_RATE,
        "load_error": _load_error,
        "loaded_at": _loaded_at,
    }


@app.post("/synthesize")
def synthesize(req: SynthRequest):
    text = (req.text or "").strip()
    if not text:
        raise HTTPException(status_code=400, detail="empty_text")
    if len(text) > MAX_CHARS:
        raise HTTPException(status_code=400, detail="text_too_long")
    voice = (req.voice or DEFAULT_VOICE).strip() or DEFAULT_VOICE
    if voice not in ALLOWED_VOICES:
        raise HTTPException(status_code=400, detail="voice_not_allowed")
    speed = req.speed if req.speed is not None else 1.0
    speed = max(0.7, min(1.3, float(speed)))

    started = time.time()
    try:
        import torch
        import soundfile as sf
        from kokoro import KPipeline

        pipeline = _load()
        voice_tensor = torch.load(
            str(MODEL_DIR / "voices" / f"{voice}.pt"), weights_only=True
        )
        chunks = []
        with _lock:
            for _gs, _ps, audio in pipeline(text, voice=voice_tensor, speed=speed):
                chunks.append(audio)
        if not chunks:
            raise RuntimeError("no audio chunks")
        audio = torch.cat(chunks)
        buf = io.BytesIO()
        # 服务返回 16-bit PCM wav（下游 silk-wasm 编码要标准 WAV）
        import numpy as np

        sf.write(buf, audio.detach().cpu().numpy().astype("float32"), SAMPLE_RATE, format="WAV", subtype="PCM_16")
        data = buf.getvalue()
        return Response(
            content=data,
            media_type="audio/wav",
            headers={
                "x-kokoro-voice": voice,
                "x-kokoro-duration-ms": str(int(len(audio) / SAMPLE_RATE * 1000)),
                "x-kokoro-elapsed-ms": str(int((time.time() - started) * 1000)),
            },
        )
    except HTTPException:
        raise
    except Exception as exc:  # noqa: BLE001
        return JSONResponse(
            status_code=500,
            content={"error": "synthesis_failed", "detail": f"{type(exc).__name__}: {exc}"},
        )


if __name__ == "__main__":
    import uvicorn

    # 预热：启动即加载，避免第一条语音等 1s+
    try:
        _load()
        print(f"[kokoro] model loaded from {MODEL_DIR}")
    except Exception as exc:  # noqa: BLE001
        print(f"[kokoro] model load failed: {exc}")
    uvicorn.run(app, host=HOST, port=PORT, log_level="warning")

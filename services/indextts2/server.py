"""IndexTTS2 本地服务（v0.9.31）。

模型代码与权重放在仓库外（默认 `~/玩具/index-tts` + `checkpoints/`），这里只做
FastAPI 包装，避免把 10GB 权重 / 第三方推理代码塞进 karen 仓库。

启动：
    services/indextts2/run.sh
环境变量：
    INDEXTTS_REPO        克隆的 index-tts 目录（默认 ~/玩具/index-tts）
    INDEXTTS_MODEL_DIR   checkpoints 目录（默认 $INDEXTTS_REPO/checkpoints）
    INDEXTTS_REF_WAV     默认参考音（默认 karen-persona/data/voice-ref/xiaoya.wav）
    INDEXTTS_PORT        端口（默认 18088）
"""

from __future__ import annotations

import io
import os
import sys
import tempfile
import threading
import time
from pathlib import Path
from typing import Literal

import numpy as np
import soundfile as sf
import soxr
from fastapi import FastAPI, HTTPException
from fastapi.responses import Response
from pydantic import BaseModel, Field

REPO = Path(os.environ.get("INDEXTTS_REPO", str(Path.home() / "玩具" / "index-tts"))).expanduser()
MODEL_DIR = Path(os.environ.get("INDEXTTS_MODEL_DIR", str(REPO / "checkpoints"))).expanduser()
REF_WAV = Path(
    os.environ.get(
        "INDEXTTS_REF_WAV",
        str(Path(__file__).resolve().parents[2] / "data" / "voice-ref" / "xiaoya.wav"),
    )
).expanduser()
PORT = int(os.environ.get("INDEXTTS_PORT", "18088"))
OUTPUT_SR = 24_000
MAX_CHARS = 300

os.environ.setdefault("PYTORCH_ENABLE_MPS_FALLBACK", "1")
if str(REPO) not in sys.path:
    sys.path.insert(0, str(REPO))

app = FastAPI(title="karen-indextts2", version="0.1.0")
_model = None
_load_error: str | None = None
_loaded_at = 0.0
_lock = threading.Lock()


class SynthRequest(BaseModel):
    text: str
    ref_wav: str | None = None
    lang: Literal["ZH", "EN", "JA", "ES", "AR"] = "ZH"
    emo_vector: list[float] | None = None
    emo_alpha: float = Field(default=0.8, ge=0.0, le=1.0)
    duration_factor: float = Field(default=1.0, ge=0.5, le=2.0)
    use_random: bool = False


def _load():
    global _model, _load_error, _loaded_at
    if _model is not None:
        return _model
    try:
        from indextts.infer_v2_5 import IndexTTS2

        started = time.time()
        _model = IndexTTS2(
            cfg_path=str(MODEL_DIR / "config.yaml"),
            model_dir=str(MODEL_DIR),
            use_bf16=False,
        )
        _loaded_at = started
    except Exception as exc:  # noqa: BLE001
        _load_error = f"{type(exc).__name__}: {exc}"
        raise
    return _model


@app.get("/health")
def health() -> dict:
    return {
        "ok": _model is not None or _load_error is None,
        "loaded": _model is not None,
        "model": "IndexTeam/IndexTTS-2.5",
        "model_dir": str(MODEL_DIR),
        "repo": str(REPO),
        "device": getattr(_model, "device", None),
        "sample_rate": OUTPUT_SR,
        "ref_wav": str(REF_WAV),
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
    ref = Path(req.ref_wav).expanduser() if req.ref_wav else REF_WAV
    if not ref.is_file():
        raise HTTPException(status_code=400, detail="ref_audio_missing")
    emo = None
    if req.emo_vector is not None:
        if len(req.emo_vector) != 8:
            raise HTTPException(status_code=400, detail="emo_vector_must_be_8dims")
        emo = [max(0.0, min(1.0, float(v))) for v in req.emo_vector]
    try:
        model = _load()
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=503, detail=f"model_load_failed: {type(exc).__name__}") from exc

    started = time.time()
    with _lock:
        tmp_dir = tempfile.mkdtemp(prefix="karen-indextts2-")
        out_path = Path(tmp_dir) / "out.wav"
        try:
            model.infer(
                spk_audio_prompt=str(ref),
                text=text,
                lang=req.lang,
                output_path=str(out_path),
                emo_vector=emo,
                emo_alpha=req.emo_alpha,
                use_random=req.use_random,
                duration_factor=req.duration_factor,
                verbose=False,
            )
            audio, sr = sf.read(str(out_path), dtype="float32", always_2d=True)
        except Exception as exc:  # noqa: BLE001
            return Response(
                status_code=500,
                content=(
                    '{"error":"synthesis_failed","detail":"'
                    + type(exc).__name__.replace('"', "")
                    + '"}'
                ),
                media_type="application/json",
            )
        finally:
            try:
                out_path.unlink(missing_ok=True)
                Path(tmp_dir).rmdir()
            except OSError:
                pass

    mono = audio[:, 0]
    if sr != OUTPUT_SR:
        mono = soxr.resample(mono, sr, OUTPUT_SR)
    pcm = np.clip(mono, -1.0, 1.0)
    buffer = io.BytesIO()
    sf.write(buffer, pcm, OUTPUT_SR, format="WAV", subtype="PCM_16")
    data = buffer.getvalue()
    duration = len(pcm) / OUTPUT_SR
    elapsed = time.time() - started
    return Response(
        content=data,
        media_type="audio/wav",
        headers={
            "x-indextts-model": "IndexTTS-2.5",
            "x-indextts-duration-ms": str(int(duration * 1000)),
            "x-indextts-elapsed-ms": str(int(elapsed * 1000)),
            "x-indextts-rtf": f"{elapsed / max(duration, 1e-6):.2f}",
            "x-indextts-emotion": "1" if emo is not None else "0",
        },
    )


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host="127.0.0.1", port=PORT, log_level="info")

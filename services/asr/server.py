"""karen 本地语音识别服务（v0.23）。

用 faster-whisper（CTranslate2，CPU int8）在本机把语音转文字，通过 HTTP 给 Node 侧调用。
为什么不用云端：用户要求隐私优先、可离线；faster-whisper 的 small 模型中文可接受，
单条 3–10 秒语音在 M 系列 CPU 上约 0.3–1.5s。

目录约定（便于清理）：
- Python 环境：`services/asr/.venv/`
- 模型权重：`services/asr/models/faster-whisper-small/`（约 484MB，删目录即卸载）

启动：
    services/asr/.venv/bin/python services/asr/server.py
    # 或 npm run asr:start

环境变量：
    KAREN_ASR_PORT（默认 18085）
    KAREN_ASR_MODEL（默认 services/asr/models/faster-whisper-small）
"""

from __future__ import annotations

import io
import os
import time
from pathlib import Path

from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import JSONResponse

PORT = int(os.environ.get("KAREN_ASR_PORT", "18085"))
REPO_ROOT = Path(__file__).resolve().parents[2]
MODEL = os.environ.get("KAREN_ASR_MODEL") or str(
    REPO_ROOT / "services" / "asr" / "models" / "faster-whisper-small"
)
MAX_AUDIO_BYTES = 8 * 1024 * 1024

app = FastAPI(title="karen-local-asr", version="0.1.0")
_model = None
# whisper 对中文常输出繁体（天氣/吃飯），统一转简体再返回
_cc = None


def _to_simplified(text: str) -> str:
    global _cc
    if not text:
        return text
    try:
        if _cc is None:
            from opencc import OpenCC

            _cc = OpenCC("t2s")
        return _cc.convert(text)
    except Exception:  # pragma: no cover - 转换失败就原样返回
        return text


def _get_model():
    global _model
    if _model is not None:
        return _model
    try:
        from faster_whisper import WhisperModel
    except ImportError as err:  # pragma: no cover
        raise HTTPException(status_code=503, detail="缺少 faster-whisper") from err
    if not Path(MODEL).exists():
        raise HTTPException(status_code=503, detail=f"模型目录不存在: {MODEL}")
    # CPU int8：M 系列上足够快，且不占 MPS（留给她生图）
    _model = WhisperModel(MODEL, device="cpu", compute_type="int8")
    return _model


@app.get("/health")
def health() -> dict:
    return {
        "ok": True,
        "model": MODEL,
        "loaded": _model is not None,
    }


@app.post("/transcribe")
async def transcribe(request: Request) -> JSONResponse:
    body = await request.body()
    if not body:
        raise HTTPException(status_code=400, detail="empty_body")
    if len(body) > MAX_AUDIO_BYTES:
        raise HTTPException(status_code=413, detail="too_large")
    if not (body[:4] == b"RIFF" and body[8:12] == b"WAVE"):
        raise HTTPException(status_code=415, detail="only_wav_supported")

    started = time.time()
    try:
        from faster_whisper import decode_audio

        audio = decode_audio(io.BytesIO(body), sampling_rate=16000)
        model = _get_model()
        segments, info = model.transcribe(
            audio,
            language="zh",
            beam_size=1,
            vad_filter=True,
            condition_on_previous_text=False,
            # 提示用简体，减少繁体输出（再叠加 OpenCC t2s 兜底）
            initial_prompt="以下是普通话的句子，请用简体中文转写。",
        )
        text = "".join(segment.text for segment in segments).strip()
        text = _to_simplified(text)
    except HTTPException:
        raise
    except Exception as err:  # pragma: no cover
        raise HTTPException(status_code=503, detail=f"transcribe_failed: {type(err).__name__}") from err

    return JSONResponse(
        {
            "text": text,
            "language": getattr(info, "language", "zh"),
            "duration_s": round(float(getattr(info, "duration", 0.0)), 2),
            "elapsed_ms": int((time.time() - started) * 1000),
        }
    )


if __name__ == "__main__":  # pragma: no cover
    import uvicorn

    uvicorn.run(app, host="127.0.0.1", port=PORT, log_level="info")

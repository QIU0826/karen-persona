#!/usr/bin/env python3
"""Qwen2.5-Omni-7B audio understanding service (GPU3).

输入 WAV，输出 transcript/tone/emotion/singing/sarcasm/background 的 JSON。
仅用于“听懂语音”的辅助判断；sarcasm/singing 不确定时必须返回 uncertain。
"""
from __future__ import annotations

import json
import os
import re
import time
from contextlib import asynccontextmanager
from pathlib import Path

import soundfile as sf
import torch
import uvicorn
from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import JSONResponse

MODEL_DIR = os.environ.get("QWEN_OMNI_MODEL_DIR", "/workspace/models/Qwen2.5-Omni-7B")
HOST = os.environ.get("QWEN_OMNI_HOST", "0.0.0.0")
PORT = int(os.environ.get("QWEN_OMNI_PORT", "18113"))
MAX_AUDIO_BYTES = 8 * 1024 * 1024

_model = None
_processor = None
_loaded_at = 0.0

SYSTEM = (
    "You are Qwen, a virtual human developed by the Qwen Team, Alibaba Group, "
    "capable of perceiving auditory and visual inputs, as well as generating text and speech."
)

PROMPT = """听这段语音，只输出一个 JSON，不要 Markdown、不要解释：
{
  "transcript": "尽量准确的转写",
  "tone": "自然语言描述语气/情绪，如平静、开心、委屈、生气、撒娇、疲惫",
  "emotion": "happy|sad|angry|neutral|fearful|surprised|uncertain",
  "singing": "yes|no|uncertain",
  "sarcasm": "yes|no|uncertain",
  "background": "背景声/音乐/笑声等，没有就空字符串",
  "confidence": 0.0
}
判断要谨慎：不要只凭文字猜阴阳怪气；听不出来就填 uncertain。不要编造没听到的内容。"""


def _parse_json(raw: str) -> dict | None:
    text = (raw or "").strip()
    text = re.sub(r"^```(?:json)?", "", text, flags=re.I).strip()
    text = re.sub(r"```$", "", text).strip()
    start = text.find("{")
    end = text.rfind("}")
    if start < 0 or end <= start:
        return None
    try:
        obj = json.loads(text[start : end + 1])
        return obj if isinstance(obj, dict) else None
    except Exception:
        return None


def _str(v, maxlen=500) -> str:
    return str(v or "").strip()[:maxlen]


@asynccontextmanager
async def lifespan(app: FastAPI):
    global _model, _processor, _loaded_at
    from transformers import Qwen2_5OmniForConditionalGeneration, Qwen2_5OmniProcessor

    if not os.path.isdir(MODEL_DIR):
        raise RuntimeError(f"model dir not found: {MODEL_DIR}")
    _model = Qwen2_5OmniForConditionalGeneration.from_pretrained(
        MODEL_DIR,
        torch_dtype=torch.bfloat16,
        device_map="cuda:0",
        attn_implementation="sdpa",
    )
    _processor = Qwen2_5OmniProcessor.from_pretrained(MODEL_DIR)
    _model.eval()
    _loaded_at = time.time()
    print(f"[qwen-omni] loaded model={MODEL_DIR} device={_model.device}", flush=True)
    yield


app = FastAPI(title="Karen Qwen-Omni", version="0.1.0", lifespan=lifespan)


@app.get("/health")
def health():
    return {
        "ok": _model is not None,
        "model": MODEL_DIR,
        "device": str(_model.device) if _model is not None else None,
        "gpu": torch.cuda.get_device_name(0) if torch.cuda.is_available() else None,
        "loaded_at": _loaded_at,
    }


@app.post("/understand")
async def understand(request: Request) -> JSONResponse:
    if _model is None or _processor is None:
        raise HTTPException(status_code=503, detail="model not loaded")
    body = await request.body()
    if not body or len(body) > MAX_AUDIO_BYTES:
        raise HTTPException(status_code=400, detail="empty_or_too_large")
    if not (body[:4] == b"RIFF" and body[8:12] == b"WAVE"):
        raise HTTPException(status_code=415, detail="only_wav_supported")
    wav_path = "/tmp/qwen-omni-input.wav"
    with open(wav_path, "wb") as f:
        f.write(body)
    info = sf.info(wav_path)
    started = time.time()
    try:
        # 不依赖 qwen-omni-utils（它硬依赖 av）；只处理 WAV/单声道，自己读入 numpy。
        import librosa
        import numpy as np

        audio, sr = sf.read(wav_path, dtype="float32", always_2d=False)
        audio = np.asarray(audio, dtype=np.float32)
        if audio.ndim > 1:
            audio = audio.mean(axis=1)
        if sr != 16000:
            audio = librosa.resample(audio, orig_sr=sr, target_sr=16000)

        conversation = [
            {"role": "system", "content": [{"type": "text", "text": SYSTEM}]},
            {
                "role": "user",
                "content": [
                    {"type": "audio", "audio": wav_path},
                    {"type": "text", "text": PROMPT},
                ],
            },
        ]
        text = _processor.apply_chat_template(
            conversation, add_generation_prompt=True, tokenize=False
        )
        inputs = _processor(
            text=text,
            audio=[audio],
            return_tensors="pt",
            padding=True,
            use_audio_in_video=False,
        )
        inputs = inputs.to(_model.device).to(_model.dtype)
        with torch.inference_mode():
            text_ids = _model.generate(
                **inputs,
                use_audio_in_video=False,
                return_audio=False,
                max_new_tokens=320,
                do_sample=False,
            )
        raw = _processor.batch_decode(
            text_ids, skip_special_tokens=True, clean_up_tokenization_spaces=False
        )[0]
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=500, detail=f"inference_failed: {type(exc).__name__}") from exc

    parsed = _parse_json(raw) or {}
    transcript = _str(parsed.get("transcript"))
    return JSONResponse(
        {
            "transcript": transcript,
            "tone": _str(parsed.get("tone")),
            "emotion": _str(parsed.get("emotion"), 30) or "uncertain",
            "singing": _str(parsed.get("singing"), 20) or "uncertain",
            "sarcasm": _str(parsed.get("sarcasm"), 20) or "uncertain",
            "background": _str(parsed.get("background")),
            "confidence": parsed.get("confidence"),
            "raw": _str(raw, 1200),
            "duration_s": round(float(info.duration), 2),
            "elapsed_ms": int((time.time() - started) * 1000),
        }
    )


if __name__ == "__main__":
    uvicorn.run(app, host=HOST, port=PORT, log_level="info")

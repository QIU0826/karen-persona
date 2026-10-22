"""
Fun-CosyVoice 3.0 零样本克隆服务（v0.9.16，本机 CPU）。

背景与可信性评估见 docs/VOICE_CLONE.md。本服务只做两件事：
  1. 用 `data/voice-ref/` 里注册过的 3–10s 参考音做零样本克隆；
  2. 输出 24kHz PCM16 WAV，交给既有 silk-wasm 链路发 QQ 语音条。

接口（HTTP，默认 127.0.0.1:18087）：
  GET  /health                          → {ok, loaded, model, voices:[...], sample_rate}
  GET  /voices                          → 已注册参考音列表
  POST /synthesize {text, voice_id?, speed?} → audio/wav
错误：400（空文本/超长/未知 voice_id）、503（模型未加载完成）、500（合成失败）

启动：
  npm run cosyvoice:start
  （模型目录默认 ~/Library/Application Support/karen/models/Fun-CosyVoice3-0.5B）

参考音注册（不入库，data/ 是运行时目录）：
  data/voice-ref/<id>.wav + <id>.json（字段见 README / voice-ref:add 脚本）

上游代码为此做了 3 处 CPU 兼容补丁（见 docs/VOICE_CLONE.md §5）：
  - CosyVoiceModel.load 硬编码 device='cuda' → 改为 cuda 可用才 cuda
  - flow.py / hifigan 里 .cuda() 调用 → 仅 CUDA 可用时调用
  - load_wav 的 torchaudio.load → soundfile（torchaudio>=2.9 依赖 torchcodec）
  - matcha/utils/__init__.py 置空（避免训练期重依赖 wandb/gradio/rootutils）
"""
from __future__ import annotations

import hashlib
import json
import os
import sys
import threading
import time
from pathlib import Path

from fastapi import FastAPI, HTTPException
from fastapi.responses import JSONResponse, Response
from pydantic import BaseModel

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
sys.path.insert(0, str(HERE / "third_party" / "Matcha-TTS"))

HOST = os.environ.get("COSYVOICE_HOST", "127.0.0.1")
PORT = int(os.environ.get("COSYVOICE_PORT", "18087"))
MODEL_DIR = Path(
    os.environ.get(
        "COSYVOICE_MODEL_DIR",
        Path.home() / "Library" / "Application Support" / "karen" / "models" / "Fun-CosyVoice3-0.5B",
    )
)
VOICE_DIR = Path(os.environ.get("COSYVOICE_VOICE_DIR", HERE.parent.parent / "data" / "voice-ref"))
DEFAULT_VOICE = os.environ.get("COSYVOICE_VOICE_ID", "default")
MAX_CHARS = int(os.environ.get("COSYVOICE_MAX_CHARS", "120"))
MIN_REF_SECONDS = 3.0
MAX_REF_SECONDS = 10.0
SAMPLE_RATE = 24000

app = FastAPI(title="karen-cosyvoice-clone")
_model = None
_loaded_at: float | None = None
_load_error: str | None = None
_lock = threading.Lock()


def _load():
    global _model, _loaded_at, _load_error
    with _lock:
        if _model is not None:
            return _model
        try:
            from cosyvoice.cli.cosyvoice import CosyVoice3

            t0 = time.time()
            _model = CosyVoice3(str(MODEL_DIR), load_trt=False, load_vllm=False, fp16=False)
            _loaded_at = time.time()
            print(f"[cosyvoice] loaded in {time.time() - t0:.1f}s from {MODEL_DIR}", flush=True)
            return _model
        except Exception as exc:  # noqa: BLE001
            _load_error = f"{type(exc).__name__}: {exc}"
            raise


def list_voices() -> list[dict]:
    """扫描 data/voice-ref/：wav + 同名 json（ref_text/source/license）。"""
    voices: list[dict] = []
    if not VOICE_DIR.exists():
        return voices
    for wav in sorted(VOICE_DIR.glob("*.wav")):
        meta_path = wav.with_suffix(".json")
        meta: dict = {}
        if meta_path.exists():
            try:
                meta = json.loads(meta_path.read_text(encoding="utf-8"))
            except Exception:  # noqa: BLE001
                meta = {}
        voices.append(
            {
                "id": wav.stem,
                "path": str(wav),
                "ref_text": meta.get("ref_text", ""),
                "source": meta.get("source", ""),
                "license": meta.get("license", ""),
                "duration_s": meta.get("duration_s"),
                "sha256": meta.get("sha256") or _sha256(wav),
            }
        )
    return voices


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1 << 20), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _wav_duration(path: Path) -> float:
    import soundfile as sf

    info = sf.info(str(path))
    return info.frames / info.samplerate


MAX_RETRIES = int(os.environ.get("COSYVOICE_MAX_RETRIES", "3"))


def estimate_expected_seconds(text: str) -> float:
    """粗估合理时长：中文 ~4.5 字/秒，英文按 3 词/秒折算。用于识别复读/拖长。"""
    cjk = sum(1 for ch in text if "\u4e00" <= ch <= "\u9fff")
    other = max(0, len(text) - cjk)
    return max(0.8, cjk / 4.5 + other / 12.0)


def is_duration_plausible(duration: float, expected: float) -> bool:
    """合理区间：0.55x–1.8x + 1s 余量（含句间停顿）；绝对上限 25s 防复读。"""
    if duration <= 0.3 or duration > 25.0:
        return False
    return (expected * 0.55 - 0.5) <= duration <= (expected * 1.8 + 1.0)


ASR_URL = os.environ.get("COSYVOICE_ASR_URL", "http://127.0.0.1:18085")
ASR_VERIFY = os.environ.get("COSYVOICE_VERIFY_ASR", "on").strip().lower() != "off"
ASR_CER_LIMIT = float(os.environ.get("COSYVOICE_ASR_CER_LIMIT", "0.25"))


def _strip_punct(text: str) -> str:
    return "".join(ch for ch in text if ch.strip() and ch not in "，。！？、；：,.!?;:…—~～“”\"'（）() ")


def _cer(expected: str, got: str) -> float:
    """字符错误率（Levenshtein / len(expected)）。"""
    a, b = _strip_punct(expected), _strip_punct(got)
    if not a:
        return 1.0
    prev = list(range(len(b) + 1))
    for i, ca in enumerate(a, 1):
        cur = [i] + [0] * len(b)
        for j, cb in enumerate(b, 1):
            cur[j] = min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (ca != cb))
        prev = cur
    return prev[-1] / len(a)


def _verify_with_asr(wav_bytes: bytes, expected_text: str) -> tuple[bool, str]:
    """把合成音频送本机 ASR 复核，抓复读/吞字。ASR 不可用时跳过（返回 True）。"""
    if not ASR_VERIFY:
        return True, "asr_verify_disabled"
    try:
        import urllib.request

        request = urllib.request.Request(
            f"{ASR_URL}/transcribe",
            data=wav_bytes,
            headers={"Content-Type": "audio/wav"},
            method="POST",
        )
        with urllib.request.urlopen(request, timeout=8) as response:
            payload = json.loads(response.read().decode("utf-8"))
        transcript = str(payload.get("text") or "")
        if not transcript:
            return False, "asr_empty"
        cer = _cer(expected_text, transcript)
        if cer > ASR_CER_LIMIT:
            return False, f"asr_cer_{cer:.2f}"
        return True, f"asr_cer_{cer:.2f}"
    except Exception as exc:  # noqa: BLE001
        return True, f"asr_unavailable_{type(exc).__name__}"


class SynthRequest(BaseModel):
    text: str
    voice_id: str | None = None
    speed: float | None = None
    seed: int | None = None
    # v0.9.29：自然语言控制（情绪/语气），走 inference_instruct2 + 同一条参考音
    instruct: str | None = None


@app.get("/health")
def health():
    return {
        "ok": _model is not None or _load_error is None,
        "loaded": _model is not None,
        "model": "FunAudioLLM/Fun-CosyVoice3-0.5B-2512 (Apache-2.0)",
        "model_dir": str(MODEL_DIR),
        "device": "cpu",
        "sample_rate": SAMPLE_RATE,
        "voices": [v["id"] for v in list_voices()],
        "default_voice": DEFAULT_VOICE if any(v["id"] == DEFAULT_VOICE for v in list_voices()) else next(iter([v["id"] for v in list_voices()]), None),
        "load_error": _load_error,
        "loaded_at": _loaded_at,
    }


@app.get("/voices")
def voices():
    return {"voices": list_voices(), "voice_dir": str(VOICE_DIR)}


@app.post("/synthesize")
def synthesize(req: SynthRequest):
    text = (req.text or "").strip()
    if not text:
        raise HTTPException(status_code=400, detail="empty_text")
    if len(text) > MAX_CHARS:
        raise HTTPException(status_code=400, detail="text_too_long")
    registry = {v["id"]: v for v in list_voices()}
    voice_id = (req.voice_id or "").strip()
    if not voice_id:
        # 没有显式指定：优先默认音色，否则用第一个已注册参考音
        voice_id = DEFAULT_VOICE if DEFAULT_VOICE in registry else (next(iter(registry), ""))
    if not voice_id or voice_id not in registry:
        raise HTTPException(status_code=400, detail="voice_not_registered")
    voice = registry[voice_id]
    ref_text = (voice.get("ref_text") or "").strip()
    if not ref_text:
        raise HTTPException(status_code=400, detail="ref_text_missing")
    ref_path = Path(str(voice["path"]))
    if not ref_path.exists():
        raise HTTPException(status_code=400, detail="ref_audio_missing")
    speed = max(0.8, min(1.2, float(req.speed if req.speed is not None else 1.0)))
    seed = int(req.seed) if req.seed is not None else int(os.environ.get("COSYVOICE_SEED", "42"))
    instruct = (req.instruct or "").strip()
    if len(instruct) > 200:
        raise HTTPException(status_code=400, detail="instruct_too_long")
    if instruct and "<|endofprompt|>" not in instruct:
        instruct = instruct + "<|endofprompt|>"

    started = time.time()
    import io

    import soundfile as sf
    import torch

    from cosyvoice.utils.common import set_all_random_seed

    model = _load()
    expected_s = estimate_expected_seconds(text)
    attempts: list[tuple[int, float, bytes]] = []
    last_error = ""
    try:
        for attempt in range(MAX_RETRIES):
            attempt_seed = seed + attempt
            try:
                with _lock:
                    set_all_random_seed(attempt_seed)
                    chunks = []
                    if instruct:
                        # v0.9.29：情绪/语气控制；仍用同一条参考音保音色。
                        stream = model.inference_instruct2(
                            text, instruct, str(ref_path), stream=False, speed=speed
                        )
                    else:
                        stream = model.inference_zero_shot(
                            text, ref_text, str(ref_path), stream=False, speed=speed
                        )
                    for out in stream:
                        chunks.append(out["tts_speech"])
                    if not chunks:
                        raise RuntimeError("no audio chunks")
                    speech = torch.cat(chunks, dim=1)
                duration = speech.shape[1] / SAMPLE_RATE
                buffer = io.BytesIO()
                sf.write(
                    buffer,
                    speech.squeeze(0).cpu().numpy(),
                    SAMPLE_RATE,
                    format="WAV",
                    subtype="PCM_16",
                )
                data = buffer.getvalue()
                attempts.append((attempt_seed, duration, data))
                duration_ok = is_duration_plausible(duration, expected_s)
                asr_ok, asr_reason = (False, "skipped") if not duration_ok else _verify_with_asr(data, text)
                if duration_ok and asr_ok:
                    return Response(
                        content=data,
                        media_type="audio/wav",
                        headers={
                            "x-cosyvoice-voice": voice_id,
                            "x-cosyvoice-duration-ms": str(int(duration * 1000)),
                            "x-cosyvoice-elapsed-ms": str(int((time.time() - started) * 1000)),
                            "x-cosyvoice-rtf": f"{(time.time() - started) / max(duration, 1e-6):.2f}",
                            "x-cosyvoice-seed": str(attempt_seed),
                            "x-cosyvoice-attempts": str(attempt + 1),
                            "x-cosyvoice-verify": asr_reason,
                            "x-cosyvoice-instruct": "1" if instruct else "0",
                        },
                    )
                last_error = (
                    f"duration_{duration:.2f}s_expected_{expected_s:.2f}s"
                    if not duration_ok
                    else f"asr_mismatch_{asr_reason}"
                )
            except Exception as exc:  # noqa: BLE001
                last_error = f"{type(exc).__name__}: {exc}"
                continue
        # 所有重试都不合理：返回 500，让 Node 侧回退到 Kokoro/say
        return JSONResponse(
            status_code=500,
            content={
                "error": "unstable_output",
                "detail": last_error,
                "attempts": [{"seed": a[0], "duration_s": round(a[1], 2)} for a in attempts],
            },
        )
    except HTTPException:
        raise
    except Exception as exc:  # noqa: BLE001
        return JSONResponse(
            status_code=500,
            content={"error": "synthesis_failed", "detail": f"{type(exc).__name__}: {exc}"},
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

    try:
        _load()
    except Exception as exc:  # noqa: BLE001
        print(f"[cosyvoice] preload failed: {exc}", flush=True)
    uvicorn.run(app, host=HOST, port=PORT, log_level="warning")

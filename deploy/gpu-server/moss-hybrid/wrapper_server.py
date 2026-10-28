#!/usr/bin/env python3
"""MOSS v2 → Qwen-Image-Edit 修脸「混合自拍」服务端 wrapper（task-29，shadow）。

流程（单并发）：
  1) 用 GPU6 18116 的 MOSS v2（merged c1250 identity LoRA）按自拍 prompt 生成 base 图；
  2) base 图落盘到临时目录（服务器本地路径，Qwen /edit 能直接读）；
  3) 调 GPU2 18110 Qwen-Image-Edit：image_paths=[base, character-2, (可选)缓存自拍]，
     prompt 只修脸/五官，要求保持构图/场景/服装/发型/水彩画风；
  4) 返回 PNG（响应头带总耗时 / 两段耗时 / 尺寸），临时 base 图 finally 清理。

对外端口 18118（Mac 隧道 19118）。兼容现有 MOSS edit 客户端协议：
  POST /edit {prompt,image_paths?,width,height,steps,seed}  → 用 prompt 生成 MOSS base，
              image_paths 里真实存在的服务器路径会作为 Qwen 的额外参考图。
  POST /selfie {prompt,...}                                 → 同上（语义更清晰）。
  GET  /health

注意：这是 shadow 实验服务，不切生产；默认自拍仍走 Qwen-Image-Edit。
"""
from __future__ import annotations

import json
import os
import re
import threading
import time
import urllib.error
import urllib.request
import uuid
from pathlib import Path

import uvicorn
from fastapi import FastAPI, HTTPException, Response
from pydantic import BaseModel, Field

MOSS_URL = os.environ.get("HYBRID_MOSS_URL", "http://127.0.0.1:18116").rstrip("/")
QWEN_URL = os.environ.get("HYBRID_QWEN_URL", "http://127.0.0.1:18110").rstrip("/")
HOST = os.environ.get("HYBRID_HOST", "127.0.0.1")
PORT = int(os.environ.get("HYBRID_PORT", "18118"))
REF_MAIN = os.environ.get(
    "HYBRID_REF_MAIN", "/workspace/data/karen-ref-promo/character-2.jpg"
)
# 可选第二参考图（默认关闭：3 张参考会让 Qwen 改变输出画幅，破坏「保持构图」目标）
REF_EXTRA = os.environ.get("HYBRID_REF_EXTRA", "").strip()
TMP_DIR = Path(os.environ.get("HYBRID_TMP_DIR", "/workspace/data/tmp/hybrid-wrapper"))
MOSS_STEPS = int(os.environ.get("HYBRID_MOSS_STEPS", "50"))
FIX_STEPS = int(os.environ.get("HYBRID_FIX_STEPS", "15"))
TIMEOUT_MOSS = float(os.environ.get("HYBRID_TIMEOUT_MOSS", "300"))
TIMEOUT_QWEN = float(os.environ.get("HYBRID_TIMEOUT_QWEN", "300"))
TMP_TTL_SECONDS = int(os.environ.get("HYBRID_TMP_TTL_SECONDS", "3600"))

IDENTITY = (
    "karen_style, a 24-year-old Chinese woman with shoulder-length medium-blue bob hair (#4a6fa5), "
    "gray-blue eyes, pale skin"
)
STYLE = (
    "soft pencil and watercolor illustration style, low-saturation cool gray-blue palette, "
    "fine pencil and ink linework with light watercolor wash, subtle paper texture, "
    "clean background with a clear scene atmosphere, single person, no text, no watermark, no border"
)
SELFIE_SUFFIX = "close-up selfie, head and shoulders, facing the camera, no hands"
SCENES = [
    (("雨", "rain", "rainy"), "by the window on a rainy day, raindrops on the glass", "wearing an oatmeal knit cardigan", "cool diffused light on a rainy day"),
    (("海边", "sea", "ocean", "沙滩"), "the seaside at dusk, an orange sky over calm water", "wearing a light linen dress", "warm orange sunset side light"),
    (("公园", "花", "春天", "park"), "a park bench in early spring, budding trees and fresh green grass", "wearing a beige trench coat", "dappled light through leaves"),
    (("夜", "街", "霓虹", "night", "street"), "a city street at night, neon signs and wet pavement reflecting the lights", "wearing a long black coat", "mixed cool neon light and warm sign light"),
    (("家", "沙发", "卧室", "home", "sofa"), "a cozy living-room sofa at home", "wearing a dark gray knit long-sleeve top", "soft warm indoor lamp light"),
    (("咖啡", "店", "吧台", "cafe", "coffee"), "sitting by a window seat in a cafe, a coffee cup on the table", "wearing a light denim jacket", "warm afternoon light"),
]
FIX_PROMPT = (
    "把图1中人物的脸和五官修正为与图2（参考立绘）完全相同的人：保持图1的构图、场景、服装、发型、"
    "水彩画风、光线、画幅完全不变，只调整脸型、眼睛、鼻子、嘴和肤色；不要改变姿势、背景、文字、装饰；"
    "不要裁切、不要重绘身体。"
)

_lock = threading.Lock()
_started_at = time.time()


class HybridRequest(BaseModel):
    prompt: str = Field(..., min_length=1, max_length=4000)
    width: int = 832
    height: int = 1216
    steps: int = MOSS_STEPS
    seed: int = 0
    fix_steps: int | None = None
    reference_images: list[str] = Field(default_factory=list)


class EditCompatRequest(BaseModel):
    prompt: str = Field(..., min_length=1, max_length=4000)
    image_paths: list[str] = Field(default_factory=list)
    width: int = 832
    height: int = 1216
    steps: int = MOSS_STEPS
    seed: int = 0
    simple: bool = False


app = FastAPI(title="Karen Hybrid Selfie", version="0.1.0")


def _keyword_hit(text: str, keyword: str) -> bool:
    """中文子串匹配；英文按整词匹配（避免 "window seat" 命中 "sea"）。"""
    if keyword.isascii():
        return re.search(rf"\b{re.escape(keyword)}\b", text, flags=re.IGNORECASE) is not None
    return keyword in text


def _moss_prompt(user_prompt: str) -> str:
    text = (user_prompt or "").strip()
    for keywords, scene_en, outfit, light in SCENES:
        if any(_keyword_hit(text, keyword) for keyword in keywords):
            return f"{IDENTITY}, {scene_en}, {outfit}, {light}, {SELFIE_SUFFIX}, {STYLE}"
    return f"{IDENTITY}, {text}, {SELFIE_SUFFIX}, {STYLE}"


def _http_post_json(url: str, payload: dict, timeout: float) -> tuple[int, bytes]:
    body = json.dumps(payload).encode("utf-8")
    request = urllib.request.Request(
        url, data=body, headers={"Content-Type": "application/json"}, method="POST"
    )
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            return response.status, response.read()
    except urllib.error.HTTPError as exc:
        return exc.code, exc.read()[:500]
    except Exception as exc:  # noqa: BLE001
        return -1, f"{type(exc).__name__}: {exc}".encode("utf-8")[:500]


def _call_qwen_with_retry(payload: dict) -> tuple[int, bytes, int]:
    attempts = 0
    started = time.time()
    for backoff in (0, 10, 30, 60):
        if backoff:
            time.sleep(backoff)
        attempts += 1
        status, body = _http_post_json(f"{QWEN_URL}/edit", payload, TIMEOUT_QWEN)
        if status == 200 and body[:8] == b"\x89PNG\r\n\x1a\n":
            return status, body, attempts
        print(f"[hybrid] qwen attempt={attempts} status={status}", flush=True)
    return status, body, attempts


def _cleanup_tmp() -> None:
    TMP_DIR.mkdir(parents=True, exist_ok=True)
    cutoff = time.time() - TMP_TTL_SECONDS
    for path in TMP_DIR.glob("*.png"):
        try:
            if path.stat().st_mtime < cutoff:
                path.unlink()
        except OSError:
            pass


def _exists(path: str) -> bool:
    return bool(path) and Path(path).is_file()


def _health_probe(url: str) -> dict:
    started = time.time()
    try:
        with urllib.request.urlopen(f"{url}/health", timeout=3) as response:
            payload = json.loads(response.read().decode("utf-8"))
        return {"up": True, "latency_ms": int((time.time() - started) * 1000), "loaded": payload.get("loaded", True)}
    except Exception as exc:  # noqa: BLE001
        return {"up": False, "latency_ms": int((time.time() - started) * 1000), "error": type(exc).__name__}


@app.get("/health")
def health():
    moss = _health_probe(MOSS_URL)
    qwen = _health_probe(QWEN_URL)
    refs = [path for path in (REF_MAIN, REF_EXTRA) if _exists(path)]
    return {
        "ok": bool(moss["up"] and qwen["up"] and _exists(REF_MAIN)),
        "loaded": bool(moss["up"] and qwen["up"]),
        "service": "moss-hybrid",
        "moss": moss,
        "qwen": qwen,
        "refs": refs,
        "busy": _lock.locked(),
        "defaults": {"moss_steps": MOSS_STEPS, "fix_steps": FIX_STEPS, "width": 832, "height": 1216},
        "uptime_s": int(time.time() - _started_at),
    }


def _run_hybrid(prompt: str, width: int, height: int, seed: int, fix_steps: int, extra_refs: list[str]) -> Response:
    if not _exists(REF_MAIN):
        raise HTTPException(status_code=500, detail=f"missing main reference: {REF_MAIN}")
    if not _lock.acquire(blocking=False):
        raise HTTPException(status_code=503, detail="hybrid busy (single concurrency); retry later")
    base_path: Path | None = None
    try:
        _cleanup_tmp()
        total_started = time.time()
        seed = int(seed) or int(time.time()) % 2_000_000_000

        moss_started = time.time()
        moss_status, moss_body = _http_post_json(
            f"{MOSS_URL}/generate",
            {
                "prompt": _moss_prompt(prompt),
                "width": int(width),
                "height": int(height),
                "steps": MOSS_STEPS,
                "seed": seed,
            },
            TIMEOUT_MOSS,
        )
        moss_ms = int((time.time() - moss_started) * 1000)
        if moss_status != 200 or moss_body[:8] != b"\x89PNG\r\n\x1a\n":
            raise HTTPException(status_code=502, detail=f"moss failed status={moss_status}")

        base_path = TMP_DIR / f"base-{uuid.uuid4().hex}.png"
        base_path.write_bytes(moss_body)

        refs = [str(base_path), REF_MAIN] + ([REF_EXTRA] if _exists(REF_EXTRA) else [])
        for item in extra_refs:
            if _exists(item) and item not in refs:
                refs.append(item)
        fix_count = max(8, min(30, int(fix_steps)))
        qwen_started = time.time()
        qwen_status, qwen_body, attempts = _call_qwen_with_retry(
            {
                "prompt": FIX_PROMPT,
                "image_paths": refs,
                "simple": False,
                "num_inference_steps": fix_count,
                "seed": seed + 1,
            }
        )
        qwen_ms = int((time.time() - qwen_started) * 1000)
        if qwen_status != 200 or qwen_body[:8] != b"\x89PNG\r\n\x1a\n":
            raise HTTPException(status_code=502, detail=f"qwen failed status={qwen_status} attempts={attempts}")

        total_ms = int((time.time() - total_started) * 1000)
        width_px = int.from_bytes(qwen_body[16:20], "big") if len(qwen_body) > 24 else 0
        height_px = int.from_bytes(qwen_body[20:24], "big") if len(qwen_body) > 24 else 0
        print(
            f"[hybrid] ok prompt_len={len(prompt)} moss_ms={moss_ms} qwen_ms={qwen_ms} "
            f"total_ms={total_ms} qwen_attempts={attempts} base_bytes={len(moss_body)}",
            flush=True,
        )
        return Response(
            content=qwen_body,
            media_type="image/png",
            headers={
                "X-Backend": "moss-hybrid",
                "X-Total-Ms": str(total_ms),
                "X-Moss-Ms": str(moss_ms),
                "X-Fix-Ms": str(qwen_ms),
                "X-Qwen-Attempts": str(attempts),
                "X-Image-Width": str(width_px),
                "X-Image-Height": str(height_px),
            },
        )
    finally:
        if base_path is not None:
            try:
                base_path.unlink(missing_ok=True)
            except OSError:
                pass
        _lock.release()


@app.post("/selfie")
def selfie(req: HybridRequest):
    return _run_hybrid(
        req.prompt, req.width, req.height, req.seed, FIX_STEPS if req.fix_steps is None else req.fix_steps,
        req.reference_images,
    )


@app.post("/edit")
def edit_compat(req: EditCompatRequest):
    # 兼容现有 moss-edit 客户端：image_paths 里的服务器本地路径作为 Qwen 额外参考图
    return _run_hybrid(
        req.prompt, req.width, req.height, req.seed, req.steps or FIX_STEPS, req.image_paths
    )


if __name__ == "__main__":
    print(f"[hybrid] starting wrapper port={PORT} moss={MOSS_URL} qwen={QWEN_URL}", flush=True)
    uvicorn.run(app, host=HOST, port=PORT, log_level=os.environ.get("HYBRID_LOG_LEVEL", "info"))

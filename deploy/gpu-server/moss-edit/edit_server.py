#!/usr/bin/env python3
"""MOSS-Image-Edit → /edit HTTP 封装（兼容现有 selfie-generator 的 moss-edit 分支）。

背景：
- 直接跑 ComfyUI 的 API 需要「提交 workflow → 轮询 history → 取 output」三步，且参考图要先放进
  ComfyUI/input；Node 侧只需要「prompt/image_paths/steps/seed → PNG」。
- 本文件是一个薄代理：把请求 patch 进 ComfyUI 官方 MOSS-Image Edit workflow（由
  `fetch_workflow.sh` 从 Chenkin-x/ComfyUI-Moss-Image-Edit 固定 commit 拉到服务器），
  提交 `/prompt`，轮询 `/history`，取图返回 PNG。

只读/边界：
- 不包含、也不复制 GPLv3 插件代码；插件只安装在服务器 `comfyui/custom_nodes/` 下。
- 不写数据库、不落业务数据；输出图在 ComfyUI output 目录（data0），按请求前缀隔离。

环境变量：
  COMFY_URL                 默认 http://127.0.0.1:18118
  MOSS_EDIT_WORKFLOW        默认 /workspace/moss-edit/workflows/moss_edit_single_reference.api.json
  COMFY_INPUT_DIR           默认 /workspace/comfyui/input
  COMFY_OUTPUT_DIR          默认 /workspace/comfyui/output
  MOSS_EDIT_HOST/PORT       默认 0.0.0.0 / 18117
  MOSS_EDIT_UNET            默认 moss_image_sft_int8_convrot.safetensors
  MOSS_EDIT_CLIP            默认 qwen3.5_9b_int8_convrot.safetensors
  MOSS_EDIT_VAE             默认 flux2-vae_small.safetensors
  MOSS_EDIT_LORA            默认 moss_image_edit_lora_rank_64_bf16.safetensors
  MOSS_EDIT_STEPS           默认 30（请求显式 steps 优先）
  MOSS_EDIT_CFG             默认 4.0
  MOSS_EDIT_REF_MAX_EDGE    默认 512（发布者推荐起点）
  MOSS_EDIT_TIMEOUT_S       默认 900（首次含模型加载）
  MOSS_EDIT_POLL_MS         默认 700
"""
from __future__ import annotations

import asyncio
import hashlib
import io
import json
import os
import shutil
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
from pathlib import Path
from typing import Any

from fastapi import FastAPI, HTTPException, Response
from pydantic import BaseModel, Field
import uvicorn

COMFY_URL = os.environ.get("COMFY_URL", "http://127.0.0.1:18118").rstrip("/")
WORKFLOW_PATH = Path(
    os.environ.get(
        "MOSS_EDIT_WORKFLOW",
        "/workspace/moss-edit/workflows/moss_edit_native.api.json",
    )
)
COMFY_INPUT_DIR = Path(os.environ.get("COMFY_INPUT_DIR", "/workspace/comfyui/input"))
COMFY_OUTPUT_DIR = Path(os.environ.get("COMFY_OUTPUT_DIR", "/workspace/comfyui/output"))
HOST = os.environ.get("MOSS_EDIT_HOST", "0.0.0.0")
PORT = int(os.environ.get("MOSS_EDIT_PORT", "18117"))

MODEL_NAMES = {
    "UNETLoader": os.environ.get("MOSS_EDIT_UNET", "moss_image_sft_int8_convrot.safetensors"),
    "CLIPLoader": os.environ.get("MOSS_EDIT_CLIP", "qwen3.5_9b_int8_convrot.safetensors"),
    "VAELoader": os.environ.get("MOSS_EDIT_VAE", "flux2-vae_small.safetensors"),
    "LoraLoaderModelOnly": os.environ.get("MOSS_EDIT_LORA", "moss_image_edit_lora_rank_64_bf16.safetensors"),
}
DEFAULT_REF_MEGAPIXELS = float(os.environ.get("MOSS_EDIT_REF_MEGAPIXELS", "0.25"))
DEFAULT_OUT_WIDTH = int(os.environ.get("MOSS_EDIT_WIDTH", "832"))
DEFAULT_OUT_HEIGHT = int(os.environ.get("MOSS_EDIT_HEIGHT", "1216"))
DEFAULT_STEPS = int(os.environ.get("MOSS_EDIT_STEPS", "30"))
DEFAULT_CFG = float(os.environ.get("MOSS_EDIT_CFG", "4.0"))
DEFAULT_REF_MAX_EDGE = int(os.environ.get("MOSS_EDIT_REF_MAX_EDGE", "512"))
DEFAULT_MEGAPIXELS = float(os.environ.get("MOSS_EDIT_MEGAPIXELS", "1.0"))
# 显存不足时把文本编码器放 CPU：MOSS_EDIT_CLIP_DEVICE=cpu（默认 default=GPU）
CLIP_DEVICE = os.environ.get("MOSS_EDIT_CLIP_DEVICE", "default")
TIMEOUT_S = int(os.environ.get("MOSS_EDIT_TIMEOUT_S", "900"))
POLL_S = max(0.2, int(os.environ.get("MOSS_EDIT_POLL_MS", "700")) / 1000.0)

REQUIRED_NODES = (
    "UNETLoader",
    "CLIPLoader",
    "VAELoader",
    "LoraLoaderModelOnly",
    "TextEncodeMOSSImageEdit",
    "EmptyFlux2LatentImage",
    "KSampler",
)

_lock = asyncio.Lock()
_workflow: dict[str, Any] | None = None
_workflow_error: str | None = None


# ── 标准库 HTTP（容器里不额外依赖 httpx/requests）────────────────


def _http_json(url: str, payload: Any | None = None, timeout: float = 15.0) -> Any:
    data = None if payload is None else json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(
        url,
        data=data,
        headers={"Content-Type": "application/json"} if data is not None else {},
        method="POST" if data is not None else "GET",
    )
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        body = resp.read()
    return json.loads(body.decode("utf-8")) if body else None


def _http_bytes(url: str, timeout: float = 120.0) -> bytes:
    req = urllib.request.Request(url, headers={"Accept": "image/png"})
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return resp.read()


def _comfy_reachable() -> bool:
    try:
        _http_json(f"{COMFY_URL}/system_stats", timeout=3.0)
        return True
    except Exception:  # noqa: BLE001
        return False


def _comfy_node_ready() -> bool:
    try:
        lora = _http_json(f"{COMFY_URL}/object_info/LoraLoaderModelOnly", timeout=4.0)
        edit = _http_json(f"{COMFY_URL}/object_info/TextEncodeMOSSImageEdit", timeout=4.0)
        return bool(lora) and bool(edit)
    except Exception:  # noqa: BLE001
        return False


# ── workflow 加载与 patch ────────────────────────────────────────


def load_workflow() -> dict[str, Any]:
    global _workflow, _workflow_error
    if _workflow is not None:
        return _workflow
    try:
        raw = json.loads(WORKFLOW_PATH.read_text(encoding="utf-8"))
    except Exception as exc:  # noqa: BLE001
        _workflow_error = f"workflow 读取失败: {exc}"
        raise RuntimeError(_workflow_error) from exc
    classes = {node.get("class_type") for node in raw.values() if isinstance(node, dict)}
    missing = [name for name in REQUIRED_NODES if name not in classes]
    if missing:
        _workflow_error = f"workflow 缺少节点类型: {missing}（插件未安装/ComfyUI 过旧？）"
        raise RuntimeError(_workflow_error)
    _workflow = raw
    _workflow_error = None
    return raw


def _find_node(wf: dict[str, Any], class_type: str) -> tuple[str, dict[str, Any]]:
    for node_id, node in wf.items():
        if isinstance(node, dict) and node.get("class_type") == class_type:
            return node_id, node
    raise RuntimeError(f"workflow 中找不到 {class_type}")


def _link_target(wf: dict[str, Any], link: Any) -> tuple[str, int] | None:
    if isinstance(link, list) and len(link) >= 2 and isinstance(link[0], str):
        return link[0], int(link[1])
    return None


def prepare_reference(image_paths: list[str]) -> str:
    """把参考图复制进 ComfyUI/input（LoadImage 只能读 input 目录），返回文件名。"""
    if not image_paths:
        raise HTTPException(status_code=400, detail="image_paths 不能为空")
    raw = Path(image_paths[0])
    candidates = [raw] if raw.is_absolute() else [Path("/workspace") / raw, Path("/workspace/comfyui") / raw]
    src = next((p for p in candidates if p.is_file()), None)
    if src is None:
        raise HTTPException(status_code=400, detail=f"参考图不存在: {image_paths[0]}")
    ext = src.suffix.lower()
    if ext not in {".png", ".jpg", ".jpeg", ".webp"}:
        raise HTTPException(status_code=400, detail=f"不支持的参考图格式: {ext}")
    digest = hashlib.sha1(str(src.resolve()).encode("utf-8")).hexdigest()[:10]
    name = f"moss_edit_{digest}{ext}"
    COMFY_INPUT_DIR.mkdir(parents=True, exist_ok=True)
    dest = COMFY_INPUT_DIR / name
    if not dest.exists() or dest.stat().st_mtime < src.stat().st_mtime:
        shutil.copyfile(src, dest)
    return name


def patch_workflow(
    wf: dict[str, Any],
    *,
    prompt: str,
    negative: str,
    image_name: str,
    steps: int,
    seed: int,
    cfg: float,
    reference_max_edge: int,
    megapixels: float,
    width: int = DEFAULT_OUT_WIDTH,
    height: int = DEFAULT_OUT_HEIGHT,
) -> dict[str, Any]:
    out = json.loads(json.dumps(wf))  # deep copy

    load_id, load_node = _find_node(out, "LoadImage")
    load_node.setdefault("inputs", {})["image"] = image_name

    for class_type, value in MODEL_NAMES.items():
        _, node = _find_node(out, class_type)
        inputs = node.setdefault("inputs", {})
        if class_type == "UNETLoader":
            inputs["unet_name"] = value
        elif class_type == "CLIPLoader":
            inputs["clip_name"] = value
            inputs["device"] = CLIP_DEVICE
        elif class_type == "VAELoader":
            inputs["vae_name"] = value
        elif class_type == "LoraLoaderModelOnly":
            inputs["lora_name"] = value

    ks_id, ks = _find_node(out, "KSampler")
    ks.setdefault("inputs", {})["steps"] = max(10, min(60, int(steps)))
    ks["inputs"]["seed"] = int(seed)
    ks["inputs"]["cfg"] = float(cfg)

    # 原生 MOSS edit：两个 TextEncodeMOSSImageEdit（positive 有 prompt，negative 为空）
    edit_nodes = [node for node in out.values() if isinstance(node, dict) and node.get("class_type") == "TextEncodeMOSSImageEdit"]
    if len(edit_nodes) < 2:
        raise RuntimeError("native workflow 需要两个 TextEncodeMOSSImageEdit（正/负）")
    edit_nodes.sort(key=lambda node: len(str(node.get("inputs", {}).get("prompt", ""))), reverse=True)
    edit_nodes[0].setdefault("inputs", {})["prompt"] = prompt
    for node in edit_nodes[1:]:
        node.setdefault("inputs", {})["prompt"] = negative

    try:
        _, latent_node = _find_node(out, "EmptyFlux2LatentImage")
        latent_node.setdefault("inputs", {})["width"] = _align16(width)
        latent_node["inputs"]["height"] = _align16(height)
    except RuntimeError:
        pass

    try:
        _, ref_scale = _find_node(out, "ImageScaleToTotalPixels")
        ref_scale.setdefault("inputs", {})["megapixels"] = max(0.05, min(1.0, float(megapixels)))
        ref_scale["inputs"]["resolution_steps"] = 16
    except RuntimeError:
        pass

    _, save_node = _find_node(out, "SaveImage")
    save_node.setdefault("inputs", {})["filename_prefix"] = f"MOSS-Image-Edit/native-{uuid.uuid4().hex[:8]}"
    return out


def _align16(value: int) -> int:
    return max(256, min(1536, int(round(int(value) / 16.0)) * 16))


# ── 生成主流程 ──────────────────────────────────────────────────


def _submit_and_wait(workflow: dict[str, Any]) -> tuple[bytes, int, int, str]:
    client_id = uuid.uuid4().hex
    submitted = _http_json(f"{COMFY_URL}/prompt", {"prompt": workflow, "client_id": client_id}, timeout=30.0)
    prompt_id = submitted.get("prompt_id") if isinstance(submitted, dict) else None
    if not prompt_id:
        raise RuntimeError(f"ComfyUI 未返回 prompt_id: {submitted}")

    deadline = time.time() + TIMEOUT_S
    last_err: str | None = None
    while time.time() < deadline:
        try:
            history = _http_json(f"{COMFY_URL}/history/{prompt_id}", timeout=10.0)
        except Exception as exc:  # noqa: BLE001
            last_err = str(exc)
            time.sleep(POLL_S)
            continue
        record = history.get(prompt_id) if isinstance(history, dict) else None
        if record:
            status = record.get("status") or {}
            if status.get("status_str") == "error":
                raise RuntimeError(f"ComfyUI 执行失败: {status.get('messages')}")
            outputs = record.get("outputs") or {}
            for node_output in outputs.values():
                images = node_output.get("images") or []
                if not images:
                    continue
                image = images[0]
                query = urllib.parse.urlencode(
                    {
                        "filename": image.get("filename", ""),
                        "subfolder": image.get("subfolder", ""),
                        "type": image.get("type", "output"),
                    }
                )
                png = _http_bytes(f"{COMFY_URL}/view?{query}")
                if not png.startswith(b"\x89PNG"):
                    raise RuntimeError("ComfyUI 返回的不是 PNG")
                width, height = _png_size(png)
                return png, width, height, prompt_id
        time.sleep(POLL_S)

    # 超时：尽量从队列里删掉，避免占着 GPU
    try:
        _http_json(f"{COMFY_URL}/queue", {"delete": [prompt_id]}, timeout=5.0)
    except Exception:  # noqa: BLE001
        pass
    raise TimeoutError(f"等待 ComfyUI 出图超时（>{TIMEOUT_S}s，last={last_err}）")


def _png_size(png: bytes) -> tuple[int, int]:
    try:
        from PIL import Image  # 容器基础镜像自带 Pillow

        with Image.open(io.BytesIO(png)) as image:
            return int(image.width), int(image.height)
    except Exception:  # noqa: BLE001
        return 0, 0


# ── FastAPI ─────────────────────────────────────────────────────


class EditRequest(BaseModel):
    prompt: str = Field(..., min_length=1, max_length=2000)
    image_paths: list[str] | None = None
    negative_prompt: str | None = None
    width: int | None = Field(default=None, ge=256, le=1536)
    height: int | None = Field(default=None, ge=256, le=1536)
    steps: int | None = Field(default=None, ge=10, le=60)
    num_inference_steps: int | None = Field(default=None, ge=10, le=60)  # Qwen 兼容字段
    seed: int = 0
    simple: bool = False  # Qwen 兼容；MOSS 分支不裁剪
    reference_max_edge: int | None = Field(default=None, ge=256, le=2048)  # 兼容旧字段（native 路径用 reference_megapixels 替代）
    megapixels: float | None = Field(default=None, ge=0.05, le=1.0)


app = FastAPI(title="Karen MOSS-Image-Edit", version="0.1.0")


@app.get("/health")
def health() -> dict[str, Any]:
    workflow_ok = _workflow is not None
    workflow_error = _workflow_error
    if not workflow_ok and workflow_error is None:
        try:
            load_workflow()
            workflow_ok = True
        except Exception as exc:  # noqa: BLE001
            workflow_error = str(exc)
    stats = None
    try:
        stats = _http_json(f"{COMFY_URL}/system_stats", timeout=3.0)
    except Exception:  # noqa: BLE001
        pass
    gpu = None
    if isinstance(stats, dict):
        devices = stats.get("devices") or []
        if devices:
            gpu = devices[0].get("name")
    return {
        "ok": bool(workflow_ok and stats is not None),
        "service": "moss-edit",
        "comfy_url": COMFY_URL,
        "comfy_ok": stats is not None,
        "workflow_ok": workflow_ok,
        "workflow_error": workflow_error,
        "moss_edit_node_ready": _comfy_node_ready() if stats is not None else False,
        "workflow": str(WORKFLOW_PATH),
        "models": MODEL_NAMES,
        "gpu": gpu,
        "defaults": {
            "steps": DEFAULT_STEPS,
            "cfg": DEFAULT_CFG,
            "reference_megapixels": DEFAULT_REF_MEGAPIXELS,
            "output": [DEFAULT_OUT_WIDTH, DEFAULT_OUT_HEIGHT],
            "timeout_s": TIMEOUT_S,
        },
    }


@app.post("/edit")
async def edit(req: EditRequest) -> Response:
    started = time.time()
    try:
        workflow = load_workflow()
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=503, detail=str(exc)) from exc
    if not _comfy_reachable():
        raise HTTPException(status_code=503, detail=f"ComfyUI 不可用: {COMFY_URL}")
    if not _comfy_node_ready():
        raise HTTPException(status_code=503, detail="ComfyUI 缺少原生 MOSS edit 节点（版本过旧？）")

    image_name = prepare_reference(req.image_paths or [])
    steps = req.steps or req.num_inference_steps or DEFAULT_STEPS
    patched = patch_workflow(
        workflow,
        prompt=req.prompt.strip(),
        negative=(req.negative_prompt or "").strip(),
        image_name=image_name,
        steps=steps,
        seed=int(req.seed),
        cfg=DEFAULT_CFG,
        reference_max_edge=req.reference_max_edge or DEFAULT_REF_MAX_EDGE,
        megapixels=req.megapixels or DEFAULT_REF_MEGAPIXELS,
        width=req.width or DEFAULT_OUT_WIDTH,
        height=req.height or DEFAULT_OUT_HEIGHT,
    )

    async with _lock:
        try:
            png, width, height, prompt_id = await asyncio.to_thread(_submit_and_wait, patched)
        except TimeoutError as exc:
            raise HTTPException(status_code=504, detail=str(exc)) from exc
        except HTTPException:
            raise
        except Exception as exc:  # noqa: BLE001
            raise HTTPException(status_code=500, detail=f"MOSS edit 失败: {exc}") from exc

    elapsed_ms = int((time.time() - started) * 1000)
    return Response(
        content=png,
        media_type="image/png",
        headers={
            "X-Image-Width": str(width),
            "X-Image-Height": str(height),
            "X-Image-Steps": str(steps),
            "X-Image-Seed": str(int(req.seed)),
            "X-Elapsed-Ms": str(elapsed_ms),
            "X-Prompt-Id": prompt_id,
            "X-Backend": "moss-image-edit",
        },
    )


@app.get("/")
def index() -> dict[str, Any]:
    return {
        "service": "moss-edit",
        "endpoints": ["GET /health", "POST /edit"],
        "request": {
            "prompt": "string (required)",
            "image_paths": ["/workspace/data/karen-ref/character-2.jpg"],
            "steps": DEFAULT_STEPS,
            "seed": 0,
        },
    }


if __name__ == "__main__":
    uvicorn.run(app, host=HOST, port=PORT, log_level="info")

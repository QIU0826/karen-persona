"""karen 本地向量服务（v0.5 P1 骨架）。

职责：给 Node 侧提供 embedding 与 rerank，避免在主仓库引入原生 npm 依赖。
设计约束：
- 只绑 127.0.0.1；
- 懒加载模型（首次请求才加载，启动快）；
- 任何异常都返回 5xx + 简短原因，由 Node 侧降级到 n-gram；
- 模型缓存目录由 KAREN_MODELS_DIR 控制，方便一键清理。

启动：
    uv run --with fastapi --with uvicorn --with fastembed server.py
"""

from __future__ import annotations

import os
from pathlib import Path
from typing import List, Optional

from fastapi import FastAPI, HTTPException
from pydantic import BaseModel, Field

DEFAULT_MODEL = os.environ.get("KAREN_EMBED_MODEL", "Qwen/Qwen3-Embedding-0.6B")
DEFAULT_PORT = int(os.environ.get("KAREN_EMBED_PORT", "18083"))
MODELS_DIR = Path(
    os.environ.get(
        "KAREN_MODELS_DIR",
        str(Path.home() / "Library" / "Application Support" / "karen" / "models"),
    )
)
# Qwen3-Embedding 官方建议：检索 query 侧加任务指令，document 侧不加（差距明显）
QUERY_INSTRUCT = os.environ.get(
    "KAREN_EMBED_QUERY_INSTRUCT",
    "Instruct: 给定一段聊天里的话，找出与之相关的人、事、承诺或情绪\nQuery: ",
)
# 输出维度：Qwen3-Embedding 支持 MRL 截断，768 维可直接复用现有 t2_vec(FLOAT[768])，零 schema 迁移。
# 设为 0 表示用模型默认维度（1024）。
FORCE_DIM = int(os.environ.get("KAREN_EMBED_DIM", "768"))

app = FastAPI(title="karen-local-embed", version="0.1.0")

_embedder = None
_reranker = None
_dim: Optional[int] = None


class EmbedRequest(BaseModel):
    texts: List[str] = Field(default_factory=list)
    # query：检索查询（会自动加任务指令）；document：入库文本（不加）
    mode: str = "document"


class EmbedResponse(BaseModel):
    vectors: List[List[float]]
    dim: int


class RerankRequest(BaseModel):
    query: str
    candidates: List[str] = Field(default_factory=list)


class RerankResponse(BaseModel):
    scores: List[float]


def _get_embedder():
    """懒加载 embedding 模型（首次调用会触发下载到 MODELS_DIR）。"""
    global _embedder, _dim
    if _embedder is not None:
        return _embedder
    try:
        from fastembed import TextEmbedding  # 延迟导入，未安装时给出清晰报错
    except ImportError as err:  # pragma: no cover - 环境问题
        raise HTTPException(
            status_code=503,
            detail="缺少 fastembed，请用 uv run --with fastembed 启动",
        ) from err

    MODELS_DIR.mkdir(parents=True, exist_ok=True)
    _embedder = TextEmbedding(model_name=DEFAULT_MODEL, cache_dir=str(MODELS_DIR))
    # 探测维度（不同模型 768/1024 不同）
    probe = next(iter(_embedder.embed(["dimension probe"])))
    _dim = len(probe)
    return _embedder


def _get_reranker():
    """懒加载 reranker；模型不存在时返回 None（调用方自行降级）。"""
    global _reranker
    if _reranker is not None:
        return _reranker
    try:
        from fastembed import TextCrossEncoder
    except ImportError:  # pragma: no cover
        return None
    try:
        _reranker = TextCrossEncoder(model_name="Xenova/bge-reranker-base", cache_dir=str(MODELS_DIR))
    except Exception:  # pragma: no cover - 模型不可用时静默降级
        _reranker = None
    return _reranker


def _truncate(vec: List[float], dim: int) -> List[float]:
    """MRL 截断：取前 dim 维并重新 L2 归一化（Qwen3-Embedding 支持）。"""
    if dim <= 0 or dim >= len(vec):
        return vec
    import math

    cut = vec[:dim]
    norm = math.sqrt(sum(v * v for v in cut)) or 1.0
    return [v / norm for v in cut]


@app.get("/health")
def health() -> dict:
    return {
        "ok": True,
        "model": DEFAULT_MODEL,
        "dim": _dim or 0,
        "device": "cpu",  # fastembed 走 onnxruntime CPU
        "models_dir": str(MODELS_DIR),
    }


@app.post("/embed", response_model=EmbedResponse)
def embed(req: EmbedRequest) -> EmbedResponse:
    if not req.texts:
        return EmbedResponse(vectors=[], dim=_dim or 0)
    texts = [t[:2000] for t in req.texts]
    if req.mode == "query" and QUERY_INSTRUCT:
        texts = [f"{QUERY_INSTRUCT}{t}" for t in texts]
    try:
        embedder = _get_embedder()
        vectors = [list(map(float, v)) for v in embedder.embed(texts)]
    except HTTPException:
        raise
    except Exception as err:  # pragma: no cover - 运行时问题
        raise HTTPException(status_code=503, detail=f"embed_failed: {type(err).__name__}") from err

    dim = FORCE_DIM or len(vectors[0])
    if FORCE_DIM:
        vectors = [_truncate(v, FORCE_DIM) for v in vectors]
    return EmbedResponse(vectors=vectors, dim=dim)


@app.post("/rerank", response_model=RerankResponse)
def rerank(req: RerankRequest) -> RerankResponse:
    if not req.candidates:
        return RerankResponse(scores=[])
    reranker = _get_reranker()
    if reranker is None:
        raise HTTPException(status_code=503, detail="reranker_unavailable")
    try:
        scores = [float(s) for s in reranker.rerank(req.query, req.candidates)]
    except Exception as err:  # pragma: no cover
        raise HTTPException(status_code=503, detail=f"rerank_failed: {type(err).__name__}") from err
    return RerankResponse(scores=scores)


if __name__ == "__main__":  # pragma: no cover
    import uvicorn

    uvicorn.run(app, host="127.0.0.1", port=DEFAULT_PORT, log_level="info")

#!/usr/bin/env bash
# 启动本地语义嵌入服务（P0-2）：Qwen3-Embedding-0.6B ONNX，127.0.0.1:18083。
# 服务不可用时桥接会自动降级到 n-gram 检索；这个守护只是让它别在重启后悄悄消失。
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
UV="${UV_BIN:-$HOME/.local/bin/uv}"
if [ ! -x "$UV" ]; then
  echo "找不到 uv：$UV（可用 UV_BIN 覆盖）" >&2
  exit 1
fi
cd "$ROOT/services/embed"
exec "$UV" run --python 3.12 --with fastapi --with uvicorn --with fastembed server.py

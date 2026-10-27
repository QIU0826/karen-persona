#!/usr/bin/env bash
# 启动 MOSS-Image-SFT 服务（GPU7，容器 + /mnt/data0 venv 直跑）。
#
# 为什么不是 Dockerfile 构建：服务器根分区只剩 ~11GB，模型 27.2GB 与 Python 依赖都在
# /mnt/data0；直接复用已有基础镜像 + data0 上的 venv，最省根分区。
#
# 用法：bash start.sh
# 可选环境变量：
#   MOSS_IMAGE_GPU=7              CDI 设备号（nvidia.com/gpu=N）
#   MOSS_IMAGE_IMAGE=localhost/karen-qwen-image-edit:0.1
#   MOSS_IMAGE_STACK=/mnt/data0/lwh/karen-stack
set -euo pipefail

GPU="${MOSS_IMAGE_GPU:-7}"
IMAGE="${MOSS_IMAGE_IMAGE:-localhost/karen-qwen-image-edit:0.1}"
STACK="${MOSS_IMAGE_STACK:-/mnt/data0/lwh/karen-stack}"
NAME="${MOSS_IMAGE_CONTAINER:-karen-moss-image}"
MODEL_DIR="${MOSS_IMAGE_MODEL_DIR:-/workspace/models/MOSS-Image-SFT}"

if ! command -v podman >/dev/null 2>&1; then
  echo "podman not found" >&2
  exit 1
fi
if ! podman image exists "$IMAGE"; then
  echo "image not found: $IMAGE" >&2
  exit 1
fi
if ! podman container exists "$NAME" 2>/dev/null; then
  :
else
  echo "container already exists: $NAME（先 bash stop.sh）" >&2
  exit 1
fi
if [ ! -f "$STACK/moss-image/server.py" ]; then
  echo "server.py missing: $STACK/moss-image/server.py" >&2
  exit 1
fi
if [ ! -d "$STACK/models/MOSS-Image-SFT/transformer" ]; then
  echo "model dir missing: $STACK/models/MOSS-Image-SFT" >&2
  exit 1
fi

podman run -d --name "$NAME" \
  --device "nvidia.com/gpu=${GPU}" \
  -p 127.0.0.1:18114:18114 \
  -p 127.0.0.1:18115:18115 \
  -e MOSS_IMAGE_MODEL_DIR="$MODEL_DIR" \
  -e MOSS_IMAGE_HOST=0.0.0.0 \
  -e MOSS_IMAGE_PORT=18114 \
  -e MOSS_IMAGE_EDIT_PORT=18115 \
  -e MOSS_IMAGE_LOAD_MODE="${MOSS_IMAGE_LOAD_MODE:-auto}" \
  -e HF_HUB_OFFLINE=1 \
  -e TRANSFORMERS_OFFLINE=1 \
  -e PYTHONUNBUFFERED=1 \
  -v "$STACK:/workspace" \
  --entrypoint /workspace/moss-image/venv/bin/python \
  "$IMAGE" /workspace/moss-image/server.py

echo "started container $NAME（GPU${GPU}）"
echo "日志：podman logs -f $NAME    或 tail -f $STACK/moss-image/logs/moss-image.log"
echo "健康：curl -s http://127.0.0.1:18114/health"

#!/usr/bin/env bash
# 启动「人物专用」MOSS-Image + Karen identity LoRA 服务（GPU6，端口 18116）。
#
# 与基础 MOSS 服务（GPU7 18114）隔离：
# - 不看/不动 GPU7 服务；本实例用独立容器名、独立模型目录、独立端口。
# - 模型目录由 merge_lora.py 生成：/mnt/data0/lwh/karen-stack/models/MOSS-Image-SFT-karen-lora
#   （transformer 是 merged 权重；text_encoder/tokenizer/vae 软链到 base，不重复占盘）
#
# 用法：bash char-start.sh
# 可选：MOSS_CHARACTER_GPU=6 MOSS_CHARACTER_CONTAINER=karen-moss-character
set -euo pipefail

GPU="${MOSS_CHARACTER_GPU:-6}"
IMAGE="${MOSS_IMAGE_IMAGE:-localhost/karen-qwen-image-edit:0.1}"
STACK="${MOSS_IMAGE_STACK:-/mnt/data0/lwh/karen-stack}"
NAME="${MOSS_CHARACTER_CONTAINER:-karen-moss-character}"
MODEL_DIR="${MOSS_CHARACTER_MODEL_DIR:-/workspace/models/MOSS-Image-SFT-karen-lora}"
PORT="${MOSS_CHARACTER_PORT:-18116}"
EDIT_PORT="${MOSS_CHARACTER_EDIT_PORT:-18117}"

if ! command -v podman >/dev/null 2>&1; then
  echo "podman not found" >&2
  exit 1
fi
if ! podman image exists "$IMAGE"; then
  echo "image not found: $IMAGE" >&2
  exit 1
fi
if podman container exists "$NAME" 2>/dev/null; then
  echo "container already exists: $NAME（先 bash char-stop.sh）" >&2
  exit 1
fi
if [ ! -f "$STACK/moss-image/server.py" ]; then
  echo "server.py missing: $STACK/moss-image/server.py" >&2
  exit 1
fi
if [ ! -d "$STACK/models/MOSS-Image-SFT-karen-lora/transformer" ]; then
  echo "merged model missing: $STACK/models/MOSS-Image-SFT-karen-lora/transformer（先跑 merge_lora.py）" >&2
  exit 1
fi
if [ ! -f "$STACK/models/MOSS-Image-SFT-karen-lora/merge-report.json" ]; then
  echo "warn: merge-report.json 缺失（merged 目录可能不完整）" >&2
fi

podman run -d --name "$NAME" \
  --device "nvidia.com/gpu=${GPU}" \
  -p "127.0.0.1:${PORT}:${PORT}" \
  -e MOSS_IMAGE_MODEL_DIR="$MODEL_DIR" \
  -e MOSS_IMAGE_HOST=0.0.0.0 \
  -e MOSS_IMAGE_PORT="$PORT" \
  -e MOSS_IMAGE_EDIT_PORT="$EDIT_PORT" \
  -e MOSS_IMAGE_DEFAULT_SIZE=832 \
  -e MOSS_IMAGE_LOAD_MODE="${MOSS_IMAGE_LOAD_MODE:-auto}" \
  -e HF_HUB_OFFLINE=1 \
  -e TRANSFORMERS_OFFLINE=1 \
  -e PYTHONUNBUFFERED=1 \
  -v "$STACK:/workspace" \
  --entrypoint /workspace/moss-image/venv/bin/python \
  "$IMAGE" /workspace/moss-image/server.py

echo "started container $NAME（GPU${GPU}，端口 ${PORT}）"
echo "日志：podman logs -f $NAME"
echo "健康：curl -s http://127.0.0.1:${PORT}/health"
echo "停止：bash deploy/gpu-server/moss-image/char-stop.sh"

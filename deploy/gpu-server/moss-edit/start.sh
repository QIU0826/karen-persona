#!/usr/bin/env bash
# 启动 MOSS-Image-Edit 服务（GPU6，容器 + 基础镜像 python；权重/venv/ComfyUI 全在 data0）。
#
# 用法（服务器）：bash /mnt/data0/lwh/karen-stack/moss-edit/start.sh
# 可选环境变量：
#   MOSS_EDIT_GPU=6        CDI 设备号（nvidia.com/gpu=N；默认 6，与 18116 shadow 服务同卡）
#   MOSS_EDIT_IMAGE=localhost/karen-qwen-image-edit:0.1
#   MOSS_EDIT_STACK=/mnt/data0/lwh/karen-stack
#   MOSS_EDIT_HTTP_PORT=18117
set -euo pipefail

GPU="${MOSS_EDIT_GPU:-6}"
IMAGE="${MOSS_EDIT_IMAGE:-localhost/karen-qwen-image-edit:0.1}"
STACK="${MOSS_EDIT_STACK:-/mnt/data0/lwh/karen-stack}"
NAME="${MOSS_EDIT_CONTAINER:-karen-moss-edit}"
PORT="${MOSS_EDIT_HTTP_PORT:-18117}"

command -v podman >/dev/null 2>&1 || { echo "podman not found" >&2; exit 1; }
podman image exists "$IMAGE" || { echo "image not found: $IMAGE" >&2; exit 1; }
[ -f "$STACK/moss-edit/edit_server.py" ] || { echo "edit_server.py missing" >&2; exit 1; }
[ -f "$STACK/moss-edit/workflows/moss_edit_single_reference.api.json" ] || {
  echo "workflow missing（先跑 fetch_workflow.sh）" >&2; exit 1;
}
[ -f "$STACK/comfyui/models/diffusion_models/moss_image_sft_int8_convrot.safetensors" ] || {
  echo "MOSS SFT int8 权重缺失（先跑 download_models.sh）" >&2; exit 1;
}
[ -f "$STACK/comfyui/models/text_encoders/qwen3.5_9b_int8_convrot.safetensors" ] || {
  echo "Qwen3.5 TE int8 权重缺失" >&2; exit 1;
}
[ -f "$STACK/comfyui/models/loras/moss_image_edit_lora_rank_64_bf16.safetensors" ] || {
  echo "MOSS-Image-Edit LoRA 缺失" >&2; exit 1;
}

if podman container exists "$NAME" 2>/dev/null; then
  echo "container already exists: $NAME（先 bash stop.sh）" >&2
  exit 1
fi

podman run -d --name "$NAME" \
  --device "nvidia.com/gpu=${GPU}" \
  --shm-size=8g \
  -p "127.0.0.1:${PORT}:${PORT}" \
  -e COMFY_URL=http://127.0.0.1:18118 \
  -e MOSS_EDIT_WORKFLOW=/workspace/moss-edit/workflows/moss_edit_native.api.json \
  -e COMFY_INPUT_DIR=/workspace/comfyui/input \
  -e COMFY_OUTPUT_DIR=/workspace/comfyui/output \
  -e HF_HUB_OFFLINE=1 \
  -e TRANSFORMERS_OFFLINE=1 \
  -e PYTHONUNBUFFERED=1 \
  -e PYTORCH_CUDA_ALLOC_CONF=expandable_segments:True \
  -e MOSS_EDIT_CLIP_DEVICE="${MOSS_EDIT_CLIP_DEVICE:-default}" \
  -v "$STACK:/workspace" \
  --entrypoint bash \
  "$IMAGE" /workspace/moss-edit/start_inside.sh

echo "started container $NAME（GPU${GPU}，http://127.0.0.1:${PORT}）"
echo "日志：podman logs -f $NAME    健康：curl -s http://127.0.0.1:${PORT}/health"

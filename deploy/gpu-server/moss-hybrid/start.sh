#!/usr/bin/env bash
# 启动 MOSS v2 → Qwen 修脸 hybrid wrapper（端口 18118；Mac 隧道 19118）。
#
# 注意：wrapper 本身不占 GPU，只是 HTTP 编排；它需要访问宿主机上的
#   - GPU6 MOSS v2 人物服务 http://127.0.0.1:18116
#   - GPU2 Qwen-Image-Edit  http://127.0.0.1:18110
# 因此用 podman --network host（Linux rootless podman 支持）复用宿主机回环。
set -euo pipefail

IMAGE="${HYBRID_IMAGE:-localhost/karen-qwen-image-edit:0.1}"
STACK="${HYBRID_STACK:-/mnt/data0/lwh/karen-stack}"
NAME="${HYBRID_CONTAINER:-karen-moss-hybrid}"
PORT="${HYBRID_PORT:-18118}"

podman container exists "$NAME" 2>/dev/null && { echo "container exists: $NAME（先 stop.sh）" >&2; exit 1; }
[ -f "$STACK/moss-hybrid/wrapper_server.py" ] || { echo "wrapper_server.py missing" >&2; exit 1; }

podman run -d --name "$NAME" \
  --network host \
  -e HYBRID_HOST="${HYBRID_HOST:-127.0.0.1}" \
  -e HYBRID_PORT="$PORT" \
  -e HYBRID_MOSS_URL="${HYBRID_MOSS_URL:-http://127.0.0.1:18116}" \
  -e HYBRID_QWEN_URL="${HYBRID_QWEN_URL:-http://127.0.0.1:18110}" \
  -e HYBRID_REF_MAIN="${HYBRID_REF_MAIN:-/workspace/data/karen-ref-promo/character-2.jpg}" \
  -e HYBRID_REF_EXTRA="${HYBRID_REF_EXTRA:-}" \
  -e HYBRID_TMP_DIR="${HYBRID_TMP_DIR:-/workspace/data/tmp/hybrid-wrapper}" \
  -e HYBRID_FIX_STEPS="${HYBRID_FIX_STEPS:-15}" \
  -e PYTHONUNBUFFERED=1 \
  -v "$STACK:/workspace" \
  --entrypoint /workspace/moss-image/venv/bin/python \
  "$IMAGE" /workspace/moss-hybrid/wrapper_server.py

echo "started $NAME; health: curl -s http://127.0.0.1:${PORT}/health"

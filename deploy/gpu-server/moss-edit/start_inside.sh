#!/usr/bin/env bash
# 容器内启动脚本：ComfyUI（127.0.0.1:18118，不对宿主暴露）+ MOSS edit 代理（18117）。
set -uo pipefail

COMFY_ROOT="${COMFY_ROOT:-/workspace/comfyui}"
COMFY_PORT="${COMFY_PORT:-18118}"
STACK="${MOSS_STACK:-/workspace}"
LOG_DIR="$STACK/logs"
mkdir -p "$LOG_DIR" "$COMFY_ROOT/input" "$COMFY_ROOT/output"

export HF_HUB_OFFLINE=1
export TRANSFORMERS_OFFLINE=1
export PYTHONUNBUFFERED=1
export PYTORCH_CUDA_ALLOC_CONF="${PYTORCH_CUDA_ALLOC_CONF:-expandable_segments:True}"

PYBIN=/workspace/venvs/comfyui/bin/python
echo "[moss-edit] starting ComfyUI on 127.0.0.1:${COMFY_PORT}"
cd "$COMFY_ROOT" || exit 1
"$PYBIN" main.py \
  --listen 127.0.0.1 \
  --port "$COMFY_PORT" \
  --disable-auto-launch \
  --preview-method none \
  --output-directory "$COMFY_ROOT/output" \
  --input-directory "$COMFY_ROOT/input" \
  ${COMFY_ARGS:-} \
  >"$LOG_DIR/comfyui-moss-edit.log" 2>&1 &
COMFY_PID=$!
trap 'kill "$COMFY_PID" 2>/dev/null || true' INT TERM

comfy_alive() {
  "$PYBIN" - <<PY >/dev/null 2>&1
import urllib.request
urllib.request.urlopen("http://127.0.0.1:${COMFY_PORT}/system_stats", timeout=3).read()
PY
}
for i in $(seq 1 180); do
  if comfy_alive; then
    echo "[moss-edit] ComfyUI ready after $((i * 2))s"
    break
  fi
  if ! kill -0 "$COMFY_PID" 2>/dev/null; then
    echo "[moss-edit] ComfyUI 进程退出，最后 80 行日志：" >&2
    tail -80 "$LOG_DIR/comfyui-moss-edit.log" >&2
    exit 1
  fi
  sleep 2
done

if ! comfy_alive; then
  echo "[moss-edit] ComfyUI 360s 内未就绪，最后 80 行日志：" >&2
  tail -80 "$LOG_DIR/comfyui-moss-edit.log" >&2
  exit 1
fi

export COMFY_URL="http://127.0.0.1:${COMFY_PORT}"
echo "[moss-edit] starting edit_server on 0.0.0.0:18117"
exec "$PYBIN" /workspace/moss-edit/edit_server.py

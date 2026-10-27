#!/usr/bin/env bash
# Mac 侧：建立 19117 -> GPU 服务器 127.0.0.1:18117 的 SSH 隧道（本地调试/bench 用）。
# 不修改生产 tunnel（scripts/gpu-tunnel.sh / launchd），只额外开一个连接。
#
# 用法：
#   GPU_HOST=1.2.3.4 GPU_PORT=10236 GPU_USER=lwh GPU_KEY=~/.ssh/karen_gpu \
#     bash deploy/gpu-server/moss-edit/tunnel.sh
set -euo pipefail
: "${GPU_HOST:?请设置 GPU_HOST}"
: "${GPU_USER:?请设置 GPU_USER}"
GPU_PORT="${GPU_PORT:-22}"
GPU_KEY="${GPU_KEY:-}"
LOCAL_BIND="${LOCAL_BIND:-127.0.0.1}"
LOCAL_PORT="${LOCAL_PORT:-19117}"
REMOTE_PORT="${REMOTE_PORT:-18117}"

key_args=()
if [ -n "$GPU_KEY" ]; then
  [ -f "$GPU_KEY" ] || { echo "私钥不存在：$GPU_KEY" >&2; exit 1; }
  key_args=(-i "$GPU_KEY" -o IdentitiesOnly=yes)
fi

exec ssh -N \
  -o ServerAliveInterval=30 \
  -o ServerAliveCountMax=3 \
  -o ExitOnForwardFailure=yes \
  "${key_args[@]}" \
  -p "$GPU_PORT" \
  -L "${LOCAL_BIND}:${LOCAL_PORT}:127.0.0.1:${REMOTE_PORT}" \
  "${GPU_USER}@${GPU_HOST}"

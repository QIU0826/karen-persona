#!/usr/bin/env bash
# 从 Mac 建立到 GPU 服务器的 SSH 隧道。
# 不在仓库里保存主机、用户名、密钥；全部通过环境变量传入。
#
# 用法：
#   GPU_HOST=1.2.3.4 GPU_PORT=22022 GPU_USER=root \
#   GPU_KEY=~/.ssh/karen_gpu bash deploy/gpu-server/tunnel.sh
#
# 可选：
#   LOCAL_BIND=127.0.0.1（默认）
#   FORWARD_ONLY=1 只打印命令不执行
set -euo pipefail

: "${GPU_HOST:?请设置 GPU_HOST}"
: "${GPU_USER:?请设置 GPU_USER}"
GPU_PORT="${GPU_PORT:-22}"
GPU_KEY="${GPU_KEY:-}"
LOCAL_BIND="${LOCAL_BIND:-127.0.0.1}"
FORWARD_ONLY="${FORWARD_ONLY:-0}"

if ! command -v ssh >/dev/null 2>&1; then
  echo 'ssh not found' >&2
  exit 1
fi

key_args=()
if [ -n "$GPU_KEY" ]; then
  if [ ! -f "$GPU_KEY" ]; then
    echo "私钥不存在：$GPU_KEY" >&2
    exit 1
  fi
  key_args=(-i "$GPU_KEY" -o IdentitiesOnly=yes)
fi

# 本地端口:远程端口（与仓库 .env / docs 的 191xx 对齐；2026-10-23 修正）
# 生产实际入口是 scripts/gpu-tunnel.sh（launchd 守护）；本脚本供手工/其他机器使用。
pairs=(
  "19102:127.0.0.1:18102"  # VoxCPM2 TTS
  "19110:127.0.0.1:18110"  # Qwen-Image-Edit-2511（自拍/精修）
  "19111:127.0.0.1:18111"  # Z-Image-Turbo（场景图）
  "19112:127.0.0.1:18112"  # SenseVoice（ASR + 情绪）
  "19113:127.0.0.1:18113"  # Qwen2.5-Omni-7B（音频理解）
)

forward_args=()
for pair in "${pairs[@]}"; do
  forward_args+=(-L "${LOCAL_BIND}:${pair}")
done

cmd=(ssh -N
  -o ServerAliveInterval=30
  -o ServerAliveCountMax=3
  -o ExitOnForwardFailure=yes)
# macOS 自带 bash 3.2 在 set -u 下展开空数组会报 unbound variable。
if [ "${#key_args[@]}" -gt 0 ]; then
  cmd+=("${key_args[@]}")
fi
cmd+=(-p "$GPU_PORT" "${forward_args[@]}" "${GPU_USER}@${GPU_HOST}")

if [ "$FORWARD_ONLY" = "1" ]; then
  printf '%q ' "${cmd[@]}"
  printf '\n'
  exit 0
fi

echo "建立隧道：${GPU_USER}@${GPU_HOST}:${GPU_PORT} -> ${LOCAL_BIND}:19102/19110-19113"
echo '按 Ctrl-C 断开；保持这个终端运行。'
exec "${cmd[@]}"

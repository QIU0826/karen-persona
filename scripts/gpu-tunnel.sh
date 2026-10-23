#!/usr/bin/env bash
# GPU 服务 SSH 隧道（P0-2）：把远程 8×6000D 上的 Karen 服务转发到本机 191xx。
#
# 只做端口转发（ssh -N），不登录执行命令、不碰服务器上的其它项目。
# 远程端口（均在服务器 127.0.0.1 监听）：
#   18102 VoxCPM2 TTS      -> 本机 19102
#   18110 Qwen-Image-Edit  -> 本机 19110
#   18111 Z-Image          -> 本机 19111
#   18112 SenseVoice       -> 本机 19112
#   18113 Qwen-Omni        -> 本机 19113
#
# 用法：bash scripts/gpu-tunnel.sh
# 可通过 KAREN_GPU_SSH_HOST 覆盖 SSH 别名（默认 `karen-gpu`，定义在 ~/.ssh/config）。
set -euo pipefail

HOST="${KAREN_GPU_SSH_HOST:-karen-gpu}"

pairs=(
  "19102:127.0.0.1:18102" # VoxCPM2
  "19110:127.0.0.1:18110" # Qwen-Image-Edit
  "19111:127.0.0.1:18111" # Z-Image
  "19112:127.0.0.1:18112" # SenseVoice
  "19113:127.0.0.1:18113" # Qwen-Omni
)

args=(
  ssh -N -T
  -o BatchMode=yes
  -o ExitOnForwardFailure=yes
  -o ConnectTimeout=10
  -o ServerAliveInterval=30
  -o ServerAliveCountMax=3
)
for pair in "${pairs[@]}"; do
  args+=(-L "127.0.0.1:${pair}")
done

exec "${args[@]}" "$HOST"

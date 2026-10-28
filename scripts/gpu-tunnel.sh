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
#   18114 MOSS-Image       -> 本机 19114
#   18115 MOSS-Image-Edit  -> 本机 19115（当前部署的 SFT 只开 /generate，/edit 待 Edit 模型）
#   18116 MOSS-Character   -> 本机 19116（GPU6 人物专用：MOSS-Image-SFT + Karen identity LoRA）
#   18118 MOSS-Hybrid      -> 本机 19118（MOSS v2 生成 + Qwen 修脸 wrapper，task-29 shadow）
#
# 用法：bash scripts/gpu-tunnel.sh
# 可通过 KAREN_GPU_SSH_HOST 覆盖 SSH 别名（默认 `karen-gpu`，定义在 ~/.ssh/config）。
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
ENV_FILE="$ROOT/.env"

# 只读取本项目 .env 里的 SSH 相关键（不 source 整个文件，避免执行任意内容）。
read_env() {
  if [ -f "$ENV_FILE" ]; then
    grep -E "^$1=" "$ENV_FILE" 2>/dev/null | tail -1 | cut -d= -f2- \
      | sed -e 's/^["'\'']//' -e 's/["'\'']$//'
  fi
}

HOST="${KAREN_GPU_SSH_HOST:-$(read_env KAREN_GPU_SSH_HOST)}"
HOST="${HOST:-karen-gpu}"
PORT="${KAREN_GPU_SSH_PORT:-$(read_env KAREN_GPU_SSH_PORT)}"
KEY="${KAREN_GPU_SSH_KEY:-$(read_env KAREN_GPU_SSH_KEY)}"
PROXY="${KAREN_GPU_SSH_PROXY:-$(read_env KAREN_GPU_SSH_PROXY)}"

pairs=(
  "19102:127.0.0.1:18102" # VoxCPM2
  "19110:127.0.0.1:18110" # Qwen-Image-Edit
  "19111:127.0.0.1:18111" # Z-Image
  "19112:127.0.0.1:18112" # SenseVoice
  "19113:127.0.0.1:18113" # Qwen-Omni
  "19114:127.0.0.1:18114" # MOSS-Image（/generate /health）
  "19115:127.0.0.1:18115" # MOSS-Image-Edit（/edit /health，SFT 阶段 501）
  "19116:127.0.0.1:18116" # MOSS-Character（GPU6 人物 LoRA /generate /health）
  "19118:127.0.0.1:18118" # MOSS-Hybrid（MOSS v2 + Qwen 修脸 wrapper /selfie /health）
)

args=(
  ssh -N -T
  -o BatchMode=yes
  -o ExitOnForwardFailure=yes
  -o ConnectTimeout=10
  -o ServerAliveInterval=30
  -o ServerAliveCountMax=3
)
if [ -n "$KEY" ]; then
  args+=(-i "$KEY" -o IdentitiesOnly=yes)
fi
if [ -n "$PORT" ]; then
  args+=(-p "$PORT")
fi
if [ "$PROXY" = "none" ]; then
  args+=(-o ProxyCommand=none)
fi
for pair in "${pairs[@]}"; do
  args+=(-L "127.0.0.1:${pair}")
done

exec "${args[@]}" "$HOST"

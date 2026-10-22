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

# 本地端口:远程端口
pairs=(
  "19080:18100"  # GPT-SoVITS
  "19081:18101"  # Qwen3-TTS Base
  "19082:18102"  # Qwen3-TTS CustomVoice
  "19083:18103"  # Qwen3-TTS VoiceDesign
  "19088:18104"  # FireRedTTS3
  "19084:18110"  # Qwen-Image-Edit-2511
  "19085:18111"  # Z-Image-Turbo
  "19086:18120"  # Qwen3-ASR
  "19087:18122"  # Qwen3-VL
  "19089:18130"  # 本地 LLM（可选）
  "19090:18123"  # Embedding/Reranker
)

forward_args=()
for pair in "${pairs[@]}"; do
  forward_args+=(-L "${LOCAL_BIND}:${pair}")
done

cmd=(ssh -N
  -o ServerAliveInterval=30
  -o ServerAliveCountMax=3
  -o ExitOnForwardFailure=yes
  "${key_args[@]}"
  -p "$GPU_PORT"
  "${forward_args[@]}"
  "${GPU_USER}@${GPU_HOST}")

if [ "$FORWARD_ONLY" = "1" ]; then
  printf '%q ' "${cmd[@]}"
  printf '\n'
  exit 0
fi

echo "建立隧道：${GPU_USER}@${GPU_HOST}:${GPU_PORT} -> ${LOCAL_BIND}:19080-19090"
echo '按 Ctrl-C 断开；保持这个终端运行。'
exec "${cmd[@]}"

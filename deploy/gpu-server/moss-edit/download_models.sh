#!/usr/bin/env bash
# MOSS-Image-Edit（ComfyUI 格式）权重下载 —— 在 GPU 服务器上运行。
#
# 背景：服务器到 HuggingFace 不通（curl 000），Comfy-Org 的 ComfyUI 单文件权重已镜像到
# ModelScope `Comfy-Org/MOSS-Image`（含 MOSS-Image-Edit LoRA rank64 bf16）。
# 全部落 /mnt/data0，避免占用根分区（/ 仅 ~13GB 可用）。
#
# 用法（服务器）：
#   bash /mnt/data0/lwh/karen-stack/moss-edit/download_models.sh
# 幂等：已有且大小正确的文件跳过；curl -C - 断点续传。
set -uo pipefail

ROOT="${MOSS_COMFY_ROOT:-/mnt/data0/lwh/karen-stack/comfyui}"
MS_REPO="Comfy-Org/MOSS-Image"
BASE="https://www.modelscope.cn/api/v1/models/${MS_REPO}/repo?Revision=master&FilePath="
LOG_DIR="/mnt/data0/lwh/karen-stack/logs"
mkdir -p "$LOG_DIR" "$ROOT/models/diffusion_models" "$ROOT/models/text_encoders" "$ROOT/models/vae" "$ROOT/models/loras"

# 文件清单（ModelScope 2026-10-27 实际大小；SFT int8 + Qwen3.5 TE int8 + FLUX.2 small VAE + Edit LoRA rank64 bf16）
FILES=(
  "diffusion_models/moss_image_sft_int8_convrot.safetensors 5413698958"
  "text_encoders/qwen3.5_9b_int8_convrot.safetensors 9748121532"
  "vae/flux2-vae_small.safetensors 249521340"
  "loras/moss_image_edit_lora_rank_64_bf16.safetensors 297382216"
)

fail=0
for entry in "${FILES[@]}"; do
  rel="${entry% *}"
  want="${entry##* }"
  dest="$ROOT/models/$rel"
  name="$(basename "$rel")"
  if [ -f "$dest" ]; then
    have=$(stat -c%s "$dest" 2>/dev/null || echo 0)
    if [ "$have" = "$want" ]; then
      echo "SKIP $rel ($have bytes)"
      continue
    fi
  fi
  echo "GET  $rel ($want bytes) -> $dest"
  # 并发 4 段下载（大文件）；小文件单段即可。失败重试 5 次。
  if [ "$want" -gt 1000000000 ]; then
    aria2c --version >/dev/null 2>&1 && \
      aria2c -x4 -s4 -c --retry-wait=5 --max-tries=10 -d "$(dirname "$dest")" -o "$name" "${BASE}${rel}" \
      >>"$LOG_DIR/moss-edit-download.log" 2>&1 || \
      curl -L -C - --retry 5 --retry-delay 5 --max-time 7200 -o "$dest" "${BASE}${rel}" >>"$LOG_DIR/moss-edit-download.log" 2>&1
  else
    curl -L -C - --retry 5 --retry-delay 5 --max-time 1800 -o "$dest" "${BASE}${rel}" >>"$LOG_DIR/moss-edit-download.log" 2>&1
  fi
  have=$(stat -c%s "$dest" 2>/dev/null || echo 0)
  if [ "$have" = "$want" ]; then
    echo "OK   $rel"
  else
    echo "FAIL $rel (got $have want $want)" >&2
    fail=1
  fi
done

if [ "$fail" -ne 0 ]; then
  echo "部分权重下载失败，见 $LOG_DIR/moss-edit-download.log" >&2
  exit 1
fi
echo "ALL_WEIGHTS_OK"

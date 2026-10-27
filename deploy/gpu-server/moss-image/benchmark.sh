#!/usr/bin/env bash
# MOSS-Image-SFT 真实基准：至少 3 条 prompt 出图，记录耗时/显存/尺寸。
#
# 用法（在 GPU 服务器上，服务已启动）：
#   bash benchmark.sh
# 可选：
#   MOSS_URL=http://127.0.0.1:18114
#   OUT_DIR=./bench
set -euo pipefail

URL="${MOSS_URL:-http://127.0.0.1:18114}"
OUT="${OUT_DIR:-$(cd "$(dirname "$0")" && pwd)/bench}"
mkdir -p "$OUT"
STAMP="$(date +%Y%m%d-%H%M%S)"
SUMMARY="$OUT/benchmark-$STAMP.txt"

echo "== health ==" | tee "$SUMMARY"
curl -s --max-time 20 "$URL/health" | tee -a "$SUMMARY"
echo | tee -a "$SUMMARY"

gen() {
  local name="$1" prompt="$2" width="$3" height="$4" steps="$5" seed="$6"
  local body png="$OUT/${name}-${STAMP}.png" headers="$OUT/${name}-${STAMP}.headers" wall
  body=$(printf '{"prompt":%s,"width":%s,"height":%s,"steps":%s,"seed":%s}' \
    "$(printf '%s' "$prompt" | python3 -c 'import json,sys;print(json.dumps(sys.stdin.read()))')" \
    "$width" "$height" "$steps" "$seed")
  echo "== $name: ${width}x${height} steps=$steps seed=$seed ==" | tee -a "$SUMMARY"
  wall=$(curl -s --max-time 900 -o "$png" -D "$headers" -w '%{time_total}' \
    -X POST "$URL/generate" -H 'Content-Type: application/json' -d "$body")
  local status size
  status=$(head -1 "$headers" | awk '{print $2}')
  size=$(wc -c < "$png" | tr -d ' ')
  echo "http=$status wall_s=$wall bytes=$size" | tee -a "$SUMMARY"
  grep -iE '^x-(image|elapsed|gpu)' "$headers" | tee -a "$SUMMARY"
  python3 - "$png" <<'PY' | tee -a "$SUMMARY"
import struct, sys
path = sys.argv[1]
with open(path, 'rb') as fh:
    data = fh.read(33)
if data[:8] != b'\x89PNG\r\n\x1a\n':
    print('png=INVALID')
    raise SystemExit
w, h = struct.unpack('>II', data[16:24])
print(f'png={w}x{h} multiple16={w % 16 == 0 and h % 16 == 0}')
PY
  echo | tee -a "$SUMMARY"
}

# GPU7 基准前的占用
echo "== nvidia-smi (GPU7) before ==" | tee -a "$SUMMARY"
nvidia-smi --query-gpu=index,memory.used,memory.total,utilization.gpu --format=csv,noheader -i 7 | tee -a "$SUMMARY"

gen "rooftop"   "傍晚的城市屋顶，暖色天空，手机随手拍，自然光" 832 1216 50 42
gen "rain-street" "雨后的街道，便利店灯光倒映在湿漉漉的地面上，第一人称视角" 1024 1024 50 7
gen "cafe-selfie" "咖啡馆窗边自拍，年轻亚洲女性，中蓝色针织衫，柔和午后光，胸部以上近景" 1024 1024 50 2026
gen "teacup"    "窗台上的一杯热茶，旁边有一本书，午后阳光，手机随手拍" 1024 1024 50 11

echo "== nvidia-smi (GPU7) after ==" | tee -a "$SUMMARY"
nvidia-smi --query-gpu=index,memory.used,memory.total,utilization.gpu --format=csv,noheader -i 7 | tee -a "$SUMMARY"
echo "summary: $SUMMARY"

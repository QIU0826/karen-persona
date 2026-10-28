#!/usr/bin/env bash
# MOSS v2 生成 + Qwen-Image-Edit 修脸「混合自拍」实验（task-29）。
#
# 三组对照（同一批 5 个场景 prompt/seed）：
#   1) moss-base：GPU6 18116 的 MOSS v2（merged c1250）文生图；
#   2) qwen-direct：GPU2 18110 Qwen-Image-Edit 直接自拍（默认参考图 character-1/2）；
#   3) hybrid：把 moss-base 图 + character-2 作为 image_paths 调 Qwen /edit，只修脸/五官，
#              明确要求保持构图/场景/服装/发型/水彩画风不变。
#
# 产物默认放 /mnt/data0/lwh/karen-stack/data/tmp/hybrid/{moss-base,qwen-direct,hybrid}
# （容器内路径 /workspace/data/tmp/hybrid/，Qwen 能直接读）。
#
# 用法（GPU 服务器上）：
#   bash scripts/hybrid-selfie-bench.sh
# 可选 env：
#   MOSS_CHAR_URL=http://127.0.0.1:18116
#   QWEN_URL=http://127.0.0.1:18110
#   OUT_DIR=/mnt/data0/lwh/karen-stack/data/tmp/hybrid
#   REF_PROMO=/workspace/data/karen-ref-promo/character-2.jpg
#   QWEN_STEPS=10  HYBRID_STEPS=15
set -uo pipefail

MOSS_CHAR_URL="${MOSS_CHAR_URL:-http://127.0.0.1:18116}"
QWEN_URL="${QWEN_URL:-http://127.0.0.1:18110}"
OUT="${OUT_DIR:-/mnt/data0/lwh/karen-stack/data/tmp/hybrid}"
OUT_CONTAINER="/workspace/data/tmp/hybrid"
REF_PROMO="${REF_PROMO:-/workspace/data/karen-ref-promo/character-2.jpg}"
QWEN_STEPS="${QWEN_STEPS:-10}"
HYBRID_STEPS="${HYBRID_STEPS:-15}"
STAMP="$(date +%Y%m%d-%H%M%S)"
mkdir -p "$OUT/moss-base" "$OUT/qwen-direct" "$OUT/hybrid"
SUMMARY="$OUT/hybrid-benchmark-$STAMP.tsv"
printf 'scene\tgroup\thttp\twall_s\tbytes\tserver_elapsed_ms\tgpu_peak_gb\tnote\n' > "$SUMMARY"

IDENTITY="karen_style, a 24-year-old Chinese woman with shoulder-length medium-blue bob hair (#4a6fa5), gray-blue eyes, pale skin"
STYLE="soft pencil and watercolor illustration style, low-saturation cool gray-blue palette, fine pencil and ink linework with light watercolor wash, subtle paper texture, clean background with a clear scene atmosphere, single person, no text, no watermark, no border"
SELFIE_EN="close-up selfie, head and shoulders, facing the camera, no hands"
HYBRID_PROMPT="把图1中人物的脸和五官修正为与图2（参考立绘）完全相同的人：保持图1的构图、场景、服装、发型、水彩画风、光线、画幅完全不变，只调整脸型、眼睛、鼻子、嘴和肤色；不要改变姿势、背景、文字、装饰；不要裁切、不要重绘身体。"

scenes=(
  "cafe|sitting by a window seat in a cafe, a coffee cup on the table|wearing a light denim jacket|warm afternoon light|咖啡馆窗边，午后暖光"
  "home|a cozy living-room sofa at home|wearing a dark gray knit long-sleeve top|soft warm indoor lamp light|家里的沙发上，暖色台灯"
  "night|a city street at night, neon signs and wet pavement reflecting the lights|wearing a long black coat|mixed cool neon light and warm sign light|夜晚街头，远处霓虹灯虚化"
  "rain|by the window on a rainy day, raindrops on the glass|wearing an oatmeal knit cardigan|cool diffused light on a rainy day|下雨的窗边，玻璃上有水珠"
  "sea|the seaside at dusk, an orange sky over calm water|wearing a light linen dress|warm orange sunset side light|傍晚的海边，风把头发吹起来"
)

# Qwen 偶发 500（单卡串行 + 其它任务）：退避重试 3 次
qwen_edit() {
  local body="$1" out="$2" attempt
  for attempt in 1 2 3; do
    local wall
    wall=$(curl -s --max-time 900 -o "$out" -D "${out%.png}.headers" -w '%{time_total}' \
      -X POST "$QWEN_URL/edit" -H 'Content-Type: application/json' -d "$body")
    local status
    status=$(head -1 "${out%.png}.headers" 2>/dev/null | awk '{print $2}')
    if [ "$status" = "200" ] && file "$out" | grep -q "PNG image"; then
      echo "$status|$wall"
      return 0
    fi
    echo "[qwen] attempt $attempt http=$status wall=$wall，退避 ${attempt}0s" >&2
    sleep $((attempt * 10))
  done
  echo "FAIL|0"
  return 1
}

# MOSS v2 生成 base
gen_moss() {
  local prompt="$1" seed="$2" out="$3"
  local body
  body=$(python3 - "$prompt" "$seed" <<'PY'
import json, sys
print(json.dumps({"prompt": sys.argv[1], "width": 832, "height": 1216, "steps": 50, "seed": int(sys.argv[2])}))
PY
)
  local wall
  wall=$(curl -s --max-time 900 -o "$out" -D "${out%.png}.headers" -w '%{time_total}' \
    -X POST "$MOSS_CHAR_URL/generate" -H 'Content-Type: application/json' -d "$body")
  local status
  status=$(head -1 "${out%.png}.headers" 2>/dev/null | awk '{print $2}')
  echo "$status|$wall"
}

for entry in "${scenes[@]}"; do
  IFS='|' read -r key scene_en outfit light scene_zh <<<"$entry"
  moss_prompt="$IDENTITY, $scene_en, $outfit, $light, $SELFIE_EN, $STYLE"
  seed=$((4242 + ${#moss_prompt} % 97))

  echo "== $key MOSS base (seed=$seed) ==" >&2
  base_png="$OUT/moss-base/moss-$key-$STAMP.png"
  res=$(gen_moss "$moss_prompt" "$seed" "$base_png")
  echo -e "$key\tmoss-base\t${res%%|*}\t${res##*|}\t$(wc -c < "$base_png" 2>/dev/null || echo 0)\t$(grep -i '^x-elapsed-ms' "${base_png%.png}.headers" 2>/dev/null | tr -d '\r' | awk '{print $2}')\t$(grep -i '^x-gpu-peak-gb' "${base_png%.png}.headers" 2>/dev/null | tr -d '\r' | awk '{print $2}')\tseed=$seed" >> "$SUMMARY"

  echo "== $key Qwen-direct ==" >&2
  qbody=$(python3 - "$scene_zh" "$seed" "$QWEN_STEPS" <<'PY'
import json, sys
prompt = sys.argv[1] + "，表情自然看着镜头，对着镜头自拍，胸部以上近景，不出现手和手臂"
print(json.dumps({"prompt": prompt, "simple": True, "num_inference_steps": int(sys.argv[3]), "seed": int(sys.argv[2]) + 5000}))
PY
)
  qdirect_png="$OUT/qwen-direct/qwen-direct-$key-$STAMP.png"
  qres=$(qwen_edit "$qbody" "$qdirect_png")
  echo -e "$key\tqwen-direct\t${qres%%|*}\t${qres##*|}\t$(wc -c < "$qdirect_png" 2>/dev/null || echo 0)\t\t\tsteps=$QWEN_STEPS" >> "$SUMMARY"

  echo "== $key hybrid (base + character-2 → Qwen fix-face) ==" >&2
  hbody=$(python3 - "$moss_prompt" "$OUT_CONTAINER/moss-base/moss-$key-$STAMP.png" "$REF_PROMO" "$seed" "$HYBRID_STEPS" "$HYBRID_PROMPT" <<'PY'
import json, sys
# 兼容 PR：【MOSS 生成 prompt】仅作上下文记录，不传给 Qwen（Qwen 只看图 1 + 文字修脸要求）
print(json.dumps({
    "prompt": sys.argv[6],
    "image_paths": [sys.argv[2], sys.argv[3]],
    "simple": False,
    "num_inference_steps": int(sys.argv[5]),
    "seed": int(sys.argv[4]),
}))
PY
)
  hybrid_png="$OUT/hybrid/hybrid-$key-$STAMP.png"
  hres=$(qwen_edit "$hbody" "$hybrid_png")
  echo -e "$key\thybrid\t${hres%%|*}\t${hres##*|}\t$(wc -c < "$hybrid_png" 2>/dev/null || echo 0)\t\t\tsteps=$HYBRID_STEPS ref=$REF_PROMO" >> "$SUMMARY"
done

echo "== summary ==" >&2
column -t -s $'\t' "$SUMMARY" >&2
echo "summary: $SUMMARY"

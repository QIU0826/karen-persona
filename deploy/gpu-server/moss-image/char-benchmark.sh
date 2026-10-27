#!/usr/bin/env bash
# 人物 LoRA 自拍真实基准：5 个场景（咖啡馆/家/夜街/雨窗/海边）× MOSS+LoRA，另生成
# Qwen-Image-Edit 对照片（若 18110 可用），最后拼 contact sheet 并输出汇总。
#
# 用法（GPU 服务器上，两个服务都已启动）：
#   bash char-benchmark.sh
# 可选 env：
#   MOSS_CHAR_URL=http://127.0.0.1:18116
#   QWEN_URL=http://127.0.0.1:18110
#   OUT_DIR=/mnt/data0/lwh/karen-stack/moss-image/char-bench
set -uo pipefail

MOSS_CHAR_URL="${MOSS_CHAR_URL:-http://127.0.0.1:18116}"
QWEN_URL="${QWEN_URL:-http://127.0.0.1:18110}"
OUT="${OUT_DIR:-/mnt/data0/lwh/karen-stack/moss-image/char-bench}"
STAMP="$(date +%Y%m%d-%H%M%S)"
mkdir -p "$OUT/moss" "$OUT/qwen"
SUMMARY="$OUT/char-benchmark-$STAMP.txt"

IDENTITY="karen_style, a 24-year-old Chinese woman with shoulder-length medium-blue bob hair (#4a6fa5), gray-blue eyes, pale skin"
STYLE="soft pencil and watercolor illustration style, low-saturation cool gray-blue palette, fine pencil and ink linework with light watercolor wash, subtle paper texture, clean background with a clear scene atmosphere, single person, no text, no watermark, no border"
SELFIE="close-up selfie, head and shoulders, facing the camera, no hands"

scenes=(
  "cafe|sitting by a window seat in a cafe, a coffee cup on the table|wearing a light denim jacket|warm afternoon light|咖啡馆窗边，午后暖光"
  "home|a cozy living-room sofa at home|wearing a dark gray knit long-sleeve top|soft warm indoor lamp light|家里的沙发上，暖色台灯"
  "night|a city street at night, neon signs and wet pavement reflecting the lights|wearing a long black coat|mixed cool neon light and warm sign light|夜晚街头，远处霓虹灯虚化"
  "rain|by the window on a rainy day, raindrops on the glass|wearing an oatmeal knit cardigan|cool diffused light on a rainy day|下雨的窗边，玻璃上有水珠"
  "sea|the seaside at dusk, an orange sky over calm water|wearing a light linen dress|warm orange sunset side light|傍晚的海边，风把头发吹起来"
)

echo "== health ==" | tee "$SUMMARY"
curl -s --max-time 15 "$MOSS_CHAR_URL/health" | tee -a "$SUMMARY" | head -c 400
echo | tee -a "$SUMMARY"

for entry in "${scenes[@]}"; do
  IFS='|' read -r key scene_en outfit light scene_zh <<<"$entry"
  prompt="$IDENTITY, $scene_en, $outfit, $light, $SELFIE, $STYLE"
  body=$(python3 - "$prompt" <<'PY'
import json, sys
print(json.dumps({"prompt": sys.argv[1], "width": 832, "height": 1216, "steps": 50, "seed": 4242 + len(sys.argv[1]) % 97}))
PY
)
  echo "== moss/$key ==" | tee -a "$SUMMARY"
  wall=$(curl -s --max-time 900 -o "$OUT/moss/moss-$key-$STAMP.png" -D "$OUT/moss/moss-$key-$STAMP.headers" \
    -w '%{time_total}' -X POST "$MOSS_CHAR_URL/generate" -H 'Content-Type: application/json' -d "$body")
  echo "wall_s=$wall" | tee -a "$SUMMARY"
  grep -iE '^x-(image|elapsed|gpu)' "$OUT/moss/moss-$key-$STAMP.headers" | tee -a "$SUMMARY"

  if curl -s --max-time 5 -o /dev/null "$QWEN_URL/health"; then
    qbody=$(python3 - "$scene_zh" "$key" <<'PY'
import json, sys
prompt = sys.argv[1] + "，表情自然看着镜头，对着镜头自拍，胸部以上近景，不出现手和手臂"
print(json.dumps({"prompt": prompt, "simple": True, "num_inference_steps": 20, "seed": 4242 + len(sys.argv[2]) * 7}))
PY
)
    echo "== qwen/$key ==" | tee -a "$SUMMARY"
    qwall=$(curl -s --max-time 600 -o "$OUT/qwen/qwen-$key-$STAMP.png" -D "$OUT/qwen/qwen-$key-$STAMP.headers" \
      -w '%{time_total}' -X POST "$QWEN_URL/edit" -H 'Content-Type: application/json' -d "$qbody")
    echo "wall_s=$qwall" | tee -a "$SUMMARY"
    grep -iE '^x-image' "$OUT/qwen/qwen-$key-$STAMP.headers" | tee -a "$SUMMARY"
  fi
done

echo "== sizes ==" | tee -a "$SUMMARY"
ls -la "$OUT"/moss/*.png "$OUT"/qwen/*.png 2>/dev/null | tee -a "$SUMMARY"

# contact sheet（容器里有 PIL；不需要 GPU）
podman run --rm -v /mnt/data0/lwh/karen-stack:/workspace \
  --entrypoint /workspace/moss-image/venv/bin/python localhost/karen-qwen-image-edit:0.1 \
  /workspace/moss-image/char_contact_sheet.py \
  --moss-dir "/workspace/moss-image/char-bench/moss" \
  --qwen-dir "/workspace/moss-image/char-bench/qwen" \
  --out "/workspace/moss-image/char-bench/contact-$STAMP.jpg" 2>&1 | tee -a "$SUMMARY"

echo "summary: $SUMMARY"

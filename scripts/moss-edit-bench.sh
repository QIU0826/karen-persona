#!/usr/bin/env bash
# MOSS-Image-Edit vs Qwen-Image-Edit-2511 同参考/同 prompt/同 seed 的 5 场景对照。
#
# 用法（Mac，仓库根目录）：
#   GPU_HOST=<server> GPU_PORT=10236 GPU_USER=lwh GPU_KEY=~/.ssh/karen_gpu \
#     bash scripts/moss-edit-bench.sh
#
# 可选环境变量：
#   SEED=42 STEPS=20            # 两个后端使用同一 seed/steps
#   REF=/workspace/data/karen-ref/character-2.jpg
#   SKIP_QWEN=1 / SKIP_MOSS=1  # 只跑一个后端
#   SKIP_GUARD=1               # 跳过 Mac 侧 image-audit（需要 DEEPSEEK_API_KEY）
#
# 依赖：服务器已启动 18110（Qwen-Edit，既有服务）与 18117（MOSS edit，见 moss-edit/start.sh）；
#      服务器 host 上有 karen-arcface venv（insightface）与 data/karen-ref 参考图。
set -euo pipefail

: "${GPU_HOST:?请设置 GPU_HOST}"
GPU_USER="${GPU_USER:-lwh}"
GPU_PORT="${GPU_PORT:-22}"
GPU_KEY="${GPU_KEY:-$HOME/.ssh/karen_gpu}"
REMOTE_STACK="${REMOTE_STACK:-/mnt/data0/lwh/karen-stack}"
SEED="${SEED:-42}"
STEPS="${STEPS:-20}"
REF="${REF:-/workspace/data/karen-ref/character-2.jpg}"
ARCFACE_PY="${ARCFACE_PY:-/mnt/data0/lwh/karen-stack/venvs/karen-arcface/bin/python}"
LOCAL_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LOCAL_RESULTS="$LOCAL_ROOT/deploy/gpu-server/moss-edit/results"
mkdir -p "$LOCAL_RESULTS"

SSH=(ssh -i "$GPU_KEY" -o IdentitiesOnly=yes -o ConnectTimeout=15 -o ServerAliveInterval=30 -p "$GPU_PORT" "$GPU_USER@$GPU_HOST")
SCP=(scp -i "$GPU_KEY" -o IdentitiesOnly=yes -P "$GPU_PORT")

echo "— MOSS-Edit vs Qwen-Edit 对照（seed=$SEED steps=$STEPS ref=$REF）—"

# 1) 生成脚本（服务器侧）：同一组 prompt/seed/steps 分别打两个 /edit
"${SSH[@]}" "mkdir -p $REMOTE_STACK/moss-edit/results/{qwen,moss,eval}"
"${SSH[@]}" "cat > $REMOTE_STACK/moss-edit/bench_gen.sh" <<'REMOTE'
#!/usr/bin/env bash
set -uo pipefail
STACK=/mnt/data0/lwh/karen-stack
OUT="$STACK/moss-edit/results"
REF="${REF:?}"
SEED="${SEED:?}"
STEPS="${STEPS:?}"
prompts=(
"保持人物外貌、脸型、发型和身份完全不变，把场景换成安静的咖啡馆靠窗座位，下午暖光，手机自拍近景，不出现手部和手臂"
"保持人物外貌和身份完全不变，把场景换成家里的沙发，穿宽松家居服，夜晚暖色台灯，手机自拍近景，不出现手部"
"保持人物外貌和身份完全不变，把场景换成夜晚城市街道，霓虹灯，微雨后湿润路面，穿深色外套，手机自拍近景，不出现手部"
"保持人物外貌和身份完全不变，把场景换成雨天坐在窗边，玻璃上有雨滴，室内暖光，安静，手机自拍近景，不出现手部"
"保持人物外貌和身份完全不变，把场景换成傍晚海边，海风，天空有晚霞，穿浅色连衣裙，手机自拍近景，不出现手部"
)
scenes=(cafe home night rain seaside)
for backend in moss qwen; do
  [ "${SKIP_${backend^^}}" = "1" ] && continue
  port=18117; [ "$backend" = "qwen" ] && port=18110
  for i in "${!prompts[@]}"; do
    name="$(printf "%02d" $((i+1)))-${scenes[$i]}.png"
    body=$(python3 -c 'import json,sys;print(json.dumps({"prompt":sys.argv[1],"image_paths":[sys.argv[2]],"seed":int(sys.argv[3]),"steps":int(sys.argv[4]),"num_inference_steps":int(sys.argv[4])}))' "${prompts[$i]}" "$REF" "$SEED" "$STEPS")
    echo "[$backend] $name"
    # Qwen 服务在并发/负载下会随机 500（index out of bounds），这里最多重试 3 次
    for attempt in 1 2 3; do
      curl -sS --max-time 900 -X POST "http://127.0.0.1:$port/edit" \
        -H "Content-Type: application/json" -d "$body" \
        -D "$OUT/$backend/$name.headers" -o "$OUT/$backend/$name" || true
      if head -c 4 "$OUT/$backend/$name" 2>/dev/null | grep -q "PNG"; then break; fi
      echo "  attempt $attempt 非 PNG，3s 后重试"
      sleep 3
    done
    echo "  -> $(stat -c%s "$OUT/$backend/$name" 2>/dev/null || echo 0) bytes"
  done
done
echo GEN_DONE
REMOTE

"${SSH[@]}" "cd $REMOTE_STACK && REF='$REF' SEED='$SEED' STEPS='$STEPS' SKIP_QWEN='${SKIP_QWEN:-0}' SKIP_MOSS='${SKIP_MOSS:-0}' bash $REMOTE_STACK/moss-edit/bench_gen.sh" 2>&1 | tee "$LOCAL_RESULTS/bench-gen.log"

# 2) ArcFace + contact sheet（复用项目已有 karen-arcface venv + scripts/moss-lora-eval.py）
"${SCP[@]}" "$LOCAL_ROOT/scripts/moss-lora-eval.py" "$GPU_USER@$GPU_HOST:$REMOTE_STACK/moss-edit/eval/moss-lora-eval.py"
"${SSH[@]}" "$ARCFACE_PY $REMOTE_STACK/moss-edit/eval/moss-lora-eval.py metrics \
  --refs $REMOTE_STACK/data/karen-ref \
  --dirs moss-edit=$REMOTE_STACK/moss-edit/results/moss qwen=$REMOTE_STACK/moss-edit/results/qwen \
  --out $REMOTE_STACK/moss-edit/results/identity-report.md \
  --model buffalo_l --providers CPU" 2>&1 | tee "$LOCAL_RESULTS/identity-eval.log"

# 3) 取回报告 + contact sheet（PNG 原图保留在服务器，避免仓库膨胀）
"${SCP[@]}" "$GPU_USER@$GPU_HOST:$REMOTE_STACK/moss-edit/results/identity-report.md" "$LOCAL_RESULTS/" || true
"${SCP[@]}" "$GPU_USER@$GPU_HOST:$REMOTE_STACK/moss-edit/results/contact-*.jpg" "$LOCAL_RESULTS/" 2>/dev/null || true
"${SCP[@]}" "$GPU_USER@$GPU_HOST:$REMOTE_STACK/moss-edit/results/contact-*.png" "$LOCAL_RESULTS/" 2>/dev/null || true

# 4) 可选：Mac 侧 image-guard（DeepSeek Flash 多模态）
if [ "${SKIP_GUARD:-0}" != "1" ] && [ -f "$LOCAL_ROOT/.env" ] && grep -q '^DEEPSEEK_API_KEY=' "$LOCAL_ROOT/.env"; then
  echo "— 图片质检（image-audit）—"
  TMP_SAMPLES="$(mktemp -d)"
  "${SCP[@]}" -r "$GPU_USER@$GPU_HOST:$REMOTE_STACK/moss-edit/results/moss" "$TMP_SAMPLES/" 2>/dev/null || true
  "${SCP[@]}" -r "$GPU_USER@$GPU_HOST:$REMOTE_STACK/moss-edit/results/qwen" "$TMP_SAMPLES/" 2>/dev/null || true
  : > "$LOCAL_RESULTS/guard.tsv"
  for backend in moss qwen; do
    for img in "$TMP_SAMPLES/$backend"/*.png; do
      [ -f "$img" ] || continue
      scene="$(basename "$img" .png)"
      passed=$(cd "$LOCAL_ROOT" && node node_modules/tsx/dist/cli.mjs scripts/image-audit.ts \
        --image "$img" --context "自拍场景：$scene，Karen 蓝发短发少女，手机自拍近景，不出现手部" \
        --require-no-hands 2>/dev/null | python3 -c 'import sys,json;print("PASS" if json.load(sys.stdin).get("pass") else "FAIL")' 2>/dev/null || echo "ERROR")
      printf '%s\t%s\t%s\n' "$backend" "$scene" "$passed" >> "$LOCAL_RESULTS/guard.tsv"
    done
  done
  rm -rf "$TMP_SAMPLES"
  echo "guard 结果：$LOCAL_RESULTS/guard.tsv"
else
  echo "跳过 image-guard（SKIP_GUARD=1 或无 DEEPSEEK_API_KEY）"
fi

echo "— 完成 —"
echo "报告：$LOCAL_RESULTS/identity-report.md"
echo "contact sheet：$(ls "$LOCAL_RESULTS"/contact-* 2>/dev/null | tr '\n' ' ')"
echo "原图（服务器）：$REMOTE_STACK/moss-edit/results/{moss,qwen}/"

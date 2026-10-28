#!/usr/bin/env bash
# Hybrid wrapper 冒烟/基准：5 个自拍场景经 wrapper（MOSS v2 生成 → Qwen 修脸）出图并记录耗时。
#
# 用法（GPU 服务器上）：
#   bash wrapper-smoke.sh
# 可选：HYBRID_URL=http://127.0.0.1:18118  OUT_DIR=/mnt/data0/lwh/karen-stack/data/tmp/hybrid-wrapper-test
set -uo pipefail

URL="${HYBRID_URL:-http://127.0.0.1:18118}"
OUT="${OUT_DIR:-/mnt/data0/lwh/karen-stack/data/tmp/hybrid-wrapper-test}"
STAMP="$(date +%Y%m%d-%H%M%S)"
mkdir -p "$OUT"
SUMMARY="$OUT/wrapper-bench-$STAMP.tsv"
printf 'scene\thttp\twall_s\tbytes\ttotal_ms\tmoss_ms\tfix_ms\tqwen_attempts\n' > "$SUMMARY"

echo "== health =="
curl -s --max-time 10 "$URL/health" | tee "$OUT/health-$STAMP.json"; echo

scenes=(
  "cafe|咖啡馆窗边，午后暖光，穿着浅色牛仔外套，自拍"
  "home|家里的沙发上，暖色台灯，穿着深灰针织上衣，自拍"
  "night|夜晚街头，远处霓虹灯虚化，穿着黑色长外套，自拍"
  "rain|下雨的窗边，玻璃上有水珠，穿着燕麦色针织开衫，自拍"
  "sea|傍晚的海边，风把头发吹起来，穿着浅色亚麻裙，自拍"
)
for entry in "${scenes[@]}"; do
  IFS='|' read -r key prompt <<<"$entry"
  body=$(python3 - "$prompt" <<'PY'
import json, sys
print(json.dumps({"prompt": sys.argv[1], "width": 832, "height": 1216, "seed": 7777 + len(sys.argv[1]) % 97}))
PY
)
  out="$OUT/wrapper-$key-$STAMP"
  wall=$(curl -s --max-time 900 -o "$out.png" -D "$out.headers" -w '%{time_total}' \
    -X POST "$URL/selfie" -H 'Content-Type: application/json' -d "$body")
  status=$(head -1 "$out.headers" 2>/dev/null | awk '{print $2}')
  bytes=$(wc -c < "$out.png" 2>/dev/null || echo 0)
  total=$(grep -i '^x-total-ms' "$out.headers" 2>/dev/null | tr -d '\r' | awk '{print $2}')
  moss=$(grep -i '^x-moss-ms' "$out.headers" 2>/dev/null | tr -d '\r' | awk '{print $2}')
  fix=$(grep -i '^x-fix-ms' "$out.headers" 2>/dev/null | tr -d '\r' | awk '{print $2}')
  attempts=$(grep -i '^x-qwen-attempts' "$out.headers" 2>/dev/null | tr -d '\r' | awk '{print $2}')
  echo -e "$key\t$status\t$wall\t$bytes\t$total\t$moss\t$fix\t${attempts:-}" | tee -a "$SUMMARY"
done

echo "== summary ==" >&2
column -t -s $'\t' "$SUMMARY" >&2
echo "summary: $SUMMARY"

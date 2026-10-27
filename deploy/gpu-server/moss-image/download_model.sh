#!/usr/bin/env bash
# 下载 MOSS-Image-SFT（ModelScope，约 27.2GB）到 /mnt/data0。
#
# 服务器 HuggingFace / hf-mirror 不通，ModelScope 可用；用 aria2c 多连接 + 断点续传，
# 下载后必须用 verify_model.py 逐文件校验大小（aria2 重试可能产生超长文件）。
#
# 用法：
#   bash download_model.sh                 # 默认 /mnt/data0/lwh/karen-stack/models/MOSS-Image-SFT
#   MOSS_DOWNLOAD_DIR=/path bash download_model.sh
set -euo pipefail

MODEL_DIR="${MOSS_DOWNLOAD_DIR:-/mnt/data0/lwh/karen-stack/models/MOSS-Image-SFT}"
MODEL="openmoss/MOSS-Image-SFT"
BASE="https://www.modelscope.cn/models/${MODEL}/resolve/master"
LOG_DIR="${MOSS_LOG_DIR:-/mnt/data0/lwh/karen-stack/moss-image/logs}"
mkdir -p "$MODEL_DIR" "$LOG_DIR"

if ! command -v aria2c >/dev/null 2>&1; then
  echo "aria2c not found（Debian/Ubuntu: apt install aria2）" >&2
  exit 1
fi

echo "[1/3] 拉取文件清单与大小"
curl -sL -m 60 \
  "https://www.modelscope.cn/api/v1/models/${MODEL}/repo/files?Revision=master&Recursive=true" \
  -o /tmp/moss_files.json

echo "[2/3] 生成待下载清单（跳过已完整文件）"
python3 - "$MODEL_DIR" <<'PY'
import json, os, sys
model_dir = sys.argv[1]
base = "https://www.modelscope.cn/models/openmoss/MOSS-Image-SFT/resolve/master"
data = json.load(open("/tmp/moss_files.json"))
entries = []
missing = 0
for f in data["Data"]["Files"]:
    if f.get("Type") != "blob":
        continue
    path, size = f["Path"], f.get("Size", 0)
    local = os.path.join(model_dir, path)
    have = os.path.getsize(local) if os.path.exists(local) else 0
    if have == size:
        continue
    if have > size:  # 超长文件（aria2 重试叠加）：删掉重下
        os.remove(local)
        for suffix in (".aria2",):
            ctrl = local + suffix
            if os.path.exists(ctrl):
                os.remove(ctrl)
    missing += 1
    entries.append(f"{base}/{path}")
    entries.append(f"  dir={os.path.join(model_dir, os.path.dirname(path))}")
    entries.append(f"  out={os.path.basename(path)}")
open("/tmp/moss_aria_input.txt", "w").write("\n".join(entries) + "\n")
print(f"待下载文件数：{missing}")
PY

if [ -s /tmp/moss_aria_input.txt ]; then
  echo "[3/3] aria2c 下载（-j4 -x8）"
  aria2c -i /tmp/moss_aria_input.txt -j 4 -x 8 -s 8 -k 1M \
    --file-allocation=none --max-tries=10 --retry-wait=5 --timeout=60 --connect-timeout=30 \
    --console-log-level=warn --summary-interval=60 \
    --auto-file-renaming=false --allow-overwrite=true \
    2>&1 | tee "$LOG_DIR/download-$(date +%Y%m%d-%H%M%S).log"
else
  echo "所有文件已完整，跳过下载"
fi

echo "校验模型文件大小"
python3 "$(dirname "$0")/verify_model.py" "$MODEL_DIR"

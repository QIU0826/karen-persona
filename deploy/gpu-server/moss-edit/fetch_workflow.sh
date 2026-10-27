#!/usr/bin/env bash
# 部署/校验 MOSS-Image-Edit 的 ComfyUI API workflow（原生节点，无 GPL 插件）。
#
# 历史说明：最初计划用 Chenkin-x/ComfyUI-Moss-Image-Edit（GPLv3）插件，但其
# native_edit 依赖旧版 ComfyUI 的 `model.pe_embedder`，与 ComfyUI v0.43.0 原生
# MOSS-Image Edit 支持不兼容；故改用 ComfyUI 原生节点（TextEncodeMOSSImageEdit +
# LoraLoaderModelOnly + 原生 MOSS forward 的 reference_latents），仓库内只保留
# 自写的 workflow JSON，不包含任何 GPL 代码。
set -euo pipefail

STACK="${MOSS_EDIT_STACK:-/mnt/data0/lwh/karen-stack}"
SRC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEST_DIR="$STACK/moss-edit/workflows"

mkdir -p "$DEST_DIR"
cp "$SRC_DIR/workflows/moss_edit_native.api.json" "$DEST_DIR/moss_edit_native.api.json"

python3 - "$DEST_DIR/moss_edit_native.api.json" <<'PY'
import json, sys
path = sys.argv[1]
wf = json.load(open(path, encoding="utf-8"))
classes = {n.get("class_type") for n in wf.values() if isinstance(n, dict)}
required = {"UNETLoader", "CLIPLoader", "VAELoader", "LoraLoaderModelOnly",
            "TextEncodeMOSSImageEdit", "EmptyFlux2LatentImage", "KSampler", "LoadImage"}
missing = required - classes
if missing:
    raise SystemExit(f"workflow 缺少节点: {sorted(missing)}")
for node_id in ("8", "9"):
    inputs = wf[node_id]["inputs"]
    if "images.image_0" not in inputs:
        raise SystemExit(f"node {node_id} 缺少 autogrow 输入 images.image_0（API 格式要求点号前缀）")
print(f"native workflow OK: {len(wf)} nodes")
PY

echo "workflow=$DEST_DIR/moss_edit_native.api.json"
echo "提示：ComfyUI v0.43.0（master 426f5ee）原生支持 MOSS-Image Edit，无需安装 GPL 插件。"

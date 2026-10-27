#!/usr/bin/env bash
# 停止/清理 MOSS-Image-SFT 容器。端口立即释放；模型与 venv 保留在 /mnt/data0。
set -uo pipefail

NAME="${MOSS_IMAGE_CONTAINER:-karen-moss-image}"
podman stop "$NAME" 2>/dev/null || true
podman rm "$NAME" 2>/dev/null || true
echo "stopped/removed $NAME"

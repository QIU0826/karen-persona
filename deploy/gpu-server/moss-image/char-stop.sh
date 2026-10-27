#!/usr/bin/env bash
# 停止/清理人物专用 MOSS 服务（GPU6 18116）；merged 模型与 venv 保留在 /mnt/data0。
set -uo pipefail

NAME="${MOSS_CHARACTER_CONTAINER:-karen-moss-character}"
podman stop "$NAME" 2>/dev/null || true
podman rm "$NAME" 2>/dev/null || true
echo "stopped/removed $NAME"

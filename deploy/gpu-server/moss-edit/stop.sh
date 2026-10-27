#!/usr/bin/env bash
# 停止 MOSS-Image-Edit 服务（不动 GPU6 的 18116 shadow 服务 / GPU7 的 18114）。
set -euo pipefail
NAME="${MOSS_EDIT_CONTAINER:-karen-moss-edit}"
podman stop "$NAME" >/dev/null 2>&1 || true
podman rm "$NAME" >/dev/null 2>&1 || true
echo "stopped/removed $NAME"

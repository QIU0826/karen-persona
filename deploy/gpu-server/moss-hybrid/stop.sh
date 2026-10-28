#!/usr/bin/env bash
# 停止 hybrid wrapper（不影响 18116 MOSS 与 18110 Qwen）。
set -uo pipefail
NAME="${HYBRID_CONTAINER:-karen-moss-hybrid}"
podman stop "$NAME" >/dev/null 2>&1 || true
podman rm "$NAME" >/dev/null 2>&1 || true
echo "stopped/removed $NAME"

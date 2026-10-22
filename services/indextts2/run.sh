#!/usr/bin/env bash
# 启动 IndexTTS2 本地服务（模型权重在仓库外，默认 ~/玩具/index-tts/checkpoints）
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="${INDEXTTS_REPO:-$HOME/玩具/index-tts}"
if [[ ! -x "$REPO/.venv/bin/python" ]]; then
  echo "IndexTTS venv 不存在：$REPO/.venv/bin/python" >&2
  echo "先按 docs/INDEXTTS2.md 安装（uv sync --extra webui）" >&2
  exit 1
fi
export INDEXTTS_REPO="$REPO"
export INDEXTTS_PORT="${INDEXTTS_PORT:-18088}"
export PYTORCH_ENABLE_MPS_FALLBACK="${PYTORCH_ENABLE_MPS_FALLBACK:-1}"
exec "$REPO/.venv/bin/python" "$HERE/server.py"

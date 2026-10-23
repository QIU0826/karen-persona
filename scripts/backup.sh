#!/usr/bin/env bash
# 数据热备份入口：固定项目为 cwd，优先用仓库内 Node 22（launchd 不读 shell 配置）。
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

if [ -x "$ROOT/.runtime/node22/bin/node" ]; then
  NODE="$ROOT/.runtime/node22/bin/node"
else
  NODE="$(command -v node || true)"
fi
if [ -z "${NODE:-}" ]; then
  echo "找不到 node（项目内 .runtime/node22 与 PATH 都没有）" >&2
  exit 1
fi
if [ ! -f "$ROOT/node_modules/tsx/dist/cli.mjs" ]; then
  echo "找不到 tsx，请先在项目根目录 npm install" >&2
  exit 1
fi

# 顺手做日志轮转（launchd 的 bridge/tunnel/embed 日志不自己切割）：
# 超过 5MB 的 *.log 复制一份 .1 后清空原文件（copytruncate，不打断正在写的进程）。
LOG_DIR="$ROOT/data/logs"
if [ -d "$LOG_DIR" ]; then
  find "$LOG_DIR" -maxdepth 1 -type f -name '*.log' -size +5120k -print0 2>/dev/null \
    | while IFS= read -r -d '' logfile; do
        cp "$logfile" "$logfile.1" 2>/dev/null || true
        : > "$logfile" 2>/dev/null || true
      done
fi

exec "$NODE" "$ROOT/node_modules/tsx/dist/cli.mjs" "$ROOT/scripts/backup.ts" "$@"

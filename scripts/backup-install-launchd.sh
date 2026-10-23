#!/usr/bin/env bash
# 安装/卸载 macOS 每日备份任务（P0-1）。
#
# 用法：
#   bash scripts/backup-install-launchd.sh              # 每天 03:30
#   KAREN_BACKUP_HOUR=4 KAREN_BACKUP_MINUTE=10 bash scripts/backup-install-launchd.sh
#   bash scripts/backup-install-launchd.sh --uninstall
#
# 日志：<仓库同级>/karen-backups/launchd.log
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
LABEL="com.karen.persona.backup"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
LOG_DIR="$ROOT/../karen-backups"

if [ "${1:-}" = "--uninstall" ]; then
  launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
  rm -f "$PLIST"
  echo "已卸载每日备份任务（备份文件保留在 $LOG_DIR）"
  exit 0
fi

if [ "$(uname -s)" != "Darwin" ]; then
  echo "该脚本只适用于 macOS；其他系统请用 cron/systemd 调用 scripts/backup.sh" >&2
  exit 1
fi

HOUR="${KAREN_BACKUP_HOUR:-3}"
MINUTE="${KAREN_BACKUP_MINUTE:-30}"
mkdir -p "$HOME/Library/LaunchAgents" "$LOG_DIR"
chmod 700 "$LOG_DIR" 2>/dev/null || true

xml_escape() {
  printf '%s' "$1" | sed -e 's/&/\&amp;/g' -e 's/</\&lt;/g' -e 's/>/\&gt;/g'
}

ROOT_XML="$(xml_escape "$ROOT")"
LOG_XML="$(xml_escape "$LOG_DIR/launchd.log")"

cat > "$PLIST" <<PLIST_EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/bash</string>
    <string>$ROOT_XML/scripts/backup.sh</string>
  </array>
  <key>StartCalendarInterval</key>
  <dict>
    <key>Hour</key><integer>$HOUR</integer>
    <key>Minute</key><integer>$MINUTE</integer>
  </dict>
  <key>StandardOutPath</key><string>$LOG_XML</string>
  <key>StandardErrorPath</key><string>$LOG_XML</string>
  <key>RunAtLoad</key><false/>
  <key>ProcessType</key><string>Background</string>
</dict>
</plist>
PLIST_EOF

plutil -lint "$PLIST" >/dev/null
chmod 644 "$PLIST"
launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$PLIST"

echo "已安装：$PLIST"
echo "计划：每天 $(printf '%02d' "$HOUR"):$(printf '%02d' "$MINUTE")（Mac 睡眠时会在唤醒后补跑）"
echo "日志：$LOG_DIR/launchd.log"
echo "手动跑一次：bash scripts/backup.sh"

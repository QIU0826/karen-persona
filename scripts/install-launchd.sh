#!/usr/bin/env bash
# 安装/卸载 Karen 的 macOS launchd 守护（P0-2）：
#   com.karen.persona.tunnel  SSH 隧道（19102/19110-19113）
#   com.karen.persona.bridge  QQ 桥接（18080/18081/18082）
#   com.karen.persona.embed   本地语义嵌入（18083）
#
# 用法：
#   bash scripts/install-launchd.sh all        # 安装三个（默认）
#   bash scripts/install-launchd.sh tunnel     # 只安装隧道
#   bash scripts/install-launchd.sh bridge     # 只安装桥接
#   bash scripts/install-launchd.sh embed      # 只安装嵌入服务
#   bash scripts/install-launchd.sh --uninstall
#
# 说明：
# - KeepAlive=true：进程崩溃/被杀后 15s 重启；Mac 登录后 RunAtLoad 启动。
# - bridge 先起、NapCat 后连没关系：桥接是 WS 服务端，会等 NapCat 反向连接。
# - 安装 bridge 前请先停掉手动跑的 `npm run qq`，否则端口冲突会反复重启。
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PLIST_DIR="$HOME/Library/LaunchAgents"
LOG_DIR="$ROOT/data/logs"
LABEL_TUNNEL="com.karen.persona.tunnel"
LABEL_BRIDGE="com.karen.persona.bridge"
LABEL_EMBED="com.karen.persona.embed"

xml_escape() {
  printf '%s' "$1" | sed -e 's/&/\&amp;/g' -e 's/</\&lt;/g' -e 's/>/\&gt;/g'
}

uninstall() {
  local label
  for label in "$LABEL_BRIDGE" "$LABEL_TUNNEL" "$LABEL_EMBED"; do
    launchctl bootout "gui/$(id -u)/$label" 2>/dev/null || true
    rm -f "$PLIST_DIR/$label.plist"
  done
  echo "已卸载 Karen launchd 守护（进程已停；数据保留）"
}

install_one() {
  local label="$1"
  local script="$2"
  local log="$3"
  local plist="$PLIST_DIR/$label.plist"
  local root_xml log_xml script_xml
  root_xml="$(xml_escape "$ROOT")"
  log_xml="$(xml_escape "$log")"
  script_xml="$(xml_escape "$script")"

  cat > "$plist" <<PLIST_EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$label</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/bash</string>
    <string>$script_xml</string>
  </array>
  <key>WorkingDirectory</key><string>$root_xml</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>15</integer>
  <key>ExitTimeOut</key><integer>10</integer>
  <key>ProcessType</key><string>Background</string>
  <key>StandardOutPath</key><string>$log_xml</string>
  <key>StandardErrorPath</key><string>$log_xml</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>/usr/bin:/bin:/usr/sbin:/sbin</string>
  </dict>
</dict>
</plist>
PLIST_EOF

  plutil -lint "$plist" >/dev/null
  chmod 644 "$plist"
  launchctl bootout "gui/$(id -u)/$label" 2>/dev/null || true
  launchctl bootstrap "gui/$(id -u)" "$plist"
  echo "已安装：$label -> $script"
  echo "  日志：$log"
}

TARGET="${1:-all}"
case "$TARGET" in
  --uninstall|uninstall)
    uninstall
    exit 0
    ;;
  all|bridge|tunnel|embed) ;;
  *)
    echo "用法：bash scripts/install-launchd.sh [all|bridge|tunnel|embed|--uninstall]" >&2
    exit 1
    ;;
esac

mkdir -p "$PLIST_DIR" "$LOG_DIR"
chmod 700 "$LOG_DIR" 2>/dev/null || true

if [ "$TARGET" = "all" ] || [ "$TARGET" = "tunnel" ]; then
  install_one "$LABEL_TUNNEL" "$ROOT/scripts/gpu-tunnel.sh" "$LOG_DIR/tunnel.log"
fi
if [ "$TARGET" = "all" ] || [ "$TARGET" = "bridge" ]; then
  install_one "$LABEL_BRIDGE" "$ROOT/scripts/start-bridge.sh" "$LOG_DIR/bridge.log"
fi
if [ "$TARGET" = "all" ] || [ "$TARGET" = "embed" ]; then
  install_one "$LABEL_EMBED" "$ROOT/scripts/start-embed.sh" "$LOG_DIR/embed.log"
fi

echo "查看状态：launchctl print gui/$(id -u)/com.karen.persona.bridge | head -20"

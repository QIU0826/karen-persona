/**
 * 本机桌面通知（P0-2）：依赖掉线/恢复时提醒用户，而不是等他发现「她最近不回话」。
 *
 * 只支持 macOS（osascript）；失败静默，绝不影响桥接。可用 `KAREN_DESKTOP_NOTIFY=off` 关闭。
 */
import { execFile } from "node:child_process";

function escapeAppleScript(text: string): string {
  return text.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

/** 桌面通知是否开启（默认开）。 */
export function isDesktopNotifyEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return (env.KAREN_DESKTOP_NOTIFY ?? "on").trim().toLowerCase() !== "off";
}

/**
 * 弹一条 macOS 通知。返回是否真的发出（非 darwin/被关闭/调用失败为 false）。
 * 不抛异常。
 */
export function notifyDesktop(title: string, message: string): boolean {
  if (process.platform !== "darwin") return false;
  if (!isDesktopNotifyEnabled()) return false;
  const script = `display notification "${escapeAppleScript(message)}" with title "${escapeAppleScript(title)}"`;
  try {
    execFile("osascript", ["-e", script], { timeout: 4000 }, () => undefined);
    return true;
  } catch {
    return false;
  }
}

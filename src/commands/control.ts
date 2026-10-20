/**
 * 治理命令（/why /pause /resume /export /stats /help）。
 *
 * 设计：QQ 桥接与 CLI 共用同一套命令语义；通过 ControlDeps 注入回复/持久化/导出能力，
 * 避免命令层直接依赖 bridge（防止循环依赖），也方便测试。
 */
import { describeEmotion } from "../persona/emotion.js";
import { closenessLabel } from "../persona/relationship.js";
import { getStateSummary, type ConversationState } from "../pipeline/orchestrator.js";
import { buildAboutText } from "../persona/disclosure.js";

export interface ExportSummary {
  path: string;
  counts: { messages: number; memories: number; relationshipEvents: number };
}

export interface ControlDeps {
  reply(text: string): void;
  persist(): void;
  exportData(): ExportSummary;
}

export interface ParsedCommand {
  name: string;
  arg?: string;
}

export function parseControlCommand(text: string): ParsedCommand | null {
  const trimmed = text.trim();
  if (!trimmed.startsWith("/")) return null;
  const [rawName, ...rest] = trimmed.slice(1).split(/\s+/);
  if (!rawName) return null;
  return {
    name: rawName.toLowerCase(),
    arg: rest.join(" ").trim().toLowerCase() || undefined,
  };
}

function fmtHour(h: number): string {
  const hour = Math.floor(h);
  const minute = Math.round((h - hour) * 60);
  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}

/** 解释上一轮消息门为什么这样回（可解释性）。 */
export function buildWhyText(state: ConversationState): string {
  const gate = state.lastGate;
  const lines: string[] = ["【最近一次消息门裁决】"];

  if (!gate) {
    lines.push("还没有记录（从下一次消息开始会记录）。");
  } else {
    const when = new Date(gate.at).toLocaleString("zh-CN", { hour12: false });
    const label =
      gate.action === "reply" ? "正常回复" : gate.action === "delay" ? "晚点回复" : "这一轮没有回";
    lines.push(`${label}（${when}）`);
    lines.push(`原因：${gate.reason}`);
    if (gate.action === "delay" && gate.remainingMs) {
      lines.push(`预计补回：约 ${Math.max(1, Math.round(gate.remainingMs / 60000))} 分钟后`);
    }
  }

  lines.push("", "【她现在的处境】");
  lines.push(
    `亲密度：${state.relationshipState.closeness.toFixed(1)}（${closenessLabel(state.relationshipState.closeness)}）`,
  );
  lines.push(`情绪：${describeEmotion(state.emotionState)}（${state.emotionState.vector.toFixed(2)}）`);

  const todayStart = new Date(new Date().getFullYear(), new Date().getMonth(), new Date().getDate()).getTime();
  const todayCount = state.session.messages.filter(
    (m) => m.role === "user" && m.timestamp >= todayStart,
  ).length;
  lines.push(`你今天发过：${todayCount} 条消息`);
  lines.push(
    `免打扰时段：${fmtHour(state.config.quiet_hours_start)}-${fmtHour(state.config.quiet_hours_end)}`,
  );
  lines.push(`主动消息：${state.proactivePaused ? "已暂停（/resume 恢复）" : "开启"}`);
  lines.push(`连续被沉默次数：${state.consecutiveSilences}（≥3 会强制回复一次）`);
  lines.push("", "提示：裁决由「情绪/时间/亲密度/话题/免打扰」共同决定，不是关键词匹配。");
  return lines.join("\n");
}

export function buildPauseText(paused: boolean): string {
  return paused
    ? "已暂停主动消息（她不会突然找你，但你发消息她仍会回）。发送 /resume 恢复。"
    : "已恢复主动消息。她可能隔一段时间自己来找你。";
}

export function buildHelpText(): string {
  return [
    "可用指令：",
    "/why: 解释她上一轮为什么这样回",
    "/stats: 关系/情绪/记忆状态",
    "/pause: 暂停主动消息（仍会回复你的消息）",
    "/resume: 恢复主动消息",
    "/export: 导出你们的对话与记忆备份（JSON）",
    "/about: AI 披露、数据去向、年龄与安全说明",
    "/help: 这条帮助",
  ].join("\n");
}

/** 处理治理命令；不是已知命令返回 false（由调用方决定兜底文案）。 */
export async function handleControlCommand(
  text: string,
  state: ConversationState,
  deps: ControlDeps,
): Promise<boolean> {
  const cmd = parseControlCommand(text);
  if (!cmd) return false;

  switch (cmd.name) {
    case "stats":
      deps.reply(getStateSummary(state).join("\n"));
      return true;
    case "why":
      deps.reply(buildWhyText(state));
      return true;
    case "pause":
      state.proactivePaused = true;
      deps.persist();
      deps.reply(buildPauseText(true));
      return true;
    case "resume":
      state.proactivePaused = false;
      deps.persist();
      deps.reply(buildPauseText(false));
      return true;
    case "export": {
      const result = deps.exportData();
      deps.reply(
        [
          "已导出（JSON，本机 data/ 目录）：",
          `对话 ${result.counts.messages} 条｜记忆 ${result.counts.memories} 条｜关系事件 ${result.counts.relationshipEvents} 条`,
          result.path,
        ].join("\n"),
      );
      return true;
    }
    case "about":
      deps.reply(buildAboutText());
      return true;
    case "help":
      deps.reply(buildHelpText());
      return true;
    default:
      return false;
  }
}

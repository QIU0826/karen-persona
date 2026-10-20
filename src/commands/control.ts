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
import { getConsent } from "../data/consent.js";
import { deleteEpisode, searchEpisodesByKeyword } from "../data/vector.js";

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
    "/forget 关键词: 删除包含关键词的记忆（先预览，加 --yes 才删）",
    "/pause: 暂停主动消息（仍会回复你的消息）",
    "/resume: 恢复主动消息",
    "/export: 导出你们的对话与记忆备份（JSON）",
    "/about: AI 披露、数据去向、年龄与安全说明",
    "/age: 查看年龄确认状态",
    "/help: 这条帮助",
  ].join("\n");
}

export interface ForgetResult {
  keyword: string;
  matched: number;
  deleted: number;
  /** 前几条匹配预览（确认前给用户看） */
  previews: string[];
  requiresConfirm: boolean;
}

const FORGET_MAX_MATCHES = 20;

function previewMemory(content: string, max = 60): string {
  const oneLine = content.replace(/\s+/g, " ").trim();
  return oneLine.length <= max ? oneLine : `${oneLine.slice(0, max)}…`;
}

/**
 * 记忆修正：按关键词删除当前人设的 T2 记忆。
 * - 默认只预览，必须显式带 `--yes` 才真正删除（避免误删）；
 * - 一次最多 20 条；只删 T2，不动会话 JSON / 人格状态。
 */
export function forgetMemories(rawArg: string | undefined, personaId?: string): ForgetResult {
  const text = (rawArg ?? "").trim();
  const requiresConfirmFlag = /(^|\s)--yes$/i.test(text);
  const keyword = text.replace(/(^|\s)--yes$/i, "").trim();
  if (!keyword) {
    return { keyword: "", matched: 0, deleted: 0, previews: [], requiresConfirm: false };
  }
  // 多用户场景：命令处理时全局 current persona 可能停在别的用户身上，必须用本 state 的存储 persona
  const hits = searchEpisodesByKeyword(keyword, FORGET_MAX_MATCHES, personaId);
  if (!requiresConfirmFlag) {
    return {
      keyword,
      matched: hits.length,
      deleted: 0,
      previews: hits.slice(0, 3).map((hit) => previewMemory(hit.content)),
      requiresConfirm: true,
    };
  }
  let deleted = 0;
  for (const hit of hits) {
    if (deleteEpisode(hit.id)) deleted += 1;
  }
  return { keyword, matched: hits.length, deleted, previews: [], requiresConfirm: false };
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
    case "forget": {
      if (!cmd.arg) {
        deps.reply("用法：/forget 关键词 [--yes]（先预览，确认后加 --yes 才删除）");
        return true;
      }
      const result = forgetMemories(cmd.arg, (state as unknown as { storagePersona?: string }).storagePersona);
      if (!result.keyword) {
        deps.reply("用法：/forget 关键词 [--yes]（先预览，确认后加 --yes 才删除）");
        return true;
      }
      if (result.requiresConfirm) {
        if (result.matched === 0) {
          deps.reply(`没有找到包含「${result.keyword}」的记忆。`);
        } else {
          deps.reply(
            [
              `找到 ${result.matched} 条包含「${result.keyword}」的记忆：`,
              ...result.previews.map((line) => `· ${line}`),
              "",
              `确认删除请发送：/forget ${result.keyword} --yes（一次最多 ${FORGET_MAX_MATCHES} 条）`,
            ].join("\n"),
          );
        }
        return true;
      }
      deps.reply(
        result.deleted > 0
          ? `已删除 ${result.deleted} 条包含「${result.keyword}」的记忆（仅本机 T2；可用 /export 先备份）。`
          : `没有找到包含「${result.keyword}」的记忆。`,
      );
      return true;
    }
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
      deps.reply(buildAboutText({ herName: state.persona?.name }));
      return true;
    case "age": {
      const owner = (state as unknown as { owner?: string }).owner ?? "";
      const consent = owner ? getConsent(owner) : null;
      if (consent?.ageConfirmedAt) {
        deps.reply(
          `【年龄确认】已确认（${new Date(consent.ageConfirmedAt).toLocaleString("zh-CN", {
            hour12: false,
          })}）。`,
        );
      } else {
        deps.reply("【年龄确认】尚未确认：继续聊之前回复「我成年了」。");
      }
      return true;
    }
    case "help":
      deps.reply(buildHelpText());
      return true;
    default:
      return false;
  }
}

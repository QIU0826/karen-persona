/**
 * 治理命令（/why /pause /resume /export /stats /help）。
 *
 * 设计：QQ 桥接与 CLI 共用同一套命令语义；通过 ControlDeps 注入回复/持久化/导出能力，
 * 避免命令层直接依赖 bridge（防止循环依赖），也方便测试。
 */
import { describeEmotion } from "../persona/emotion.js";
import { closenessLabel } from "../persona/relationship.js";
import {
  buildProactiveExplain,
  getStateSummary,
  type ConversationState,
} from "../pipeline/orchestrator.js";
import { buildAboutText } from "../persona/disclosure.js";
import { getConsent } from "../data/consent.js";
import {
  buildReflectionStatement,
  PHASE_DURATION_MS,
  REFLECTION_PHASE_LABELS,
} from "../evolution/reflection.js";
import {
  createRelationshipDims,
  derivePhase,
  describeDims,
  behaviorNote,
  PHASE_LABELS,
} from "../persona/relationship-dims.js";
import {
  confirmFact,
  listUserFacts,
  rejectFact,
  type UserFact,
} from "../data/user-facts.js";
import { deleteEpisode, searchEpisodesByKeyword } from "../data/vector.js";
import { readTodayDailyLife } from "../pipeline/orchestrator.js";
import { formatDailyLife } from "../impulse/daily-life.js";

export interface ExportSummary {
  path: string;
  counts: { messages: number; memories: number; relationshipEvents: number };
}

export interface ControlDeps {
  reply(text: string): void;
  persist(): void;
  exportData(): ExportSummary;
  /** /qzone：发 QQ 空间动态；未启用时不传 */
  publishQzone?: (content: string) => Promise<{ ok: boolean; tid?: string; reason?: string }>;
  /** /social：社会化治理命令；未接入时不传 */
  social?: (text: string) => Promise<string | null>;
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
  lines.push(...buildProactiveExplain(state.owner));
  lines.push("", "提示：裁决由「情绪/时间/亲密度/话题/免打扰」共同决定，不是关键词匹配。");
  return lines.join("\n");
}

const FACT_STATUS_LABEL: Record<string, string> = {
  pending: "待确认",
  confirmed: "已确认",
  disputed: "有冲突",
};

/** /fact：列出她"记得的关于你的事"，并标注状态。 */
export function buildFactListText(facts: UserFact[]): string {
  if (facts.length === 0) {
    return "她还没记住关于你的具体事情。多聊聊你自己（工作/城市/宠物/计划），她会慢慢记下来。";
  }
  const lines = facts
    .slice(0, 20)
    .map((f) => {
      const status = (f as unknown as { status?: string }).status ?? "pending";
      return `- ${f.key}：${f.value}（${FACT_STATUS_LABEL[status] ?? status}）`;
    });
  return [
    "【她记得的关于你的事】",
    ...lines,
    "",
    "确认/否认：/fact ok <key> 或 /fact no <key>",
  ].join("\n");
}

/** /reflect：反思循环现状（觉察/嘴硬/认了/慢慢改）。 */
export function buildReflectText(state: ConversationState): string {
  const r = state.reflectionState;
  const lines = [`【反思】${REFLECTION_PHASE_LABELS[r.phase]}`];
  if (r.topic) lines.push(`由头：${r.topic}`);
  if (r.phase !== "none") {
    const stayMin = Math.round((Date.now() - r.phaseSince) / 60000);
    const needMin = Math.round(PHASE_DURATION_MS[r.phase] / 60000);
    lines.push(`这一阶段已停留 ${stayMin} 分钟（该阶段通常 ${needMin} 分钟）`);
    lines.push(`被戳次数：${r.pushCount}`);
    const statement = buildReflectionStatement(r);
    if (statement) lines.push("", `她心里可能是：${statement}`);
  }
  lines.push(
    "",
    "说明：这是「她怎么消化自己的变化」的弧线——先察觉、再嘴硬、被戳够才承认，承认一段时间后才真的改；改过只改一次。",
  );
  if (r.changeApplied) lines.push("她上一轮反思已经改过一次了（基线已回落）。");
  return lines.join("\n");
}

/** /relations：五维关系现状（亲密/信任/互惠/依赖/张力）+ 阶段 + 行为倾向。 */
export function buildRelationsText(state: ConversationState): string {
  const dims = state.relationshipState.dims ?? createRelationshipDims(state.relationshipState.closeness);
  const recentConflict =
    state.relationshipState.lastConflictAt !== null &&
    Date.now() - (state.relationshipState.lastConflictAt ?? 0) < 24 * 3600_000;
  const phase = derivePhase(dims, {
    interactionStreak: state.relationshipState.interactionStreak,
    recentConflict,
  });
  const lines = [
    `【关系现状】${PHASE_LABELS[phase]}`,
    describeDims(dims),
    "",
    `亲密度：${state.relationshipState.closeness.toFixed(2)}/10（原有的门控仍按这个值）`,
    `连续互动：${state.relationshipState.interactionStreak} 天`,
  ];
  const note = behaviorNote(dims, phase);
  if (note) lines.push("", `她现在的状态：${note}`);
  if (dims.tension >= 3) {
    lines.push("", "张力偏高时会自然冷一点；道歉/把话说开能降下来。");
  }
  lines.push("", "提示：五维描述「关系怎么走」，不直接控制回复；亲密度仍决定发图/语音等门槛。");
  return lines.join("\n");
}

/** /life：她今天真实发生的小事（生活流，v0.9.6）。 */
export function buildLifeText(state: ConversationState): string {
  const events = readTodayDailyLife(state);
  if (events.length === 0) {
    return [
      "她今天还没有生活记录（可能还没生成，或模型生成失败）。",
      "说明：每天第一次聊天/心跳时会让她生成「今天发生的小事」，用于主动找你时分享自己的日常。",
    ].join("\n");
  }
  return [
    "【她今天的一天】",
    formatDailyLife(events).split("；").map((line) => `- ${line}`).join("\n"),
    "",
    "说明：这些是她的日常素材——主动消息、回复里的自我暴露都从这里取，避免每天说同一句。",
  ].join("\n");
}

export function buildPauseText(paused: boolean): string {
  return paused
    ? "已暂停主动消息（她不会突然找你，但你发消息她仍会回）。发送 /resume 恢复。"
    : "已恢复主动消息。她可能隔一段时间自己来找你。";
}

export function buildHelpText(): string {
  return [
    "可用指令：",
    "/why: 解释她上一轮为什么这样回、最近为什么没主动找你",
    "/stats: 关系/情绪/记忆状态",
    "/forget 关键词: 删除包含关键词的记忆（先预览，加 --yes 才删）",
    "/pause: 暂停主动消息（仍会回复你的消息）",
    "/resume: 恢复主动消息",
    "/export: 导出你们的对话与记忆备份（JSON）",
    "/about: AI 披露、数据去向、年龄与安全说明",
    "/relations: 五维关系现状（亲密/信任/互惠/依赖/张力）",
    "/reflect: 她的反思弧线（察觉/嘴硬/认了/慢慢改）",
    "/fact: 查看她记得的关于你的事（可确认/否掉）",
    "/life: 她今天真实发生的小事（生活流）",
    "/qzone 内容: 发一条 QQ 空间动态（需 KAREN_QZONE=on）",
    "/social: 看/管理她的 B 站动态、评论、审批与预算",
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
    case "reflect":
      deps.reply(buildReflectText(state));
      return true;
    case "relations":
      deps.reply(buildRelationsText(state));
      return true;
    case "life":
      deps.reply(buildLifeText(state));
      return true;
    case "fact": {
      const owner = state.owner;
      const [action, key] = (cmd.arg ?? "").split(/\s+/).filter(Boolean);
      if (!action) {
        deps.reply(buildFactListText(listUserFacts(owner)));
        return true;
      }
      if ((action === "ok" || action === "no") && key) {
        const changed = action === "ok" ? confirmFact(owner, key) : rejectFact(owner, key);
        deps.reply(
          changed
            ? action === "ok"
              ? `已确认「${key}」，她会记住。`
              : `已否掉「${key}」，她不会再提这个说法。`
            : `没有找到「${key}」这条事实，发送 /fact 查看列表。`,
        );
        return true;
      }
      deps.reply("用法：/fact（列出）｜/fact ok <key>（确认）｜/fact no <key>（否掉）");
      return true;
    }
    case "social": {
      if (!deps.social) {
        deps.reply("高权限社会化未接入：需要先配置 B 站 Cookie 并启用 KAREN_SOCIAL。");
        return true;
      }
      const result = await deps.social(text);
      deps.reply(result ?? "用法见 /social help");
      return true;
    }
    case "qzone": {
      if (!deps.publishQzone) {
        deps.reply("QQ空间动态未启用：先在 .env 设置 KAREN_QZONE=on。");
        return true;
      }
      const content = text.trim().replace(/^\/qzone\s*/i, "").trim();
      if (!content) {
        deps.reply("用法：/qzone 动态正文（可带空格；建议先用自己的号测试）");
        return true;
      }
      const result = await deps.publishQzone(content);
      deps.reply(
        result.ok
          ? `发好了${result.tid ? `（tid: ${result.tid}）` : ""}。`
          : `没发出去：${result.reason ?? "unknown"}`,
      );
      return true;
    }
    case "help":
      deps.reply(buildHelpText());
      return true;
    default:
      return false;
  }
}

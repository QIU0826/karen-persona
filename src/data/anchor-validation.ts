/**
 * 锚点归属/证据校验（P0-4，2026-10-23 真机审计驱动）。
 *
 * 真实库出现过 4 条锚点里至少 2 条归属错误：
 * - `[共同经历] 我和同事一起来吃的` —— 这是**用户**的经历，不是和 Karen 一起；
 * - `[共同经历] 一起吃的鸡杂锅` —— 同上；
 * - `[约定] 工作工作` —— 无信息摘要；
 * - 注入时却写「这些是你们真实经历过的事」→ 她会自然说出「我们上次一起吃过」这种不存在的共同记忆。
 *
 * 本模块在锚点写入前做确定性校验：
 * - 摘要不能是低信息（重复词/太短/字符种类过少）；
 * - `shared_experience` 必须有「双方参与」的语言证据（我们/咱/你/陪/带/一起…，且不能只有“我和别人”）；
 * - `promise` 必须有约定语言证据，不能把泛词当约定；
 * - `first_meet` 必须有相识语言证据，且不能来自她的内心独白/日记（想象不能当事实）；
 * - 其它 kind 也要求内容与摘要同时出现对应证据词。
 *
 * LLM 的 kind 判断仍可能错，这里只做「宁可漏，不可编」的兜底；被拒的候选打 sentinel，
 * 避免第二天重复花 LLM 调用。
 */
import type { AnchorKind } from "./memory-v2.js";

export interface AnchorEvidenceCandidate {
  content: string;
  /** t2_episodes.source：chat / internal_monologue / persona_journal / t3_summary… */
  source?: string;
}

export interface AnchorEvidenceVerdict {
  anchor: boolean;
  kind: AnchorKind | string;
  summary: string;
}

export type AnchorRejectReason =
  | "not_anchor"
  | "summary_empty"
  | "summary_low_info"
  | "kind_invalid"
  | "shared_without_evidence"
  | "promise_without_evidence"
  | "first_meet_without_evidence"
  | "conflict_without_evidence"
  | "makeup_without_evidence"
  | "secret_without_evidence"
  | "loss_without_evidence"
  | "confession_without_evidence";

export interface AnchorValidation {
  ok: boolean;
  reason?: AnchorRejectReason;
  kind?: AnchorKind;
  summary?: string;
}

/** 合法的锚点类型（与 memory-v2.AnchorKind 保持一致）。 */
export const ANCHOR_KINDS: AnchorKind[] = [
  "first_meet",
  "confession",
  "conflict",
  "makeup",
  "promise",
  "secret",
  "shared_experience",
  "loss",
];

const KIND_SET = new Set<string>(ANCHOR_KINDS);

/** 低信息摘要：太短 / 字符种类过少 / 同一个词重复（如「工作工作」）。 */
export function isLowInformationSummary(summary: string): boolean {
  const compact = summary.replace(/\s+/g, "");
  if (compact.length < 4) return true;
  if (new Set(Array.from(compact)).size < 3) return true;
  if (/^(.{1,4})\1+$/.test(compact)) return true;
  return false;
}

function evidence(re: RegExp, text: string): boolean {
  return re.test(text);
}

/**
 * 校验一条 LLM 锚点判定是否可信。纯函数，不碰 DB。
 * 返回 `ok:false + reason` 时调用方应拒绝写库。
 */
export function validateAnchorVerdict(
  candidate: AnchorEvidenceCandidate,
  verdict: AnchorEvidenceVerdict,
): AnchorValidation {
  if (!verdict.anchor) return { ok: false, reason: "not_anchor" };

  const summary = (verdict.summary ?? "").replace(/\s+/g, " ").trim();
  if (!summary) return { ok: false, reason: "summary_empty" };
  if (isLowInformationSummary(summary)) return { ok: false, reason: "summary_low_info" };
  if (!KIND_SET.has(verdict.kind)) return { ok: false, reason: "kind_invalid" };
  const kind = verdict.kind as AnchorKind;
  const content = candidate.content ?? "";

  switch (kind) {
    case "shared_experience": {
      // 「双方参与」：摘要必须能看出“你们一起”；内容里要有第二/第三人称或“我们/咱”，
      // 排除「我和同事/我和朋友」这类只有“我”的经历。
      const sharedInSummary = evidence(/(我们|咱们|咱俩|你|陪|带|一起|和)/, summary);
      const sharedInContent =
        evidence(/(我们|咱们|咱俩|你和我|我和你|和你|跟你|陪你|带你|约好)/, content) ||
        (evidence(/(一起|陪|带)/, content) && evidence(/(他|她|你)/, content));
      if (!sharedInSummary || !sharedInContent) {
        return { ok: false, reason: "shared_without_evidence" };
      }
      break;
    }
    case "promise": {
      // 「想/计划/打算」也算长期计划（金标里「想辞职做独立开发」属于值得记的计划），
      // 但仍要求内容与摘要都有承诺/计划语言，泛词无法通过。
      const commitment =
        /(答应|说好|约好|约了|约在|明天|后天|周末|下周|下次|回头|给你|带你|一起|会|要|想|计划|打算|准备|希望)/;
      if (!evidence(commitment, content) || !evidence(commitment, summary)) {
        return { ok: false, reason: "promise_without_evidence" };
      }
      break;
    }
    case "first_meet": {
      const meeting = /(认识|第一次见|初见|见面|怎么认识|认识多久)/;
      // 摘要必须是“我们/你/我”的相识，而不是第三人称的旁观叙述（容易来自编造）。
      const hasSomeone = /(我们|咱们|你|我)/.test(summary);
      if (!evidence(meeting, content) || !evidence(meeting, summary) || !hasSomeone) {
        return { ok: false, reason: "first_meet_without_evidence" };
      }
      // 她的独白/日记是“想象/叙述”，不能当成事实性的相识来源。
      if (candidate.source === "internal_monologue" || candidate.source === "persona_journal") {
        return { ok: false, reason: "first_meet_without_evidence" };
      }
      break;
    }
    case "conflict": {
      const re = /(吵|生气|不舒服|委屈|越界|冲突|冷战|不理|凶|翻脸|难受)/;
      if (!evidence(re, content) || !evidence(re, summary)) {
        return { ok: false, reason: "conflict_without_evidence" };
      }
      break;
    }
    case "makeup": {
      const re = /(道歉|对不起|和好|原谅|哄|消气|修复)/;
      if (!evidence(re, content) || !evidence(re, summary)) {
        return { ok: false, reason: "makeup_without_evidence" };
      }
      break;
    }
    case "secret": {
      const re = /(秘密|别告诉|不要告诉|只跟你说|别说出去|保密)/;
      if (!evidence(re, content) || !evidence(re, summary)) {
        return { ok: false, reason: "secret_without_evidence" };
      }
      break;
    }
    case "loss": {
      const re = /(去世|走了|离开|失去|离世|葬礼|住院|生病|分手|过世|不在了)/;
      if (!evidence(re, content) || !evidence(re, summary)) {
        return { ok: false, reason: "loss_without_evidence" };
      }
      break;
    }
    case "confession": {
      const re = /(喜欢|表白|爱你|在一起|心动|告白)/;
      if (!evidence(re, content) || !evidence(re, summary)) {
        return { ok: false, reason: "confession_without_evidence" };
      }
      break;
    }
    default:
      return { ok: false, reason: "kind_invalid" };
  }

  return { ok: true, kind, summary };
}

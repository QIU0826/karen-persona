/**
 * 五维关系状态（v0.8）。
 *
 * 为什么：现在只有「亲密度 closeness」一个数——两个人可以同样亲近，但一个信任你、
 * 一个只是热络；一个互惠、一个单方面索取；一个稳定、一个随时会崩。单数值表达不了。
 *
 * 五个维度（0-10）：
 *  - **intimacy 亲密**：愿不愿意说私事、撒娇、分享身体/情绪边界内的东西；
 *  - **trust 信任**：敢不敢把脆弱的一面交出去、信不信对方不评判；
 *  - **tension 张力**：未化解的别捏/不满/戒备（越高越容易冷、越少主动）；
 *  - **reciprocity 互惠**：付出是否对等（她关心你 vs 你关心她；长期失衡会累）；
 *  - **dependency 依赖**：有事第一个想到对方（过高会不安、过低会疏远）。
 *
 * 设计要点：
 * - **纯函数**：事件 → 维度增量；有上限/回落；可单测；
 * - **有记忆性**：tension 会随时间自然回落，但冲突会把它顶上去；
 * - **能解释**：每个维度都有中文标签与一句话说明，供 `/relations` 展示；
 * - **与 closeness 并存**：closeness 仍是门控/发图等既有逻辑的唯一来源，
 *   五维先做"可观察 + 影响措辞"，不改门控，避免大范围联动风险。
 */

export type RelationshipDimension =
  | "intimacy"
  | "trust"
  | "tension"
  | "reciprocity"
  | "dependency";

export interface RelationshipDims {
  intimacy: number;
  trust: number;
  tension: number;
  reciprocity: number;
  dependency: number;
  /** 最近更新时间 */
  updatedAt: number;
}

export const DIMENSION_LABELS: Record<RelationshipDimension, string> = {
  intimacy: "亲密",
  trust: "信任",
  tension: "张力",
  reciprocity: "互惠",
  dependency: "依赖",
};

/** 关系阶段：由五维 + 互动量推导（不是纯数值映射，而是"走到了哪一步"） */
export type RelationshipPhase =
  | "stranger"
  | "acquaintance"
  | "close"
  | "attached"
  | "strained"
  | "repairing";

export const PHASE_LABELS: Record<RelationshipPhase, string> = {
  stranger: "还不熟",
  acquaintance: "开始熟悉",
  close: "亲近",
  attached: "很依赖",
  strained: "有点别扭",
  repairing: "在修好",
};

export function createRelationshipDims(closeness = 3, now = Date.now()): RelationshipDims {
  const base = clamp(closeness, 0, 10);
  return {
    intimacy: round1(base * 0.9),
    trust: round1(base * 0.8),
    tension: 0,
    reciprocity: round1(base * 0.7),
    dependency: round1(base * 0.5),
    updatedAt: now,
  };
}

function clamp(num: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, num));
}

function round1(num: number): number {
  return Math.round(num * 10) / 10;
}

/** 关系事件类型（与现有 relationship.ts 的事件语义对齐，但只关心"对五维的影响"） */
export type DimEventKind =
  | "deep_talk"        // 聊到很深的事
  | "vulnerability"    // 对方暴露脆弱/求助
  | "self_disclosure"  // 她说了自己的私事
  | "conflict"         // 冲突/越界/被凶
  | "apology"          // 道歉/和好
  | "care"             // 对方关心她（记得她说的事/问她累不累）
  | "neglect"          // 长期不回/敷衍
  | "shared_plan"      // 一起约定未来的事
  | "reliance";        // 她有事第一个找他

/** 各事件对五维的增量（正负都允许；tension 越高越糟） */
export const DIM_EVENT_EFFECTS: Record<DimEventKind, Partial<Record<RelationshipDimension, number>>> = {
  deep_talk: { intimacy: 0.4, trust: 0.3, reciprocity: 0.1 },
  vulnerability: { trust: 0.5, intimacy: 0.3, dependency: 0.1 },
  self_disclosure: { intimacy: 0.4, trust: 0.2 },
  conflict: { tension: 1.2, trust: -0.4, intimacy: -0.2 },
  apology: { tension: -1.5, trust: 0.3, intimacy: 0.1 },
  care: { reciprocity: 0.4, trust: 0.2, intimacy: 0.2 },
  neglect: { tension: 0.4, reciprocity: -0.4, dependency: -0.2 },
  shared_plan: { dependency: 0.4, intimacy: 0.2, trust: 0.2 },
  reliance: { dependency: 0.5, intimacy: 0.2 },
};

/**
 * 应用一个事件，返回新的五维。
 * 每个维度都被夹在 0-10；tension 会随时间回落（每条事件顺手衰减一点点）。
 */
export function applyDimEvent(
  dims: RelationshipDims,
  kind: DimEventKind,
  options: { now?: number; intensity?: number } = {},
): RelationshipDims {
  const now = options.now ?? Date.now();
  const intensity = clamp(options.intensity ?? 1, 0.2, 2);
  const effect = DIM_EVENT_EFFECTS[kind] ?? {};
  const next: RelationshipDims = { ...dims, updatedAt: now };

  // 张力自然回落：每次事件更新时，按距上次更新的时间衰减（每小时 0.02，最多 0.3）
  const hours = Math.max(0, (now - dims.updatedAt) / 3_600_000);
  next.tension = clamp(dims.tension - Math.min(0.3, hours * 0.02), 0, 10);

  for (const [key, delta] of Object.entries(effect) as Array<[RelationshipDimension, number]>) {
    next[key] = round1(clamp((next[key] ?? 0) + delta * intensity, 0, 10));
  }
  return next;
}

/** 由五维 + 累计互动天数推导关系阶段。 */
export function derivePhase(
  dims: RelationshipDims,
  opts: { interactionStreak?: number; recentConflict?: boolean } = {},
): RelationshipPhase {
  const streak = opts.interactionStreak ?? 0;
  if (dims.tension >= 6) return "strained";
  if (opts.recentConflict && dims.tension >= 3) return "repairing";
  if (dims.intimacy >= 7 && dims.trust >= 6.5 && dims.dependency >= 5) return "attached";
  if (dims.intimacy >= 5 && (dims.trust >= 4.5 || streak >= 7)) return "close";
  if (dims.intimacy >= 2.5 || streak >= 2) return "acquaintance";
  return "stranger";
}

/** 一句话形容五维现状（供 /relations 与 prompt 使用）。 */
export function describeDims(dims: RelationshipDims): string {
  const parts: string[] = [];
  parts.push(`亲密 ${dims.intimacy.toFixed(1)}`);
  parts.push(`信任 ${dims.trust.toFixed(1)}`);
  parts.push(`互惠 ${dims.reciprocity.toFixed(1)}`);
  parts.push(`依赖 ${dims.dependency.toFixed(1)}`);
  if (dims.tension >= 3) parts.push(`张力 ${dims.tension.toFixed(1)}（还有点别扭）`);
  return parts.join(" · ");
}

/**
 * 行为提示：不同维度组合 → 她该怎么表现（给 prompt 用，一句话）。
 *
 * 原则：不写"你应该…"，写"你现在的状态是…"——保持人设的自主性。
 */
export function behaviorNote(dims: RelationshipDims, phase: RelationshipPhase): string {
  const notes: string[] = [];
  if (phase === "strained") {
    notes.push("你还有点在意上次那件事，话比以前少，不会主动找他");
  } else if (phase === "repairing") {
    notes.push("你在试着把那点别扭翻篇，语气在缓和但还没完全放松");
  }
  if (dims.trust < 3 && phase !== "stranger") {
    notes.push("你还不太敢把心里话全说出来");
  }
  if (dims.reciprocity < 3) {
    notes.push("你有点在意总是自己在关心他，这次不主动追着问");
  }
  if (dims.dependency >= 7) {
    notes.push("你已经习惯有事第一个想到他");
  }
  if (dims.intimacy >= 7 && dims.tension < 2) {
    notes.push("你们现在很放松，可以开点玩笑、说说私事");
  }
  return notes.length > 0 ? notes.join("；") : "";
}

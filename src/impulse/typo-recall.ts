/**
 * 「打字打错 → 撤回 → 重发修正」真实感决策层。
 *
 * 真人发消息偶尔会打错字：先发出去、1-2 秒后发现、撤回、再发一条对的。
 * 本模块只做**纯决策/文本生成**：
 * - 要不要演这一出（开关 / 概率 / 冷却 / 私聊 / 非危机 / 文本是否适合）；
 * - 错字版怎么改（重复字、相邻字互换、常见同音字替换、掉句末标点）；
 * - 修正版 = 原文。
 *
 * 不负责发送/撤回 API（由 bridge 调用 onebot 的 `sendPrivateMsgAsync` +
 * `recallMessage`），也不影响门控与记忆：错字/撤回发生在 transport 层，
 * 记忆里始终只落正确原文。
 *
 * 概率按「每个回复轮最多判定一次」（由 bridge 控制），避免一轮多气泡把
 * 触发率放大若干倍。
 */

export interface TypoRecallSettings {
  /** 总开关（默认 true；Lead 可在 store 里改成 false）。 */
  enabled: boolean;
  /** 每个回复轮触发概率 0-1（默认 0.04）。 */
  probability: number;
  /** 发出错字后多久撤回（默认 1500ms）。 */
  delayMs: number;
  /** 同一用户两次撤回最小间隔（分钟，默认 20；0=不限）。 */
  cooldownMinutes: number;
}

export interface TypoRecallContext {
  /** 本轮要发送的这条文字（单条气泡）。 */
  text: string;
  /** 群聊暂不支持（默认 false）。 */
  isGroup?: boolean;
  /** 危机轮：绝不在安全兜底链路上演撤回。 */
  isCrisis?: boolean;
  /** 本轮已发危机求助资源（bridge 传入；true 时跳过）。 */
  safetySent?: boolean;
  /** 当前时间戳（默认 Date.now()；测试注入固定值）。 */
  now?: number;
}

export interface TypoRecallDeps {
  /** 随机源 0-1（默认 Math.random）。 */
  random?: () => number;
  /** 上次撤回时间（bridge 按用户维护；不传 = 无冷却记录）。 */
  lastRecallAt?: number;
}

export interface TypoRecallPlan {
  /** 是否执行「发错字 → 撤回 → 重发修正」。 */
  recall: boolean;
  /** 稳定原因字符串（日志/测试用）：disabled / group_unsupported / crisis /
   * unsupported_text / cooldown / probability_miss / no_variant / ok */
  reason: string;
  /** 先发出去的错字版本（recall=true 时存在）。 */
  typoText?: string;
  /** 撤回后重发的正确原文（recall=true 时存在）。 */
  correctedText?: string;
  /** 错字保留多久后撤回（毫秒）。 */
  delayMs?: number;
}

/** 默认设置：低频开启（4%），20 分钟冷却。 */
export const DEFAULT_TYPO_RECALL_SETTINGS: TypoRecallSettings = {
  enabled: true,
  probability: 0.04,
  delayMs: 1500,
  cooldownMinutes: 20,
};

/** 适合演「打错字」的文本长度区间（字）。 */
const MIN_TYPO_CHARS = 4;
const MAX_TYPO_CHARS = 40;
/** 撤回延迟 clamp 区间（太快像机器人，太慢用户已经读完）。 */
const MIN_DELAY_MS = 500;
const MAX_DELAY_MS = 5000;

/** 常见输入法/手滑同音字替换（只挑安全、语义不崩坏的组合）。 */
const HOMOPHONE_PAIRS: ReadonlyArray<readonly [string, string]> = [
  ["在", "再"],
  ["再", "在"],
  ["的", "得"],
  ["得", "的"],
  ["做", "作"],
  ["作", "做"],
  ["已", "以"],
  ["以", "已"],
  ["那", "哪"],
  ["哪", "那"],
  ["吧", "罢"],
  ["嘛", "吗"],
  ["吗", "嘛"],
];

const CJK_OR_ALNUM = /[\u4e00-\u9fffA-Za-z0-9]/;
const SPEAKABLE_CONTENT = /[\u4e00-\u9fffA-Za-z0-9]/g;
const SENTENCE_PUNCTUATION = "。！？!?…；;，,、";
const CQ_CODE = /\[CQ:/i;
const URL_LIKE = /(?:https?:\/\/|www\.)/i;

// ── 配置解析 ─────────────────────────────────────

function parseBoolean(value: unknown, fallback: boolean): boolean {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0;
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (["true", "1", "yes", "on", "是"].includes(normalized)) return true;
    if (["false", "0", "no", "off", "否"].includes(normalized)) return false;
  }
  return fallback;
}

function parseNumber(value: unknown, fallback: number): number {
  const num = typeof value === "number" ? value : Number(value);
  return Number.isFinite(num) ? num : fallback;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/**
 * 从 config.yaml 的扁平键解析设置（缺失/非法值回退默认，不抛错）：
 * typo_recall_enabled / typo_recall_probability /
 * typo_recall_delay_ms / typo_recall_cooldown_minutes
 */
export function resolveTypoRecallSettings(
  raw: Record<string, unknown> | undefined,
  defaults: Partial<TypoRecallSettings> = {}
): TypoRecallSettings {
  const base: TypoRecallSettings = { ...DEFAULT_TYPO_RECALL_SETTINGS };
  if (defaults.enabled !== undefined) base.enabled = defaults.enabled;
  if (defaults.probability !== undefined) base.probability = defaults.probability;
  if (defaults.delayMs !== undefined) base.delayMs = defaults.delayMs;
  if (defaults.cooldownMinutes !== undefined) base.cooldownMinutes = defaults.cooldownMinutes;

  const source = raw ?? {};
  return {
    enabled: parseBoolean(source.typo_recall_enabled, base.enabled),
    probability: clamp(parseNumber(source.typo_recall_probability, base.probability), 0, 1),
    delayMs: Math.round(
      clamp(parseNumber(source.typo_recall_delay_ms, base.delayMs), MIN_DELAY_MS, MAX_DELAY_MS)
    ),
    cooldownMinutes: clamp(
      parseNumber(source.typo_recall_cooldown_minutes, base.cooldownMinutes),
      0,
      24 * 60
    ),
  };
}

// ── 文本是否适合演错字 ───────────────────────────

function countChars(text: string): number {
  return Array.from(text).length;
}

/** 单条气泡是否适合演「打错字」：长度合适、无 CQ/URL/换行、有可朗读内容。 */
export function isTypoEligibleText(text: string): boolean {
  if (!text) return false;
  const length = countChars(text);
  if (length < MIN_TYPO_CHARS || length > MAX_TYPO_CHARS) return false;
  if (/[\r\n]/.test(text)) return false;
  if (CQ_CODE.test(text)) return false;
  if (URL_LIKE.test(text)) return false;
  const speakable = text.match(SPEAKABLE_CONTENT) ?? [];
  return speakable.length >= 2;
}

// ── 错字生成 ─────────────────────────────────────

/** 文本里可动手脚的位置（中文/字母/数字，不是标点）。 */
function speakableIndices(chars: string[]): number[] {
  const indices: number[] = [];
  for (let i = 0; i < chars.length; i++) {
    if (CJK_OR_ALNUM.test(chars[i])) indices.push(i);
  }
  return indices;
}

function duplicateChar(chars: string[], random: () => number): string[] | null {
  const indices = speakableIndices(chars);
  if (indices.length === 0) return null;
  const index = indices[Math.min(indices.length - 1, Math.floor(random() * indices.length))];
  const next = [...chars];
  next.splice(index + 1, 0, next[index]);
  return next;
}

function swapAdjacentChars(chars: string[], random: () => number): string[] | null {
  const pairs: Array<[number, number]> = [];
  for (let i = 0; i < chars.length - 1; i++) {
    if (CJK_OR_ALNUM.test(chars[i]) && CJK_OR_ALNUM.test(chars[i + 1]) && chars[i] !== chars[i + 1]) {
      pairs.push([i, i + 1]);
    }
  }
  if (pairs.length === 0) return null;
  const [a, b] = pairs[Math.min(pairs.length - 1, Math.floor(random() * pairs.length))];
  const next = [...chars];
  [next[a], next[b]] = [next[b], next[a]];
  return next;
}

function replaceHomophone(chars: string[], random: () => number): string[] | null {
  const candidates: Array<[number, string]> = [];
  for (let i = 0; i < chars.length; i++) {
    for (const [from, to] of HOMOPHONE_PAIRS) {
      if (chars[i] === from) candidates.push([i, to]);
    }
  }
  if (candidates.length === 0) return null;
  const [index, replacement] =
    candidates[Math.min(candidates.length - 1, Math.floor(random() * candidates.length))];
  const next = [...chars];
  next[index] = replacement;
  return next;
}

function tweakPunctuation(chars: string[], random: () => number): string[] | null {
  const next = [...chars];
  const last = next.length - 1;
  if (last >= 0 && SENTENCE_PUNCTUATION.includes(next[last])) {
    // 掉句末标点（真人发快时常见）
    next.pop();
    return next;
  }
  // 没有标点就补一个语气词（顺手的输入法残留）
  const fillers = ["啊", "呀", "呢"];
  next.push(fillers[Math.min(fillers.length - 1, Math.floor(random() * fillers.length))]);
  return next;
}

const TYPO_STRATEGIES = [duplicateChar, swapAdjacentChars, replaceHomophone, tweakPunctuation];

/**
 * 生成一个「错字版」文本；无法安全生成时返回 null。
 * 保证：结果不等于原文、不引入 CQ 码/URL/换行。
 */
export function introduceTypo(text: string, random: () => number = Math.random): string | null {
  if (!isTypoEligibleText(text)) return null;
  const chars = Array.from(text);
  const start = Math.floor(random() * TYPO_STRATEGIES.length);
  for (let offset = 0; offset < TYPO_STRATEGIES.length; offset++) {
    const strategy = TYPO_STRATEGIES[(start + offset) % TYPO_STRATEGIES.length];
    const next = strategy(chars, random);
    if (!next) continue;
    const candidate = next.join("");
    if (candidate === text) continue;
    if (CQ_CODE.test(candidate) || URL_LIKE.test(candidate) || /[\r\n]/.test(candidate)) continue;
    return candidate;
  }
  return null;
}

// ── 决策 ─────────────────────────────────────────

/**
 * 决定本轮这条气泡要不要演「打错字 → 撤回 → 重发修正」。
 *
 * 顺序：disabled → group_unsupported → crisis → unsupported_text →
 * cooldown → probability_miss → no_variant → ok
 */
export function planTypoRecall(
  ctx: TypoRecallContext,
  settings: TypoRecallSettings,
  deps: TypoRecallDeps = {}
): TypoRecallPlan {
  if (!settings.enabled) return { recall: false, reason: "disabled" };
  if (ctx.isGroup) return { recall: false, reason: "group_unsupported" };
  if (ctx.isCrisis || ctx.safetySent) return { recall: false, reason: "crisis" };

  const text = ctx.text ?? "";
  if (!isTypoEligibleText(text)) return { recall: false, reason: "unsupported_text" };

  const now = ctx.now ?? Date.now();
  const cooldownMs = clamp(parseNumber(settings.cooldownMinutes, 0), 0, 24 * 60) * 60_000;
  if (deps.lastRecallAt !== undefined && cooldownMs > 0) {
    const elapsed = now - deps.lastRecallAt;
    if (elapsed >= 0 && elapsed < cooldownMs) return { recall: false, reason: "cooldown" };
  }

  const probability = clamp(parseNumber(settings.probability, 0), 0, 1);
  const random = deps.random ?? Math.random;
  if (probability <= 0 || random() >= probability) {
    return { recall: false, reason: "probability_miss" };
  }

  const typoText = introduceTypo(text, random);
  if (!typoText) return { recall: false, reason: "no_variant" };

  return {
    recall: true,
    reason: "ok",
    typoText,
    correctedText: text,
    delayMs: Math.round(
      clamp(parseNumber(settings.delayMs, DEFAULT_TYPO_RECALL_SETTINGS.delayMs), MIN_DELAY_MS, MAX_DELAY_MS)
    ),
  };
}

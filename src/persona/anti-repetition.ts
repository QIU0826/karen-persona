/**
 * 跨轮自我重复治理（cross-turn de-duplication）。
 *
 * 问题：QQ 聊天里她连续几轮用同一个开头词、同一句口头禅，或者把上一轮的整句
 * 回应再发一遍，用户会立刻感到"AI 在复读"。单靠静态 prompt 里"不要重复上一轮
 * 开头词"约束不住——模型看不到自己上一轮到底说了什么具体句子。
 *
 * 这里做确定性文本处理：
 * 1. `extractRecentReplies`：从 T0 会话里抽出她最近发过的几条短句；
 * 2. `buildAvoidRepeatNote`：把这批短句 + 重复开头词整理成一段可注入 system
 *    prompt 的「避免重复自己」块（纯文本，~150 token 以内）；
 * 3. `detectRepetition`：回复生成后的相似度检测，供 orchestrator 记日志、
 *    也供评测脚本统计"复读率"。只做检测，不额外调模型。
 *
 * 设计约束：
 * - 纯函数、无 IO、无随机；同一输入永远得到同一输出（可测试、可复现）；
 * - 不改变人设内容，只提醒模型换表达；
 * - 中文按字处理（不依赖分词），用字符 bigram 计算相似度。
 */

import type { ChatMessage } from "../data/history.js";

/** 会话里可能出现的媒体/CQ 码占位符：重复检测只关心文字内容。 */
const MEDIA_OR_CQ = /\[(?:CQ:[^\]]*|图片|语音|表情|贴纸|视频|文件|撤回)\]/g;

/** 首尾的软标点/空白：比较相似度前统一清掉，避免标点差异影响判定。 */
const EDGE_SOFT = /^[\s，,、；;：:。.!！?？…~～]+|[\s，,、；;：:。.!！?？…~～]+$/g;

/** 句内连续空白（含换行）压成单个空格，方便把一条多行回复当整体比较。 */
const INNER_WS = /\s+/g;

/** 默认检查她最近几条消息（通常一轮会发 1-3 条，3 条 ≈ 最近 1-2 轮）。 */
export const DEFAULT_RECENT_REPLY_COUNT = 3;

/** 判定"复读"的综合相似度阈值：0.6 意味着大部分字面重合，正常换句话说不该到。 */
export const DEFAULT_DUPLICATE_THRESHOLD = 0.6;

/** 开头词长度：中文 2 个字就能看出"哈哈""其实""确实"这类口癖。 */
const OPENER_LEN = 2;

/**
 * 「换汤不换药」的套话/固定句式（docs/MEMORY_AI_TONE_AUDIT.md §4.1：
 * 词法复读降到 0 之后，套话命中仍有 0.333）。这些不是整句重复，而是句式复读，
 * 用 bigram 相似度抓不到，需要按句式单独统计并在提示里点名。
 */
const FORMULAIC_PATTERNS: Array<{ label: string; regex: RegExp }> = [
  { label: "是不是…", regex: /是不是/ },
  { label: "要不要…", regex: /要不要/ },
  { label: "有没有…", regex: /有没有/ },
  { label: "我跟你说", regex: /我跟你说/ },
  { label: "其实…", regex: /其实/ },
  { label: "确实…", regex: /确实/ },
  { label: "哈哈…", regex: /哈哈/ },
  { label: "早点…", regex: /早点/ },
  { label: "别太…", regex: /别太/ },
  // 15 轮真实验证里她一轮对话用了 4 次「笑死」，属于口头禅式复读，提醒换说法
  { label: "笑死…", regex: /笑死/ },
];

/**
 * 找出最近几轮里**重复出现 ≥2 次的套话句式**（句式复读，不是整句重复）。
 * 返回人类可读的句式标签（如「是不是…」）。
 */
export function extractRepeatedFormulaicPatterns(recentReplies: string[]): string[] {
  const cleaned = recentReplies
    .map((reply) => normalizeReplyText(reply))
    .filter((reply) => reply.length >= 2)
    .slice(-DEFAULT_RECENT_REPLY_COUNT);
  if (cleaned.length < 2) return [];
  const counts = new Map<string, number>();
  for (const reply of cleaned) {
    for (const pattern of FORMULAIC_PATTERNS) {
      if (pattern.regex.test(reply)) counts.set(pattern.label, (counts.get(pattern.label) ?? 0) + 1);
    }
  }
  return [...counts.entries()]
    .filter(([, count]) => count >= 2)
    .map(([label]) => label);
}

export type RepetitionKind = "exact" | "prefix" | "similar" | "opener" | "none";

export interface RepetitionResult {
  /** 综合相似度 0-1（与最近一条最像的那条的分数） */
  score: number;
  /** 是否达到复读阈值（exact / prefix / similar / 连续同开头都会触发） */
  duplicate: boolean;
  kind: RepetitionKind;
  /** 命中的历史回复（便于日志排查；kind=none 时为空） */
  matched?: string;
  /** 命中的开头词（kind=opener 时有值） */
  opener?: string;
}

/** 去掉 CQ 码/媒体占位符、统一空白、清理首尾软标点。 */
export function normalizeReplyText(text: string): string {
  if (!text) return "";
  return text
    .replace(MEDIA_OR_CQ, "")
    .replace(INNER_WS, " ")
    .replace(EDGE_SOFT, "")
    .trim();
}

/**
 * 从会话消息里抽取她最近发过的短句。
 *
 * - 只看 assistant 消息，按时间从旧到新；
 * - 一条多行回复拆成多个片段（QQ 里本来就是多条气泡发出的）；
 * - 过滤空片段/纯标点/过短片段（长度 < 2 没有比较价值）；
 * - 相邻重复片段去重，最终只保留最后 `count` 条。
 *
 * @param messages T0 会话消息
 * @param count 最多返回几条（默认 3）
 */
export function extractRecentReplies(
  messages: Array<Pick<ChatMessage, "role" | "content">>,
  count: number = DEFAULT_RECENT_REPLY_COUNT,
): string[] {
  if (count <= 0) return [];
  const fragments: string[] = [];
  for (const message of messages) {
    if (message.role !== "assistant") continue;
    // 先按原始换行拆气泡再归一化，否则换行会被压成空格、多条气泡粘成一句
    const raw = message.content.replace(MEDIA_OR_CQ, "");
    for (const part of raw.split(/\n+/)) {
      const fragment = normalizeReplyText(part);
      if (fragment.length < 2) continue;
      // 相邻完全重复（例如模型自己复读）只保留一条
      if (fragments.length > 0 && fragments[fragments.length - 1] === fragment) continue;
      fragments.push(fragment);
    }
  }
  return fragments.slice(-count);
}

/** 取短句开头词（去标点后的前 2 个字），过短的片段不参与开头词统计。 */
function openerOf(text: string): string | null {
  const normalized = normalizeReplyText(text);
  if (normalized.length < OPENER_LEN + 2) return null;
  return normalized.slice(0, OPENER_LEN);
}

/**
 * 反重复提示的两种形态：
 * - `full`：回放最近几条完整短句 + 点名重复开头（信息全，但小模型可能直接照抄）；
 * - `openers`：只给开头片段，不回放整句（更安全，用来 A/B 对比哪种效果更好）。
 */
export type AvoidRepeatMode = "full" | "openers";

/**
 * 构造「避免重复自己」提示块。
 *
 * 默认 `openers`：真实 A/B（3 轮 × 3 组）显示回放整句会让小模型直接照抄自己
 * 上一轮的话（full 组复读对 0→0.33、平均相似度 0.056→0.125），只给开头片段
 * 时复读为 0、相似度反而低于不注入（0.056→0.027）。full 仅留给评测对照。
 *
 * 返回空串表示没有可提醒的内容（例如新会话第一轮）。
 * 输出控制在 ~200 字以内，避免每轮多花太多 token。
 */
export function buildAvoidRepeatNote(
  recentReplies: string[],
  mode: AvoidRepeatMode = "openers",
): string {
  const cleaned = recentReplies
    .map((reply) => normalizeReplyText(reply))
    .filter((reply) => reply.length >= 2)
    .slice(-DEFAULT_RECENT_REPLY_COUNT);
  if (cleaned.length === 0) return "";

  // 同一开头词在最近几句里出现 ≥2 次，才值得点名 banning
  const openerCount = new Map<string, number>();
  for (const reply of cleaned) {
    const opener = openerOf(reply);
    if (!opener) continue;
    openerCount.set(opener, (openerCount.get(opener) ?? 0) + 1);
  }
  const repeatedOpeners = [...openerCount.entries()]
    .filter(([, n]) => n >= 2)
    .map(([opener]) => opener);
  const repeatedPatterns = extractRepeatedFormulaicPatterns(cleaned);

  if (mode === "openers") {
    // 只给开头 3 个字，不把整句回放给模型（回放完整句子时小模型容易直接照抄）
    const openers = [...new Set(cleaned.map((reply) => reply.slice(0, 3).trimEnd()))];
    const lines = [`## 避免重复自己`];
    if (repeatedOpeners.length > 0) {
      lines.push(`「${repeatedOpeners.join("」「")}」这个开头你最近连着用了，这一轮不要再用。`);
    }
    if (repeatedPatterns.length > 0) {
      lines.push(
        `「${repeatedPatterns.join("」「")}」这种句式你最近连着用了，这一轮换成陈述句或别的问法。`,
      );
    }
    lines.push(
      `你最近几轮的开头是「${openers.join("」「")}」。这一轮换一个完全不同的开头和说法；对方重复问同一件事时，换个角度回或直接点破他在复读，不要给上一轮一样的答案。`,
    );
    return `\n${lines.join("\n")}`;
  }

  const excerpt = (text: string): string => (text.length > 24 ? `${text.slice(0, 24)}…` : text);

  const lines = [
    `## 避免重复自己`,
    `你最近发过这些话：`,
    ...cleaned.map((reply) => `- ${excerpt(reply)}`),
  ];
  if (repeatedOpeners.length > 0) {
    lines.push(`「${repeatedOpeners.join("」「")}」这个开头你已经连着用了，这一轮不要再用。`);
  }
  if (repeatedPatterns.length > 0) {
    lines.push(
      `「${repeatedPatterns.join("」「")}」这种句式你最近连着用了，这一轮换成陈述句或别的问法。`,
    );
  }
  lines.push(
    `这一轮换个开头和句式，不要复用上面的短语、口头禅或整句；对方追问同一件事时，换一个角度回，不要复读上一轮。`,
  );
  return `\n${lines.join("\n")}`;
}

/** 字符 bigram 集合（中文按字切，标点与空白在归一化时已清掉）。 */
function bigrams(text: string): Set<string> {
  const set = new Set<string>();
  if (text.length === 1) {
    set.add(text);
    return set;
  }
  for (let i = 0; i < text.length - 1; i++) {
    set.add(text.slice(i, i + 2));
  }
  return set;
}

/** Dice 相似度：2|A∩B| / (|A|+|B|)，对短句比 Jaccard 更稳定。 */
export function bigramSimilarity(a: string, b: string): number {
  const left = normalizeReplyText(a);
  const right = normalizeReplyText(b);
  if (!left || !right) return 0;
  if (left === right) return 1;
  const setA = bigrams(left);
  const setB = bigrams(right);
  let overlap = 0;
  for (const gram of setA) {
    if (setB.has(gram)) overlap++;
  }
  return (2 * overlap) / (setA.size + setB.size);
}

/**
 * 检测一条新回复是否在重复最近的回复。
 *
 * 判定优先级：
 * 1. exact：归一化后完全相同 → 1.0；
 * 2. prefix：一方是另一方的开头（且公共长度 ≥4 字）→ 0.9；
 * 3. similar：字符 bigram 相似度 ≥ 阈值 → 取相似度；
 * 4. opener：开头词与最近回复相同（且最近 3 条里同一开头出现 ≥2 次）→ 0.55，
 *    这种情况句子可能不一样，但口癖连续出现，同样值得提醒。
 */
export function detectRepetition(
  reply: string,
  recentReplies: string[],
  threshold: number = DEFAULT_DUPLICATE_THRESHOLD,
): RepetitionResult {
  const target = normalizeReplyText(reply);
  if (!target) return { score: 0, duplicate: false, kind: "none" };

  const recent = recentReplies
    .map((item) => normalizeReplyText(item))
    .filter((item) => item.length >= 2);

  let best: RepetitionResult = { score: 0, duplicate: false, kind: "none" };
  for (const previous of recent) {
    if (target === previous) {
      return { score: 1, duplicate: true, kind: "exact", matched: previous };
    }
    // 前缀重复：她上一轮说过的长句，这一轮又从头说了一遍
    const shorter = target.length <= previous.length ? target : previous;
    const longer = target.length <= previous.length ? previous : target;
    if (shorter.length >= 4 && longer.startsWith(shorter)) {
      return { score: 0.9, duplicate: true, kind: "prefix", matched: previous };
    }
    const score = bigramSimilarity(target, previous);
    if (score > best.score) {
      best = { score, duplicate: score >= threshold, kind: score >= threshold ? "similar" : "none", matched: previous };
    }
  }
  if (best.duplicate) return best;

  // 开头词连续重复：只统计最近 3 条，避免"语气词"把正常回复误判
  const opener = openerOf(target);
  if (opener) {
    const sameOpenerCount = recent
      .slice(-DEFAULT_RECENT_REPLY_COUNT)
      .filter((item) => openerOf(item) === opener).length;
    if (sameOpenerCount >= 2) {
      return {
        score: 0.55,
        duplicate: true,
        kind: "opener",
        matched: recent[recent.length - 1],
        opener,
      };
    }
  }
  return best;
}

/**
 * 同一轮里已经发过同样/高度相似的话 → 丢弃。
 *
 * 真实验证里出现过一轮里「被说啦 / 气人 / 被说啦？」两条几乎同一句：
 * 流式分条时模型自己会重复，跨轮反重复的提示救不了当轮，所以在出站前做一次当轮去重。
 */
export function isWithinTurnDuplicate(fragment: string, sentFragments: string[]): boolean {
  if (!fragment.trim() || sentFragments.length === 0) return false;
  return detectRepetition(fragment, sentFragments, 0.8).duplicate;
}

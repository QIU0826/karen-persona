/**
 * 回复后处理守卫（确定性，不依赖模型听话）。
 *
 * 背景：prompt 已明令禁止「考我/查岗/抽查/我记性没那么差」这类把记忆变成测试的话术，
 * 但 30 轮真实长跑里仍出现过一次（T9）。模型偶尔不守规则时，用确定性后处理兜底：
 * 把含这些短语的**分句**删掉，保留同一句里其他内容；如果整条都是这种话术，
 * 退化成一句「嗯」，避免把 AI 味发出去。
 *
 * 只在出站前处理，不改人设/记忆；纯函数，便于测试。
 */

/** 记忆防御/考试话术（与 prompt 里的禁用词保持一致）。 */
const DEFLECTION_TEST = /我记性没那么差|我记性没那么好|考考你|考我|查岗|抽查/;
const DEFLECTION_REPLACE = /我记性没那么差|我记性没那么好|考考你|考我|查岗|抽查/g;

/** 分句切分：按中英文标点/换行切开，保留标点（用于拼回）。 */
const CLAUSE_SPLIT = /(?<=[，,。！？!?；;…\n])/;

export interface GuardResult {
  text: string;
  changed: boolean;
  /** 是否整条都被替换成兜底词 */
  fallback: boolean;
}

/**
 * 删除含记忆防御话术的分句；整条都命中时返回「嗯」。
 *
 * 例：
 * - 「接着 林哲啊 才聊过就忘，我记性没那么差」→「接着 林哲啊 才聊过就忘」
 * - 「你这是要考我吗」→「嗯」
 * - 「今天好累啊」→ 原样返回
 */
export function stripMemoryDeflection(reply: string): GuardResult {
  const source = reply ?? "";
  if (!source.trim()) return { text: source, changed: false, fallback: false };
  const original = source;
  if (!DEFLECTION_TEST.test(original)) {
    return { text: original, changed: false, fallback: false };
  }

  const keptLines: string[] = [];
  for (const line of original.split("\n")) {
    const clauses = line.split(CLAUSE_SPLIT);
    const kept = clauses.filter((clause) => !DEFLECTION_TEST.test(clause));
    const joined = kept
      .join("")
      .replace(/^[，,。！？!?；;…\s]+/, "")
      .replace(/[，,、；;…\s]+$/, "")
      .replace(/\s+$/, "");
    if (joined.trim()) keptLines.push(joined.trim());
  }

  let text = keptLines.join("\n").trim();
  if (!text) {
    // 整条都是防御话术：短句直接兜底「嗯」；长句只删短语、保留其余信息
    const compact = original.replace(/[\s，,。！？!?；;…]/g, "");
    if (compact.length <= 12) {
      return { text: "嗯", changed: true, fallback: true };
    }
    text = original
      .replace(DEFLECTION_REPLACE, "")
      .replace(/[，,、；;\s]+/g, " ")
      .trim();
    if (!text) {
      return { text: "嗯", changed: true, fallback: true };
    }
    return { text, changed: true, fallback: false };
  }
  return { text, changed: text !== original.trim(), fallback: false };
}

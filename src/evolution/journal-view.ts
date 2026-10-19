/**
 * 演化可见化（M1-3）— 把后台演化的状态翻译成人类可读的 CLI 文本。
 *
 * 背景：审计报告 4.5 的第 2 条缺口——「基线漂移 / 进化日志 / 内心独白都在后台，
 * 用户看不到，产品上等于不存在」。这里提供 `/journal`、`/timeline`、`/herview`、
 * `/evolution` 四个命令的展示层：
 *
 * - `getJournalEntries()`：从 T2 记忆里取回她的独白 / 进化日志 / T3 长期记忆
 * - 其余 `format*()` 全部是纯函数（不读写磁盘、不联网），方便单测与以后 Web 端复用
 *
 * 输出约定：全中文、简洁、本地时间；空数据给出友好提示；不暴露内部英文枚举。
 */
import { getCurrentPersona, getVectorDb } from "../data/vector.js";
import type { PersistedHerView } from "../data/state-store.js";
import { closenessLabel, type RelationshipState } from "../persona/relationship.js";
import { describeEmotion, type EmotionState } from "../persona/emotion.js";
import type { DriftState } from "./baseline-drift.js";
import type { ArcStage, NarrativeArc } from "./narrative-reconstruct.js";

// ── 日记 / 独白 ────────────────────────────────

/** 会出现在 `/journal` 里的 T2 来源 */
const JOURNAL_SOURCES = ["internal_monologue", "persona_journal", "t3_summary"] as const;

/** 来源 → 中文标签（不把内部英文枚举暴露给用户） */
const SOURCE_LABELS: Record<string, string> = {
  internal_monologue: "独白",
  persona_journal: "进化日志",
  t3_summary: "长期记忆",
};

/** 写入 T2 时加在正文前的标签，展示前剥掉 */
const CONTENT_PREFIXES = ["[独白]", "[T3记忆]", "[进化日志]"];

/** `/journal` 最多一次显示多少条（防止刷屏） */
const JOURNAL_LIMIT_MAX = 100;
/** 单条内容展示上限（超出截断，CLI 里保持一行） */
const JOURNAL_CONTENT_MAX = 140;

export interface JournalEntry {
  /** T2 来源：internal_monologue / persona_journal / t3_summary */
  source: string;
  /** 已剥掉 `[独白]` 等内部前缀的正文 */
  content: string;
  /** 写入时间，ISO 8601（UTC）；展示时转本地时间 */
  createdAt: string;
}

/** 去掉正文前的内部标签（可能叠加，例如 `[T3记忆][独白]` 这种异常数据也能处理） */
export function stripJournalPrefix(content: string): string {
  let text = (content ?? "").trim();
  let changed = true;
  while (changed) {
    changed = false;
    for (const prefix of CONTENT_PREFIXES) {
      if (text.startsWith(prefix)) {
        text = text.slice(prefix.length).trimStart();
        changed = true;
      }
    }
  }
  return text;
}

/** 读取她的日记 / 独白 / T3 长期记忆（按写入时间倒序）。没有数据返回 `[]`。 */
export function getJournalEntries(limit: number = 20): JournalEntry[] {
  const safeLimit = Number.isFinite(limit)
    ? Math.max(1, Math.min(JOURNAL_LIMIT_MAX, Math.floor(limit)))
    : 20;

  const db = getVectorDb();
  const placeholders = JOURNAL_SOURCES.map(() => "?").join(", ");
  const rows = db
    .prepare(
      `SELECT content, source, created_at
         FROM t2_episodes
        WHERE persona_id = ?
          AND source IN (${placeholders})
          AND strength > 0.05
        ORDER BY created_at DESC, id DESC
        LIMIT ?`,
    )
    .all(getCurrentPersona(), ...JOURNAL_SOURCES, safeLimit) as Array<{
    content: string;
    source: string;
    created_at: string;
  }>;

  return rows.map((row) => ({
    source: row.source,
    content: stripJournalPrefix(row.content),
    createdAt: sqliteUtcToIso(row.created_at),
  }));
}

/** `/journal` 的展示文本（纯函数） */
export function formatJournal(entries: readonly JournalEntry[] | null | undefined): string[] {
  const lines = ["她的日记与独白", SEPARATOR];
  const list = entries ?? [];
  if (list.length === 0) {
    lines.push("她最近没有写日记，也没有留下独白。等日子过出点味道来，她可能会写点什么。");
    return lines;
  }

  lines.push(`最近 ${list.length} 条（最新的在前）：`);
  for (const entry of list) {
    const time = formatLocalTime(entry.createdAt);
    const label = SOURCE_LABELS[entry.source] ?? "记录";
    const body = truncate(collapseWhitespace(stripJournalPrefix(entry.content)), JOURNAL_CONTENT_MAX);
    lines.push(`  [${time}] ${label} · ${body || "（这条没写下什么）"}`);
  }
  return lines;
}

// ── 关系时间线 ────────────────────────────────

/** 时间线上最多展示多少条变化 / 里程碑 */
const TIMELINE_EVENT_LIMIT = 8;
const TIMELINE_MILESTONE_LIMIT = 10;

/** `/timeline` 的展示文本（纯函数）。`state` 为空时给友好提示。 */
export function formatRelationshipTimeline(state: RelationshipState | null | undefined): string[] {
  const lines = ["你们的关系", SEPARATOR];
  if (!state) {
    lines.push("还没有关系记录。等你们多聊几句，这里会慢慢长出属于你们的时间线。");
    return lines;
  }

  const meta: string[] = [];
  if (state.interactionStreak > 1) meta.push(`连续互动 ${state.interactionStreak} 天`);
  if (state.lastEvaluatedAt > 0) meta.push(`最近评估 ${formatLocalTime(state.lastEvaluatedAt)}`);
  lines.push(
    `${closenessLabel(state.closeness)}（${state.closeness.toFixed(2)}/10）` +
      (meta.length > 0 ? ` · ${meta.join(" · ")}` : ""),
  );

  const events = state.events ?? [];
  const milestones = state.milestones ?? [];

  if (events.length === 0) {
    lines.push("还没有关系变化记录。关系需要一点时间，也需要几次聊到深处的对话。");
  } else {
    const shown = events.slice(-TIMELINE_EVENT_LIMIT).reverse();
    lines.push(`变化记录（最近 ${shown.length} 条）：`);
    for (const event of shown) {
      const delta = event.delta > 0 ? `+${event.delta.toFixed(3)}` : event.delta.toFixed(3);
      lines.push(
        `  [${formatLocalTime(event.at)}] ${delta} → ${event.closeness.toFixed(2)} · ${event.reason}`,
      );
    }
    if (events.length > shown.length) {
      lines.push(`  （共 ${events.length} 条，这里只显示最近 ${shown.length} 条）`);
    }
  }

  if (milestones.length > 0) {
    const shown = milestones.slice(-TIMELINE_MILESTONE_LIMIT).reverse();
    lines.push(`里程碑（${shown.length} 个）：`);
    for (const milestone of shown) {
      lines.push(
        `  [${formatLocalTime(milestone.at)}] ${milestone.title}（${milestone.closeness.toFixed(2)}/10）`,
      );
    }
  } else if (events.length > 0) {
    lines.push("里程碑：还没到第一个节点——等你们再熟一点，这里会记下来。");
  }

  return lines;
}

// ── 她眼中的你 ────────────────────────────────

/** `/herview` 的展示文本（纯函数）。`view` 为空 / 没写过时给友好提示。 */
export function formatHerView(view: PersistedHerView | null | undefined): string[] {
  const lines = ["她眼中的你", SEPARATOR];
  if (!view || !view.current) {
    if (view?.previous) {
      lines.push(`「${collapseWhitespace(view.previous)}」`);
      lines.push("这是她更早时候的想法，最近还没重新写过。");
    } else {
      lines.push("她还没把对你的看法写下来——也许还太早，也许她还在藏。");
    }
    return lines;
  }

  lines.push(`「${collapseWhitespace(view.current)}」`);
  const meta: string[] = [];
  if (view.lastUpdateAt && view.lastUpdateAt > 0) {
    meta.push(formatLocalTime(view.lastUpdateAt));
    if (Number.isFinite(view.lastUpdateCloseness)) {
      meta.push(`亲密度 ${view.lastUpdateCloseness.toFixed(2)} 时写下`);
    }
  } else {
    meta.push("最初写在人设里的印象，还没再更新过");
  }
  lines.push(`  —— ${meta.join(" · ")}`);

  if (view.previous && view.previous !== view.current) {
    lines.push(`更早的时候她写的是：「${truncate(collapseWhitespace(view.previous), 80)}」`);
  }
  return lines;
}

// ── 演化总览 ──────────────────────────────────

export interface EvolutionSummaryInput {
  drift?: DriftState | null;
  narrativeArc?: NarrativeArc | null;
  relationship?: RelationshipState | null;
  emotion?: EmotionState | null;
}

/** 自我叙事阶段 → 中文（不暴露 none/noticing/denying/admitting 这些内部枚举） */
const ARC_STAGE_LABELS: Record<ArcStage, { label: string; hint: string }> = {
  none: { label: "平稳", hint: "她还没觉得自己有什么变化" },
  noticing: { label: "觉察", hint: "她开始注意到自己有点不一样" },
  denying: { label: "否认", hint: "她还不肯承认，但已经藏不住了" },
  admitting: { label: "承认", hint: "她终于接受了这个变化" },
};

/** `/evolution` 的展示文本（纯函数）。全部字段为空时给友好提示。 */
export function formatEvolutionSummary(
  input: EvolutionSummaryInput | null | undefined,
): string[] {
  const lines = ["她的演化", SEPARATOR];
  const data = input ?? {};
  const hasAny =
    Boolean(data.relationship) ||
    Boolean(data.emotion) ||
    Boolean(data.drift) ||
    Boolean(data.narrativeArc);
  if (!hasAny) {
    lines.push("还没有足够的演化记录。和她多聊几天，再回来看。");
    return lines;
  }

  // 关系
  if (data.relationship) {
    const rel = data.relationship;
    const streak = rel.interactionStreak > 1 ? ` · 连续互动 ${rel.interactionStreak} 天` : "";
    lines.push(`关系：${closenessLabel(rel.closeness)}（${rel.closeness.toFixed(2)}/10）${streak}`);
  } else {
    lines.push("关系：（还没有记录）");
  }

  // 情绪
  if (data.emotion) {
    const emo = data.emotion;
    lines.push(`情绪：${describeEmotion(emo)}（${signed(emo.vector)}）· 情绪波动 ${emo.arousal.toFixed(2)}`);
  } else {
    lines.push("情绪：（还没有记录）");
  }

  // 基线漂移
  if (data.drift) {
    const drift = data.drift;
    const gap = drift.actualBaseline - drift.perceivedBaseline;
    let note = "（她自己心里有数）";
    if (gap > 0.05) note = "（她还没完全察觉）";
    else if (gap < -0.05) note = "（她对自己的感觉比实际乐观一点）";
    lines.push(
      `情绪基线：实际 ${signed(drift.actualBaseline)} / 她以为 ${signed(drift.perceivedBaseline)}${note}`,
    );
  } else {
    lines.push("情绪基线：（还没有记录）");
  }

  // 自我叙事阶段
  if (data.narrativeArc && data.narrativeArc.stage) {
    const stage = ARC_STAGE_LABELS[data.narrativeArc.stage] ?? ARC_STAGE_LABELS.none;
    let direction = "";
    if (data.narrativeArc.stage !== "none" && data.narrativeArc.direction === "positive") {
      direction = "（在往好的方向走）";
    } else if (data.narrativeArc.stage !== "none" && data.narrativeArc.direction === "negative") {
      direction = "（有点往下沉）";
    }
    lines.push(`心理阶段：${stage.label}——${stage.hint}${direction}`);
    if (data.narrativeArc.currentNarrative) {
      lines.push(
        `  她心里的话：「${truncate(collapseWhitespace(data.narrativeArc.currentNarrative), 80)}」`,
      );
    }
  } else {
    lines.push("心理阶段：（还没有记录）");
  }

  return lines;
}

// ── 通用展示工具 ──────────────────────────────

const SEPARATOR = "────────────────────────";

function two(n: number): string {
  return String(n).padStart(2, "0");
}

/** 带符号的数字，便于表达增量（+0.05 / -0.05） */
function signed(n: number, digits: number = 2): string {
  const text = (Object.is(n, -0) ? 0 : n).toFixed(digits);
  return n > 0 ? `+${text}` : text;
}

function collapseWhitespace(text: string): string {
  return (text ?? "").replace(/\s+/g, " ").trim();
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, Math.max(1, max - 1))}…`;
}

/**
 * 解析时间并格式化为本地时间（如 `10-19 22:30`）。
 * - 数字 / Date / ISO 字符串直接按绝对时间解析
 * - SQLite 的 `datetime('now')` 是不带时区的 UTC 文本，这里补 `Z` 后按 UTC 解析，
 *   避免把 UTC 当本地时间导致显示偏 8 小时
 * - 跨年时补上年份
 */
export function formatLocalTime(value: number | string | Date | null | undefined): string {
  const date = toDate(value);
  if (!date) return "时间未知";
  const now = new Date();
  const monthDay = `${two(date.getMonth() + 1)}-${two(date.getDate())} ${two(date.getHours())}:${two(date.getMinutes())}`;
  return date.getFullYear() === now.getFullYear() ? monthDay : `${date.getFullYear()}-${monthDay}`;
}

function toDate(value: number | string | Date | null | undefined): Date | null {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
  if (typeof value === "number") {
    const fromNumber = new Date(value);
    return Number.isNaN(fromNumber.getTime()) ? null : fromNumber;
  }

  const text = value.trim();
  if (!text) return null;
  let iso = text.includes("T") ? text : text.replace(" ", "T");
  if (!/[zZ]$|[+-]\d{2}:?\d{2}$/.test(iso)) {
    iso = /^\d{4}-\d{2}-\d{2}$/.test(iso) ? `${iso}T00:00:00Z` : `${iso}Z`;
  }
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? null : date;
}

/** SQLite UTC 文本 → ISO 8601 字符串（解析失败时原样返回，交给展示层兜底） */
function sqliteUtcToIso(value: string): string {
  const date = toDate(value);
  return date ? date.toISOString() : value;
}

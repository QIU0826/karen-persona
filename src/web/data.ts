/**
 * 本地 Web 控制台数据层（步骤 5，只读）。
 *
 * 职责：把已有的运行数据（会话 / T2 记忆 / 用户事实 / 持久化人格状态 / 关系 / 健康 / 成本）
 * 组装成前端与 API 都能直接消费的 JSON 结构。**不写任何业务数据**：
 * - 只读会话 JSON（loadSession 不存在时返回空会话，不落盘）；
 * - 只读 T2（手写 SQL 全部是 SELECT；不使用 INSERT/UPDATE/DELETE）；
 * - 只读 user_facts（同样手写 SELECT；表不存在时返回空，不建表）；
 * - 只读持久化状态（loadPersonaState）；
 * - 复用现成模块：retriever（混合检索 / 命中回放）、cost-tracker、obs/health-server、journal-view。
 *
 * 人设隔离：默认按当前活跃人设（getCurrentPersona）；桥接进程会把 config.persona 与
 * persona.name 显式传入（两者分别用于 T2 的 persona_id 与 state/session 文件名）。
 * 时间统一返回 ISO 8601（UTC），由页面在浏览器本地时区展示。
 */
import { getCurrentPersona, getVectorDb } from "../data/vector.js";
import { loadPersonaState } from "../data/state-store.js";
import type { PersistedPersonaState } from "../data/state-store.js";
import { loadSession } from "../data/history.js";
import type { ConversationSession } from "../data/history.js";
import { retrieveRelevantMemories, retrieveRelevantMemoriesAsync } from "../data/retriever.js";
import type { RetrievedMemory } from "../data/retriever.js";
import { ownerForQq } from "../data/owner.js";
import { getCostReport, getTodayCostSummary } from "../obs/cost-tracker.js";
import type { CostReport, TodayCostSummary } from "../obs/cost-tracker.js";
import { buildHealthPayload } from "../obs/health-server.js";
import { closenessLabel } from "../persona/relationship.js";
import { describeEmotion } from "../persona/emotion.js";
import { stripJournalPrefix } from "../evolution/journal-view.js";

/** 展示用的当前人设上下文：id 用于 T2 persona_id，name 用于状态/会话文件。 */
export interface WebPersonaContext {
  id: string;
  name: string;
}

export interface WebPersonaOverride {
  id?: string;
  name?: string;
}

/** 默认限制：最近 30 条；上限防止一次拉爆页面。 */
export const DEFAULT_VIEW_LIMIT = 30;
export const MAX_VIEW_LIMIT = 100;

/** 解析当前展示人设：显式传入优先，其次 getCurrentPersona()，最后回退 unknown。 */
export function resolvePersonaContext(override: WebPersonaOverride = {}): WebPersonaContext {
  const text = (value: unknown): string | undefined => {
    if (typeof value !== "string") return undefined;
    const trimmed = value.trim();
    return trimmed === "" ? undefined : trimmed;
  };
  const current = getCurrentPersona();
  const currentId = current && current !== "unknown" ? current : undefined;
  const overrideId = text(override.id);
  const overrideName = text(override.name);
  const id = overrideId ?? currentId ?? overrideName ?? "unknown";
  const name = overrideName ?? overrideId ?? currentId ?? "unknown";
  return { id, name };
}

/** 解析查询参数里的条数（非法值回退默认；夹在 1..max）。 */
export function normalizeLimit(value: unknown, fallback: number, max: number = MAX_VIEW_LIMIT): number {
  const raw = Array.isArray(value) ? value[0] : value;
  const parsed =
    typeof raw === "number"
      ? raw
      : typeof raw === "string" && /^\d+$/.test(raw.trim())
        ? Number(raw.trim())
        : Number.NaN;
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(1, Math.min(max, Math.floor(parsed)));
}

// ── 时间工具（SQLite datetime('now') 是无时区 UTC 文本）──────────

function toDate(value: number | string | null | undefined): Date | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "number") {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? null : date;
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

/** 任意时间输入 → ISO 8601（UTC）；解析失败返回 null。 */
export function toIsoTimestamp(value: number | string | null | undefined): string | null {
  const date = toDate(value);
  return date ? date.toISOString() : null;
}

// ── 用户事实（只读 user_facts）───────────────────

/**
 * 主用户 QQ（与 owner.ts 的 legacy 约定一致）：控制台默认展示他的用户事实。
 * 其他 owner 可通过 `/api/facts?owner=qq:<id>` 指定（本地只读，不写库）。
 */
export const DEFAULT_PRIMARY_QQ = "2889386774";
export const DEFAULT_FACTS_OWNER = ownerForQq(DEFAULT_PRIMARY_QQ);

/** 分类展示顺序（与 data/user-facts 的注入顺序保持一致）。 */
export const FACT_CATEGORY_ORDER = [
  "profile",
  "work",
  "pet",
  "relationship",
  "plan",
  "preference",
  "other",
] as const;

/** user_facts.category → 中文标签（页面渲染与服务端内联 JS 共用；未知分类统一归「其他」）。 */
export const FACT_CATEGORY_LABELS: Record<string, string> = {
  profile: "基本信息",
  work: "工作",
  pet: "宠物",
  relationship: "关系",
  plan: "最近计划",
  preference: "偏好",
  other: "其他",
};

export interface UserFactItem {
  key: string;
  value: string;
  category: string;
  updatedAt: string | null;
}

export interface UserFactsData {
  ok: true;
  generated_at: string;
  owner: string;
  count: number;
  items: UserFactItem[];
  /** 分类计数：{ profile: 2, work: 1, ... }，空数据为 {}。 */
  categories: Record<string, number>;
}

interface UserFactRow {
  fact_key: string;
  fact_value: string;
  category: string;
  updated_at: number | string | null;
}

/** 分类排序（未知分类排在末尾）。 */
function factCategoryRank(category: string): number {
  const index = FACT_CATEGORY_ORDER.indexOf(category as (typeof FACT_CATEGORY_ORDER)[number]);
  return index >= 0 ? index : FACT_CATEGORY_ORDER.length;
}

/**
 * 手写只读 SELECT（刻意不调用 data/user-facts.listUserFacts）：
 * listUserFacts 内部 ensureTable 会 CREATE TABLE，而 Web 控制台必须保持零写入；
 * 这里先查 sqlite_master，表不存在直接返回空。
 */
function readUserFactRows(owner: string): UserFactRow[] {
  const db = getVectorDb();
  const exists = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'user_facts'")
    .get();
  if (!exists) return [];
  return db
    .prepare(
      `SELECT fact_key, fact_value, category, updated_at
         FROM user_facts
        WHERE owner_id = ?`,
    )
    .all(owner) as UserFactRow[];
}

/**
 * 某个 owner 的结构化事实（名字/工作/宠物/偏好/计划…）。
 * 只读；表不存在、空 owner、DB 异常都返回空结构（控制台不能因此 500）。
 */
export function getUserFactsData(owner: string = DEFAULT_FACTS_OWNER): UserFactsData {
  const ownerId =
    typeof owner === "string" && owner.trim() !== "" ? owner.trim() : DEFAULT_FACTS_OWNER;

  let items: UserFactItem[] = [];
  try {
    items = readUserFactRows(ownerId).map((row) => {
      const category =
        typeof row.category === "string" && row.category in FACT_CATEGORY_LABELS
          ? row.category
          : "other";
      return {
        key: typeof row.fact_key === "string" ? row.fact_key : "",
        value: typeof row.fact_value === "string" ? row.fact_value : "",
        category,
        updatedAt: toIsoTimestamp(row.updated_at),
      };
    });
  } catch {
    items = [];
  }

  // 分类分组优先，同分类内最新在前（API 返回顺序稳定，页面直接渲染）
  items.sort((a, b) => {
    const rank = factCategoryRank(a.category) - factCategoryRank(b.category);
    if (rank !== 0) return rank;
    return (b.updatedAt ?? "").localeCompare(a.updatedAt ?? "");
  });

  const categories: Record<string, number> = {};
  for (const item of items) {
    categories[item.category] = (categories[item.category] ?? 0) + 1;
  }

  return {
    ok: true,
    generated_at: new Date().toISOString(),
    owner: ownerId,
    count: items.length,
    items,
    categories,
  };
}

// ── 记忆 ────────────────────────────────────────

/** T2 来源 → 中文标签（页面只展示中文，不暴露内部英文枚举）。 */
const SOURCE_LABELS: Record<string, string> = {
  chat: "对话",
  event: "事件",
  causal_chain: "事件链",
  internal_monologue: "独白",
  persona_journal: "进化日志",
  t3_summary: "长期记忆",
  user_trace: "用户痕迹",
};

export function sourceLabel(source: string): string {
  return SOURCE_LABELS[source] ?? "记录";
}

const CONFIDENCE_LABELS: Record<string, string> = {
  high: "高相关",
  medium: "中相关",
  low: "弱相关",
};

export interface MemoryItem {
  id: number;
  source: string;
  source_label: string;
  content: string;
  strength: number;
  emotional_weight: number;
  created_at: string | null;
}

export interface MemoryListData {
  ok: true;
  generated_at: string;
  persona: WebPersonaContext;
  limit: number;
  total: number;
  items: MemoryItem[];
}

interface EpisodeRow {
  id: number;
  content: string;
  source: string;
  strength: number;
  emotional_weight: number;
  created_at: string | null;
}

function toMemoryItem(row: EpisodeRow): MemoryItem {
  return {
    id: row.id,
    source: row.source,
    source_label: sourceLabel(row.source),
    content: stripJournalPrefix(row.content),
    strength: Number.isFinite(row.strength) ? row.strength : 0,
    emotional_weight: Number.isFinite(row.emotional_weight) ? row.emotional_weight : 0,
    created_at: toIsoTimestamp(row.created_at),
  };
}

/**
 * 最近 T2 记忆（只读 SELECT，按写入时间倒序）。
 * 数据库不可用时返回空列表而不是 500（控制台不能因为空库就白屏）。
 */
export function getRecentMemories(
  limit: number = DEFAULT_VIEW_LIMIT,
  override: WebPersonaOverride = {},
): MemoryListData {
  const persona = resolvePersonaContext(override);
  const safeLimit = normalizeLimit(limit, DEFAULT_VIEW_LIMIT);
  let total = 0;
  let items: MemoryItem[] = [];
  try {
    const db = getVectorDb();
    const countRow = db
      .prepare("SELECT COUNT(*) AS count FROM t2_episodes WHERE persona_id = ? AND strength > 0.05")
      .get(persona.id) as { count?: number } | undefined;
    total = Number(countRow?.count ?? 0);
    const rows = db
      .prepare(
        `SELECT id, content, source, strength, emotional_weight, created_at
           FROM t2_episodes
          WHERE persona_id = ? AND strength > 0.05
          ORDER BY created_at DESC, id DESC
          LIMIT ?`,
      )
      .all(persona.id, safeLimit) as EpisodeRow[];
    items = rows.map(toMemoryItem);
  } catch {
    total = 0;
    items = [];
  }
  return {
    ok: true,
    generated_at: new Date().toISOString(),
    persona,
    limit: safeLimit,
    total,
    items,
  };
}

export interface MemorySearchItem {
  id: number;
  content: string;
  relevance: number;
  strength: number;
  confidence: "high" | "medium" | "low";
  confidence_label: string;
  source: string;
  source_label: string;
}

export interface MemorySearchData {
  ok: true;
  mode: "search";
  generated_at: string;
  persona: WebPersonaContext;
  query: string;
  limit: number;
  items: MemorySearchItem[];
}

/** 批量读取检索结果的 T2 来源（只读 SELECT；按人设过滤，防止跨人设泄露）。 */
function lookupSources(ids: number[], personaId: string): Map<number, string> {
  const map = new Map<number, string>();
  if (ids.length === 0) return map;
  try {
    const db = getVectorDb();
    const placeholders = ids.map(() => "?").join(", ");
    const rows = db
      .prepare(
        `SELECT id, source FROM t2_episodes WHERE persona_id = ? AND id IN (${placeholders})`,
      )
      .all(personaId, ...ids) as Array<{ id: number; source: string }>;
    for (const row of rows) map.set(row.id, row.source);
  } catch {
    // 来源查不到就展示通用标签，不影响搜索结果
  }
  return map;
}

/**
 * 混合检索记忆（复用 retriever.retrieveRelevantMemoriesAsync：n-gram/语义 + FTS5 RRF）。
 * 注意：检索器内部按「当前活跃人设」过滤（getCurrentPersona），无 Key 时自动降级本地 n-gram。
 */
export async function searchMemories(
  query: string,
  limit: number = 10,
  override: WebPersonaOverride = {},
): Promise<MemorySearchData> {
  const persona = resolvePersonaContext(override);
  const safeLimit = normalizeLimit(limit, 10, 20);
  const text = typeof query === "string" ? query.trim().slice(0, 120) : "";

  let memories: RetrievedMemory[] = [];
  if (text) {
    memories = await retrieveRelevantMemoriesAsync(text, safeLimit);
  }

  const sources = lookupSources(
    memories.map((memory) => memory.id),
    persona.id,
  );
  const items: MemorySearchItem[] = memories.map((memory) => {
    const source = sources.get(memory.id) ?? "unknown";
    return {
      id: memory.id,
      content: stripJournalPrefix(memory.content),
      relevance: memory.relevance,
      strength: memory.strength,
      confidence: memory.confidence,
      confidence_label: CONFIDENCE_LABELS[memory.confidence] ?? "相关",
      source,
      source_label: sourceLabel(source),
    };
  });

  return {
    ok: true,
    mode: "search",
    generated_at: new Date().toISOString(),
    persona,
    query: text,
    limit: safeLimit,
    items,
  };
}

// ── 记忆命中回放（同步检索路径）─────────────────

export const MEMORY_PROBE_DEFAULT_LIMIT = 8;
export const MEMORY_PROBE_MAX_LIMIT = 20;
export const MEMORY_PROBE_MAX_QUERY_LENGTH = 200;
/** 页面首屏回放用的示例 query（可在输入框里改成任意关键词）。 */
export const MEMORY_PROBE_SAMPLE_QUERY = "下雨天";

export interface MemoryHit {
  id: number;
  content: string;
  relevance: number;
  confidence: "high" | "medium" | "low";
  confidence_label: string;
  source: string;
  source_label: string;
}

export interface MemoryHitProbeData {
  ok: true;
  generated_at: string;
  persona: WebPersonaContext;
  query: string;
  limit: number;
  hits: MemoryHit[];
}

/**
 * 记忆命中回放：复用 retriever 的同步混合检索（n-gram + FTS5 BM25 → RRF），
 * 返回这次 query 实际会命中哪些 T2、相关度多高、命中来源是什么。
 *
 * 只读边界说明：检索器内部会对命中的记忆应用艾宾浩斯衰减（applyDecay 会 UPDATE
 * strength），这是既有检索路径的副作用，控制台不额外写入任何业务数据。
 * ⚠️ 与 /api/memory 搜索一致：检索按「当前活跃人设」过滤（retriever 用 getCurrentPersona）。
 */
export function getMemoryHitProbe(
  query: string,
  limit: number = MEMORY_PROBE_DEFAULT_LIMIT,
  override: WebPersonaOverride = {},
): MemoryHitProbeData {
  const persona = resolvePersonaContext(override);
  const safeLimit = normalizeLimit(limit, MEMORY_PROBE_DEFAULT_LIMIT, MEMORY_PROBE_MAX_LIMIT);
  const text =
    typeof query === "string" ? query.trim().slice(0, MEMORY_PROBE_MAX_QUERY_LENGTH) : "";

  let memories: RetrievedMemory[] = [];
  if (text) {
    try {
      // 显式传入控制台展示的人设：避免桥接进程当前活跃人设为空（刚重启未聊天）时回放全空
      memories = retrieveRelevantMemories(text, safeLimit, { personaId: persona.id });
    } catch {
      // 记忆库不可用/检索异常：回放面板展示空态，不影响页面其他区块
      memories = [];
    }
  }

  const sources = lookupSources(
    memories.map((memory) => memory.id),
    persona.id,
  );
  const hits: MemoryHit[] = memories.map((memory) => {
    const source = sources.get(memory.id) ?? "unknown";
    return {
      id: memory.id,
      content: stripJournalPrefix(memory.content),
      relevance: memory.relevance,
      confidence: memory.confidence,
      confidence_label: CONFIDENCE_LABELS[memory.confidence] ?? "相关",
      source,
      source_label: sourceLabel(source),
    };
  });

  return {
    ok: true,
    generated_at: new Date().toISOString(),
    persona,
    query: text,
    limit: safeLimit,
    hits,
  };
}

// ── 会话 ────────────────────────────────────────

export interface SessionMessage {
  role: "user" | "assistant";
  content: string;
  timestamp: number | null;
  at: string | null;
}

export interface SessionData {
  ok: true;
  generated_at: string;
  persona: WebPersonaContext;
  limit: number;
  total: number;
  last_active_at: string | null;
  messages: SessionMessage[];
}

/** 最近会话消息（只读 JSON；不存在时返回空会话，不创建文件）。 */
export function getSessionData(
  limit: number = DEFAULT_VIEW_LIMIT,
  override: WebPersonaOverride = {},
): SessionData {
  const persona = resolvePersonaContext(override);
  const safeLimit = normalizeLimit(limit, DEFAULT_VIEW_LIMIT);
  let session: ConversationSession | null = null;
  try {
    session = loadSession(persona.name);
  } catch {
    session = null;
  }
  const all = session?.messages ?? [];
  const messages: SessionMessage[] = all.slice(-safeLimit).map((message) => ({
    role: message.role === "user" ? "user" : "assistant",
    content: message.content,
    timestamp: Number.isFinite(message.timestamp) ? message.timestamp : null,
    at: toIsoTimestamp(message.timestamp),
  }));
  return {
    ok: true,
    generated_at: new Date().toISOString(),
    persona,
    limit: safeLimit,
    total: all.length,
    last_active_at: toIsoTimestamp(session?.lastActiveAt ?? null),
    messages,
  };
}

// ── 关系 / 演化 ─────────────────────────────────

export interface TimelineMilestone {
  title: string;
  closeness: number;
  at: string | null;
}

export interface TimelineEvent {
  at: string | null;
  delta: number;
  closeness: number;
  reason: string;
}

export interface TimelineHerView {
  current: string | null;
  previous: string | null;
  updated_at: string | null;
  updated_closeness: number | null;
}

export interface TimelineEmotion {
  vector: number;
  baseline: number;
  arousal: number;
  label: string;
}

export interface TimelineGuilt {
  guilt: number;
  resentment: number;
}

export interface TimelineDrift {
  actual: number;
  perceived: number;
  pressure: number;
  gap: number;
  alert: string | null;
}

export interface TimelineNarrative {
  stage: string;
  stage_label: string;
  hint: string;
  direction: string | null;
  direction_label: string | null;
  narrative: string | null;
}

export interface TimelineData {
  ok: true;
  generated_at: string;
  persona: WebPersonaContext;
  has_state: boolean;
  state_saved_at: string | null;
  closeness: number;
  label: string;
  interaction_streak: number;
  milestones: TimelineMilestone[];
  events: TimelineEvent[];
  her_view: TimelineHerView;
  emotion: TimelineEmotion | null;
  guilt: TimelineGuilt | null;
  drift: TimelineDrift | null;
  narrative: TimelineNarrative | null;
}

/** 叙事阶段 → 中文（不暴露 none/noticing/denying/admitting 内部枚举）。 */
const ARC_STAGE_LABELS: Record<string, { label: string; hint: string }> = {
  none: { label: "平稳", hint: "她还没觉得自己有什么变化" },
  noticing: { label: "觉察", hint: "她开始注意到自己有点不一样" },
  denying: { label: "否认", hint: "她还不肯承认，但已经藏不住了" },
  admitting: { label: "承认", hint: "她终于接受了这个变化" },
};

const ARC_DIRECTION_LABELS: Record<string, string> = {
  positive: "往好的方向走",
  negative: "有点往下沉",
};

function clampCloseness(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(10, value));
}

/**
 * 关系时间线 + 她眼中的你 + 演化状态。
 * 状态文件不存在时返回初始亲密度 + 空列表（has_state=false），页面展示友好空态。
 */
export function getTimeline(
  override: WebPersonaOverride = {},
  initialCloseness: number = 3,
): TimelineData {
  const persona = resolvePersonaContext(override);
  const fallbackCloseness = clampCloseness(initialCloseness);

  let state: PersistedPersonaState | null = null;
  try {
    state = loadPersonaState(persona.name, fallbackCloseness);
  } catch {
    state = null;
  }

  const relationship = state?.relationship;
  const closeness = clampCloseness(relationship?.closeness ?? fallbackCloseness);
  const events: TimelineEvent[] = (relationship?.events ?? [])
    .slice(-20)
    .reverse()
    .map((event) => ({
      at: toIsoTimestamp(event.at),
      delta: Number.isFinite(event.delta) ? event.delta : 0,
      closeness: clampCloseness(event.closeness),
      reason: event.reason ?? "",
    }));
  const milestones: TimelineMilestone[] = (relationship?.milestones ?? [])
    .slice(-10)
    .reverse()
    .map((milestone) => ({
      title: milestone.title,
      closeness: clampCloseness(milestone.closeness),
      at: toIsoTimestamp(milestone.at),
    }));

  const herView: TimelineHerView = {
    current: state?.herView?.current ?? null,
    previous: state?.herView?.previous ?? null,
    updated_at: toIsoTimestamp(state?.herView?.lastUpdateAt ?? null),
    updated_closeness: Number.isFinite(state?.herView?.lastUpdateCloseness)
      ? Number(state?.herView?.lastUpdateCloseness)
      : null,
  };

  let emotion: TimelineEmotion | null = null;
  if (state?.emotion) {
    emotion = {
      vector: state.emotion.vector,
      baseline: state.emotion.baseline,
      arousal: state.emotion.arousal,
      label: describeEmotion(state.emotion),
    };
  }

  let guilt: TimelineGuilt | null = null;
  if (state?.guilt) {
    guilt = { guilt: state.guilt.guilt, resentment: state.guilt.resentment };
  }

  let drift: TimelineDrift | null = null;
  if (state?.drift) {
    const gap = state.drift.actualBaseline - state.drift.perceivedBaseline;
    let alert: string | null = "她自己也感觉到了";
    if (gap > 0.05) alert = "她还没完全察觉";
    else if (gap < -0.05) alert = "她对自己的感觉比实际乐观一点";
    drift = {
      actual: state.drift.actualBaseline,
      perceived: state.drift.perceivedBaseline,
      pressure: state.drift.pressure,
      gap,
      alert,
    };
  }

  let narrative: TimelineNarrative | null = null;
  if (state?.narrativeArc) {
    const stage = state.narrativeArc.stage ?? "none";
    const labels = ARC_STAGE_LABELS[stage] ?? ARC_STAGE_LABELS.none;
    narrative = {
      stage,
      stage_label: labels.label,
      hint: labels.hint,
      direction: state.narrativeArc.direction ?? null,
      direction_label: state.narrativeArc.direction
        ? (ARC_DIRECTION_LABELS[state.narrativeArc.direction] ?? null)
        : null,
      narrative: state.narrativeArc.currentNarrative ?? null,
    };
  }

  return {
    ok: true,
    generated_at: new Date().toISOString(),
    persona,
    has_state: state !== null,
    state_saved_at: toIsoTimestamp(state?.savedAt ?? null),
    closeness,
    label: closenessLabel(closeness),
    interaction_streak: relationship?.interactionStreak ?? 0,
    milestones,
    events,
    her_view: herView,
    emotion,
    guilt,
    drift,
    narrative,
  };
}

// ── 健康 / 成本 ─────────────────────────────────

export interface HealthDataSourceOptions {
  /** 活跃 WS 连接数（桥接注入；不注入则 0）。 */
  getWsConnections?: () => number;
  /** 待补发回复数（默认从 pending_replies 表统计）。 */
  getPendingReplies?: () => number;
  /** 服务启动时间（uptime 基准）。 */
  startedAt?: number;
}

export interface HealthSummary {
  ok: boolean;
  uptime_seconds: number;
  version: string;
  ws_connections: number;
  db_ok: boolean;
  pending_replies: number;
  cost_today: number;
  last_error: string | null;
}

export interface HealthData {
  ok: true;
  generated_at: string;
  health: HealthSummary;
}

/** 复用 obs/health-server 的组装逻辑（DB 探活 / 队列 / 最近错误 / 今日成本）。 */
export function getHealthData(options: HealthDataSourceOptions = {}): HealthData {
  const payload = buildHealthPayload({
    getWsConnections: options.getWsConnections,
    getPendingReplies: options.getPendingReplies,
    startedAt: options.startedAt,
  });
  return {
    ok: true,
    generated_at: new Date().toISOString(),
    health: {
      ok: payload.ok,
      uptime_seconds: payload.uptime,
      version: payload.version,
      ws_connections: payload.ws_connections,
      db_ok: payload.db_ok,
      pending_replies: payload.pending_replies,
      cost_today: payload.cost_today,
      last_error: payload.last_error,
    },
  };
}

export interface CostData {
  ok: true;
  generated_at: string;
  today: TodayCostSummary;
  week: CostReport;
}

/** 今日 + 最近 N 天成本（复用 cost-tracker；旁路 LLM 未计入，见其文件注释）。 */
export function getCostData(days: number = 7): CostData {
  const windowDays = normalizeLimit(days, 7, 31);
  return {
    ok: true,
    generated_at: new Date().toISOString(),
    today: getTodayCostSummary(),
    week: getCostReport(windowDays),
  };
}

// ── 总览（页面头部 / 首页摘要）─────────────────────

export interface OverviewData {
  ok: true;
  generated_at: string;
  persona: WebPersonaContext;
  session: { messages: number; last_active_at: string | null };
  memory: { total: number; latest_at: string | null };
  relationship: {
    closeness: number;
    label: string;
    interaction_streak: number;
    milestones: number;
    events: number;
  };
  state: { saved_at: string | null; emotion_label: string | null; narrative_stage: string | null };
  health: HealthSummary;
  cost_today: { calls: number; cost_cny: number };
}

export interface ComposeOverviewInput {
  session: SessionData;
  memory: MemoryListData;
  timeline: TimelineData;
  health: HealthData;
  cost: CostData;
}

/** 用已经取过的数据拼总览（页面只查一次各数据源）。 */
export function composeOverview(persona: WebPersonaContext, data: ComposeOverviewInput): OverviewData {
  const { session, memory, timeline, health, cost } = data;
  return {
    ok: true,
    generated_at: new Date().toISOString(),
    persona,
    session: { messages: session.total, last_active_at: session.last_active_at },
    memory: { total: memory.total, latest_at: memory.items[0]?.created_at ?? null },
    relationship: {
      closeness: timeline.closeness,
      label: timeline.label,
      interaction_streak: timeline.interaction_streak,
      milestones: timeline.milestones.length,
      events: timeline.events.length,
    },
    state: {
      saved_at: timeline.state_saved_at,
      emotion_label: timeline.emotion?.label ?? null,
      narrative_stage: timeline.narrative?.stage_label ?? null,
    },
    health: health.health,
    cost_today: { calls: cost.today.calls, cost_cny: cost.today.cost_cny },
  };
}

export interface OverviewOptions {
  initialCloseness?: number;
  health?: HealthDataSourceOptions;
}

/** /api/overview：一次取齐（内部各数据源各自容错，不 500）。 */
export function getOverview(
  override: WebPersonaOverride = {},
  options: OverviewOptions = {},
): OverviewData {
  const persona = resolvePersonaContext(override);
  const session = getSessionData(1, { id: persona.id, name: persona.name });
  const memory = getRecentMemories(1, { id: persona.id, name: persona.name });
  const timeline = getTimeline({ id: persona.id, name: persona.name }, options.initialCloseness ?? 3);
  const health = getHealthData(options.health ?? {});
  const cost = getCostData(7);
  return composeOverview(persona, { session, memory, timeline, health, cost });
}

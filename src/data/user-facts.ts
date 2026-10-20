/**
 * 结构化用户事实记忆（比 T2 向量检索更可靠的「确定记得」层）。
 *
 * 解决：只靠 T2 语义/关键词检索时，用户前面说过的「名字/工作/猫/项目」可能检索不到，
 * 甚至被「她上一轮说不知道」的记忆自我强化。这里用后台 LLM 抽取明确事实，存 SQLite，
 * 每轮以短列表注入 prompt，让她「确定记得」这些事实。
 *
 * 设计：
 * - 只抽取「对方明确说过的关于自己的稳定事实」，不猜、不提取角色自己的话；
 * - 按 owner 隔离（多用户）；
 * - fire-and-forget：抽取失败不影响回复；15 秒内同一 owner 只抽一次，控制成本；
 * - 表结构简单：owner_id + fact_key 唯一，新的值覆盖旧值（比如换工作）；
 * - 覆盖时把旧值写入 `user_fact_history`，注入时对最近变更显示「（之前是：X）」，
 *   让她知道「你以前是 A，现在是 B」，而不是把变化当成没发生过。
 */
import OpenAI from "openai";
import { getVectorDb } from "./vector.js";
import { dbPath } from "./paths.js";
import { getChatModel } from "../ai/router.js";
import { withThinking } from "../ai/chat.js";

export type FactCategory =
  | "profile"
  | "work"
  | "pet"
  | "preference"
  | "plan"
  | "relationship"
  | "other";

export interface UserFact {
  ownerId: string;
  key: string;
  value: string;
  category: FactCategory;
  updatedAt: number;
}

export interface ExtractedFact {
  key: string;
  value: string;
  category: FactCategory;
}

/** 事实变更历史（同 key 覆盖时保留旧值/时间） */
export interface FactHistoryEntry {
  ownerId: string;
  key: string;
  oldValue: string;
  changedAt: number;
}

const CATEGORY_LABELS: Record<FactCategory, string> = {
  profile: "基本信息",
  work: "工作",
  pet: "宠物",
  preference: "偏好",
  plan: "最近计划",
  relationship: "关系",
  other: "其他",
};

const VALID_CATEGORIES = new Set<FactCategory>([
  "profile",
  "work",
  "pet",
  "preference",
  "plan",
  "relationship",
  "other",
]);

/**
 * 建表缓存按「当前 SQLite 文件路径」记录，而不是进程级布尔：
 * 评测/测试会在同一进程里切换 KAREN_DATA_DIR，若只缓存一次，第二个库会缺表。
 */
let tableReadyForPath: string | null = null;

function ensureTable(): void {
  const currentPath = dbPath();
  if (tableReadyForPath === currentPath) return;
  getVectorDb().exec(`
    CREATE TABLE IF NOT EXISTS user_facts (
      owner_id TEXT NOT NULL,
      fact_key TEXT NOT NULL,
      fact_value TEXT NOT NULL,
      category TEXT NOT NULL DEFAULT 'other',
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (owner_id, fact_key)
    );
    CREATE TABLE IF NOT EXISTS user_fact_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      owner_id TEXT NOT NULL,
      fact_key TEXT NOT NULL,
      old_value TEXT NOT NULL,
      changed_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_fact_history_owner_key
      ON user_fact_history(owner_id, fact_key, changed_at DESC);
  `);
  tableReadyForPath = currentPath;
}

/** 解析 LLM 返回的 JSON（兼容 ```json 包裹、多余文本）。 */
export function parseFactsJson(content: string): ExtractedFact[] {
  if (!content) return [];
  let text = content.trim();
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) text = fence[1].trim();
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return [];
  try {
    const parsed = JSON.parse(text.slice(start, end + 1)) as { facts?: unknown };
    const raw = Array.isArray(parsed.facts) ? parsed.facts : [];
    const facts: ExtractedFact[] = [];
    for (const item of raw) {
      if (!item || typeof item !== "object") continue;
      const rec = item as Record<string, unknown>;
      const key = typeof rec.key === "string" ? rec.key.trim().toLowerCase() : "";
      const value = typeof rec.value === "string" ? rec.value.trim() : "";
      if (!key || !value) continue;
      if (key.length > 40 || value.length > 120) continue;
      const category = VALID_CATEGORIES.has(rec.category as FactCategory)
        ? (rec.category as FactCategory)
        : "other";
      facts.push({ key, value, category });
    }
    // 同一 key 去重（保留最后一个）
    const byKey = new Map<string, ExtractedFact>();
    for (const f of facts) byKey.set(f.key, f);
    return Array.from(byKey.values()).slice(0, 12);
  } catch {
    return [];
  }
}

/** 写入/更新事实（同 key 覆盖），返回写入条数。值真变化时把旧值记入历史。 */
export function upsertUserFacts(ownerId: string, facts: ExtractedFact[]): number {
  if (facts.length === 0) return 0;
  ensureTable();
  const db = getVectorDb();
  const stmt = db.prepare(`
    INSERT INTO user_facts (owner_id, fact_key, fact_value, category, updated_at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(owner_id, fact_key) DO UPDATE SET
      fact_value = excluded.fact_value,
      category = excluded.category,
      updated_at = excluded.updated_at
  `);
  const selectExisting = db.prepare(
    `SELECT fact_value FROM user_facts WHERE owner_id = ? AND fact_key = ?`,
  );
  const insertHistory = db.prepare(
    `INSERT INTO user_fact_history (owner_id, fact_key, old_value, changed_at) VALUES (?, ?, ?, ?)`,
  );
  // 每个 key 最多保留最近 20 条旧值，避免无限膨胀
  const trimHistory = db.prepare(`
    DELETE FROM user_fact_history
     WHERE owner_id = ? AND fact_key = ?
       AND id NOT IN (
         SELECT id FROM user_fact_history
          WHERE owner_id = ? AND fact_key = ?
          ORDER BY changed_at DESC, id DESC LIMIT 20
       )
  `);
  const now = Date.now();
  const tx = db.transaction((items: ExtractedFact[]) => {
    for (const f of items) {
      const previous = selectExisting.get(ownerId, f.key) as { fact_value: string } | undefined;
      if (previous && previous.fact_value !== f.value) {
        insertHistory.run(ownerId, f.key, previous.fact_value, now);
        trimHistory.run(ownerId, f.key, ownerId, f.key);
      }
      stmt.run(ownerId, f.key, f.value, f.category, now);
    }
  });
  tx(facts);
  return facts.length;
}

/** 读取某 owner 的全部事实（按分类/时间排序）。 */
export function listUserFacts(ownerId: string): UserFact[] {
  ensureTable();
  const rows = getVectorDb()
    .prepare(
      `SELECT owner_id, fact_key, fact_value, category, updated_at
       FROM user_facts WHERE owner_id = ? ORDER BY updated_at DESC`,
    )
    .all(ownerId) as Array<{
    owner_id: string;
    fact_key: string;
    fact_value: string;
    category: string;
    updated_at: number;
  }>;
  return rows.map((r) => ({
    ownerId: r.owner_id,
    key: r.fact_key,
    value: r.fact_value,
    category: (VALID_CATEGORIES.has(r.category as FactCategory) ? r.category : "other") as FactCategory,
    updatedAt: r.updated_at,
  }));
}

/** 某个 owner 的事实变更历史（最新在前）。 */
export function listFactHistory(ownerId: string, limit: number = 50): FactHistoryEntry[] {
  ensureTable();
  const rows = getVectorDb()
    .prepare(
      `SELECT owner_id, fact_key, old_value, changed_at
         FROM user_fact_history
        WHERE owner_id = ?
        ORDER BY changed_at DESC, id DESC
        LIMIT ?`,
    )
    .all(ownerId, Math.max(1, Math.min(200, Math.floor(limit)))) as Array<{
    owner_id: string;
    fact_key: string;
    old_value: string;
    changed_at: number;
  }>;
  return rows.map((row) => ({
    ownerId: row.owner_id,
    key: row.fact_key,
    oldValue: row.old_value,
    changedAt: row.changed_at,
  }));
}

/**
 * 最近变过的事实（key → 旧值）。注入时对「最近 180 天内变过」的 key 显示
 * 「（之前是：X）」，时间更久的旧值不再展示（避免 prompt 里堆历史）。
 */
export function getRecentFactChanges(
  ownerId: string,
  sinceMs: number = Date.now() - 180 * 24 * 60 * 60 * 1000,
): Map<string, string> {
  ensureTable();
  const rows = getVectorDb()
    .prepare(
      `SELECT fact_key, old_value
         FROM user_fact_history
        WHERE owner_id = ? AND changed_at >= ?
        ORDER BY changed_at ASC, id ASC`,
    )
    .all(ownerId, sinceMs) as Array<{ fact_key: string; old_value: string }>;
  const latest = new Map<string, string>();
  for (const row of rows) latest.set(row.fact_key, row.old_value);
  return latest;
}

/** 注入上限：事实超过这个数时按分类配额挑选，避免某类事实太多把别的挤掉。 */
export const MAX_FACTS_IN_PROMPT = 20;

/** 分类展示顺序（也是配额的选择顺序）。 */
const FACT_CATEGORY_ORDER: FactCategory[] = [
  "profile",
  "work",
  "pet",
  "relationship",
  "plan",
  "preference",
  "other",
];

/**
 * 每个分类的保底展示名额（总和 20）。事实很少时名额会自动回填给其他分类，
 * 所以小数据量下的行为和旧版"按分类排序取前 20"一致；大数据量时保证
 * 工作/宠物/计划等不会因为 profile 事实太多而完全消失。
 */
const FACT_CATEGORY_QUOTA: Record<FactCategory, number> = {
  profile: 4,
  work: 3,
  pet: 3,
  relationship: 3,
  plan: 3,
  preference: 2,
  other: 2,
};

/**
 * 挑选要注入 prompt 的事实（同 key 只留最新）。
 *
 * 旧实现直接按「分类顺序 + 更新时间」取前 20：如果用户说了 25 条 profile 类事实，
 * 工作/宠物/计划会被全部挤掉。现在改为：
 * 1. 核心分类先按配额拿（同类内按更新时间新→旧）；
 * 2. 剩余名额按更新时间全局回填（小数据量时退化为原行为）；
 * 3. 输出前按分类顺序 + 更新时间排序，保持 prompt 稳定。
 */
export function selectFactsForPrompt(
  facts: UserFact[],
  max: number = MAX_FACTS_IN_PROMPT,
): UserFact[] {
  const limit = Math.max(1, Math.floor(max));
  // 同 key 只保留最新
  const byKey = new Map<string, UserFact>();
  for (const fact of facts) {
    const previous = byKey.get(fact.key);
    if (!previous || fact.updatedAt > previous.updatedAt) byKey.set(fact.key, fact);
  }
  const deduped = [...byKey.values()];

  const sortedByTime = (items: UserFact[]): UserFact[] =>
    [...items].sort((a, b) => b.updatedAt - a.updatedAt);

  const picked = new Set<UserFact>();
  for (const category of FACT_CATEGORY_ORDER) {
    const bucket = sortedByTime(deduped.filter((fact) => fact.category === category));
    for (const fact of bucket.slice(0, FACT_CATEGORY_QUOTA[category] ?? 2)) {
      if (picked.size >= limit) break;
      picked.add(fact);
    }
  }
  if (picked.size < limit) {
    for (const fact of sortedByTime(deduped)) {
      if (picked.size >= limit) break;
      picked.add(fact);
    }
  }

  const categoryRank = (category: FactCategory): number => FACT_CATEGORY_ORDER.indexOf(category);
  return [...picked].sort((a, b) => {
    const rank = categoryRank(a.category) - categoryRank(b.category);
    return rank === 0 ? b.updatedAt - a.updatedAt : rank;
  });
}

/** 格式化为 prompt 注入块（≤20 条、≈300 tokens 内）。 */
export function formatUserFacts(
  facts: UserFact[],
  previousChanges?: Map<string, string> | Record<string, string>,
): string {
  if (facts.length === 0) return "";
  const previousLookup = (key: string): string | undefined => {
    if (!previousChanges) return undefined;
    if (previousChanges instanceof Map) return previousChanges.get(key);
    return previousChanges[key];
  };
  const lines = selectFactsForPrompt(facts).map((fact) => {
    const previous = previousLookup(fact.key);
    const changeNote =
      previous && previous !== fact.value ? `（之前是：${previous.slice(0, 30)}）` : "";
    return `- ${CATEGORY_LABELS[fact.category]}：${fact.value}${changeNote}`;
  });
  if (lines.length === 0) return "";
  return `\n## 你确定记得的关于对方的事\n${lines.join("\n")}\n（这些是你真的记得的事实，可以直接自然地用；不确定的别编。）\n`;
}

/** 取某 owner 的事实注入块；DB 异常时静默返回空。 */
export function getUserFactsContext(ownerId: string): string {
  try {
    const facts = listUserFacts(ownerId);
    if (facts.length === 0) return "";
    let previousChanges: Map<string, string> | undefined;
    try {
      previousChanges = getRecentFactChanges(ownerId);
    } catch {
      previousChanges = undefined;
    }
    return formatUserFacts(facts, previousChanges);
  } catch {
    return "";
  }
}

// ── 后台抽取 ──────────────────────────────────

const lastExtractAt = new Map<string, number>();
// 每轮都尝试抽取（单次成本很低）；仅做 1.5s 去重，避免同一条消息重复触发
const EXTRACT_COOLDOWN_MS = 1_500;

function buildExtractPrompt(userInput: string, reply: string): string {
  return [
    "从下面这段聊天里，提取【对方（用户）】明确说过的、关于自己的稳定事实。",
    "规则：",
    "- 只提取对方说的，不要提取角色说的话，也不要重复角色转述；",
    "- 只提取明确陈述（我叫X、我在X工作、我养了X、我在做X、我喜欢X），不要猜测、不要推断；",
    "- 一句话是一件事；value 用简短中文（≤30 字）；",
    "- key 用英文小写下划线，如 name/city/job/company/project/pet/preference/important_date/relationship/plan；",
    "- 如果没有可提取的事实，返回 {\"facts\":[]}。",
    "",
    `用户说：${userInput.slice(0, 500)}`,
    `角色回复（仅参考，不要提取）：${reply.slice(0, 300)}`,
    "",
    '只输出 JSON：{"facts":[{"key":"name","value":"林哲","category":"profile"}]}',
  ].join("\n");
}

/** 后台抽取用户事实（fire-and-forget，不阻塞回复）。 */
export function extractUserFactsAsync(ownerId: string, userInput: string, reply: string): void {
  try {
    if (!userInput || userInput.trim().length < 4) return;
    if (userInput.trim().startsWith("/")) return;
    const now = Date.now();
    const last = lastExtractAt.get(ownerId) ?? 0;
    if (now - last < EXTRACT_COOLDOWN_MS) return;
    lastExtractAt.set(ownerId, now);

    const modelConfig = getChatModel();
    const client = new OpenAI({
      apiKey: modelConfig.apiKey,
      baseURL: modelConfig.baseUrl,
      timeout: 8000,
      maxRetries: 0,
    });
    client.chat.completions
      .create(
        withThinking({
          model: modelConfig.model,
          messages: [
            {
              role: "system",
              content: "你是信息抽取器。只输出 JSON，不要解释。",
            },
            { role: "user", content: buildExtractPrompt(userInput, reply) },
          ],
          temperature: 0,
          max_tokens: 400,
          response_format: { type: "json_object" },
        }) as never,
      )
      .then((resp) => {
        const content = resp.choices[0]?.message?.content;
        if (!content) return;
        const facts = parseFactsJson(content);
        if (facts.length > 0) {
          const written = upsertUserFacts(ownerId, facts);
          console.log(`[事实] 收到 ${written} 条用户事实（${ownerId}）`);
        }
      })
      .catch(() => {
        // 抽取失败不影响对话
      });
  } catch {
    // 忽略
  }
}

/** 测试用：清空抽取节流。 */
export function resetFactExtractionThrottle(): void {
  lastExtractAt.clear();
}

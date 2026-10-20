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
 * - 表结构简单：owner_id + fact_key 唯一，新的值覆盖旧值（比如换工作）。
 */
import OpenAI from "openai";
import { getVectorDb } from "./vector.js";
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

let tableReady = false;

function ensureTable(): void {
  if (tableReady) return;
  getVectorDb().exec(`
    CREATE TABLE IF NOT EXISTS user_facts (
      owner_id TEXT NOT NULL,
      fact_key TEXT NOT NULL,
      fact_value TEXT NOT NULL,
      category TEXT NOT NULL DEFAULT 'other',
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (owner_id, fact_key)
    );
  `);
  tableReady = true;
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

/** 写入/更新事实（同 key 覆盖），返回写入条数。 */
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
  const now = Date.now();
  const tx = db.transaction((items: ExtractedFact[]) => {
    for (const f of items) stmt.run(ownerId, f.key, f.value, f.category, now);
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

/** 格式化为 prompt 注入块（≤20 条、≈300 tokens 内）。 */
export function formatUserFacts(facts: UserFact[]): string {
  if (facts.length === 0) return "";
  // 按分类聚合；同 key 只保留最新
  const seen = new Set<string>();
  const lines: string[] = [];
  const ordered = [...facts].sort((a, b) => {
    const order: FactCategory[] = ["profile", "work", "pet", "relationship", "plan", "preference", "other"];
    const ai = order.indexOf(a.category);
    const bi = order.indexOf(b.category);
    return ai === bi ? b.updatedAt - a.updatedAt : ai - bi;
  });
  for (const f of ordered) {
    if (seen.has(f.key)) continue;
    seen.add(f.key);
    lines.push(`- ${CATEGORY_LABELS[f.category]}：${f.value}`);
    if (lines.length >= 20) break;
  }
  if (lines.length === 0) return "";
  return `\n## 你确定记得的关于对方的事\n${lines.join("\n")}\n（这些是你真的记得的事实，可以直接自然地用；不确定的别编。）\n`;
}

/** 取某 owner 的事实注入块；DB 异常时静默返回空。 */
export function getUserFactsContext(ownerId: string): string {
  try {
    return formatUserFacts(listUserFacts(ownerId));
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

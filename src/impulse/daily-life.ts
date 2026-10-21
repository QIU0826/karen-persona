/**
 * 「她的一天」：每日生活流（v0.9.6）。
 *
 * 问题：v0.9.4/v0.9.5 把主动由头和自我暴露都改成"从她的生活取素材"，
 * 但素材来自 persona.world 的**静态设定**——同一天反复触发会说同一句
 * （「今天店里冷清得能听见咖啡机叹气」），因为她的生活本身没有"今天"。
 *
 * 本模块补上最小闭环：每天用一次小模型调用，基于她的作息/目标/压力源/朋友/天气，
 * 生成 2–3 条"今天发生的具体小事"，存进 daily_life 表；
 * 主动由头、自我暴露、日记忆注入都从**当天**的生活取素材。
 *
 * 纯函数（prompt 构造 / 解析 / 挑选 / 格式化），存储见 src/data/daily-life.ts。
 */

export type DailyLifeKind = "work" | "friend" | "goal" | "cat" | "weather" | "small";

export interface DailyLifeEvent {
  /** 0–23，这件事大概发生在几点 */
  hour: number;
  kind: DailyLifeKind;
  /** 一句话（≤24 字），像她心里记下来的一笔 */
  text: string;
}

export interface DailyLifePlan {
  day: string;
  events: DailyLifeEvent[];
  createdAt: number;
}

export interface DailyLifeWorld {
  socialCircle?: Array<{ name?: string; relation?: string; influence?: string }>;
  dailyRhythm?: Array<{ activity?: string; day?: string; time?: string }>;
  goals?: Array<{ goal?: string; progress?: string }>;
  stressSources?: string[];
}

export const DAILY_LIFE_MAX_EVENTS = 3;
export const DAILY_LIFE_MAX_CHARS = 24;

/**
 * 生成「她今天的一天」的 prompt（纯函数）。
 * 关键约束：只用她世界里的既有设定（作息/目标/压力源/朋友），不许编造新人物；
 * 写具体的小事，不写总结和心情标签。
 */
export function buildDailyLifePrompt(input: {
  herName: string;
  day: string;
  weekday: number;
  world?: DailyLifeWorld | null;
  weather?: { condition?: string; temperature?: number } | null;
}): { system: string; user: string } {
  const world = input.world ?? {};
  const dayNames = ["周一", "周二", "周三", "周四", "周五", "周六", "周日"];
  const dayName = dayNames[input.weekday - 1] ?? "";

  const system = [
    `你在帮角色「${input.herName}」写「她今天真实发生的小事」。`,
    "只输出 JSON，不要解释。",
    '格式：{"events":[{"hour":10,"kind":"work|friend|goal|cat|weather|small","text":"……"}]}',
    "要求：",
    `- 恰好 ${DAILY_LIFE_MAX_EVENTS} 条，分布在上午/下午/晚上（hour 用 0–23 整数）；`,
    `- text 是一条具体的小事（≤${DAILY_LIFE_MAX_CHARS} 字），像她自己随手记的一笔，不写心情标签、不写总结；`,
    "- 只能使用给到的她的人设/作息/目标/朋友/天气，**不要新增任何人物或地点**；",
    "- 小事要有细节（谁说了什么、店里怎样、猫又干了什么），不要泛泛的「上班很累」；",
    "- 不要出现「AI」「用户」「对方」这类词。",
  ].join("\n");

  const user = [
    `日期：${input.day}（${dayName}）`,
    `她的作息：${
      (world.dailyRhythm ?? [])
        .filter((entry) => entry.activity)
        .map((entry) => `${entry.day ?? ""}${entry.time ?? ""} ${entry.activity ?? ""}`.trim())
        .join("；") || "（无）"
    }`,
    `她最近的目标：${
      (world.goals ?? []).map((goal) => `${goal.goal ?? ""}（${goal.progress ?? ""}）`).join("；") || "（无）"
    }`,
    `让她有点烦的事：${(world.stressSources ?? []).join("；") || "（无）"}`,
    `她身边的人：${
      (world.socialCircle ?? [])
        .map((person) => `${person.name ?? ""}（${person.relation ?? ""}）`)
        .join("；") || "（无）"
    }`,
    `天气：${
      input.weather?.condition
        ? `${input.weather.condition}${Number.isFinite(Number(input.weather.temperature)) ? `，${Math.round(Number(input.weather.temperature))} 度` : ""}`
        : "（不知道）"
    }`,
  ].join("\n");

  return { system, user };
}

const KINDS: DailyLifeKind[] = ["work", "friend", "goal", "cat", "weather", "small"];

/** 解析模型输出（容错：代码块/前后说明/字段类型不对都能兜住）。 */
export function parseDailyLife(content: string, day: string, now = Date.now()): DailyLifePlan | null {
  if (!content) return null;
  const start = content.indexOf("{");
  const end = content.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(content.slice(start, end + 1));
  } catch {
    return null;
  }
  const rawEvents = (parsed as { events?: unknown })?.events;
  if (!Array.isArray(rawEvents)) return null;

  const events: DailyLifeEvent[] = [];
  for (const raw of rawEvents.slice(0, DAILY_LIFE_MAX_EVENTS)) {
    const obj = raw as Record<string, unknown>;
    const text = typeof obj.text === "string" ? obj.text.replace(/\s+/g, " ").trim().slice(0, DAILY_LIFE_MAX_CHARS) : "";
    if (!text) continue;
    const hour = Number.isFinite(Number(obj.hour))
      ? Math.min(23, Math.max(0, Math.round(Number(obj.hour))))
      : 12;
    const kind = KINDS.includes(obj.kind as DailyLifeKind) ? (obj.kind as DailyLifeKind) : "small";
    events.push({ hour, kind, text });
  }
  if (events.length === 0) return null;
  events.sort((a, b) => a.hour - b.hour);
  return { day, events, createdAt: now };
}

/** 序列化/反序列化（存库用）。 */
export function serializeDailyLife(plan: DailyLifePlan): string {
  return JSON.stringify({ day: plan.day, events: plan.events, createdAt: plan.createdAt });
}

export function deserializeDailyLife(json: string): DailyLifePlan | null {
  try {
    const parsed = JSON.parse(json) as Partial<DailyLifePlan>;
    if (!Array.isArray(parsed.events)) return null;
    const events = parsed.events
      .filter(
        (event): event is DailyLifeEvent =>
          Boolean(event) && typeof event.text === "string" && event.text.trim().length > 0,
      )
      .map((event) => ({
        hour: Number.isFinite(Number(event.hour)) ? Math.min(23, Math.max(0, Math.round(Number(event.hour)))) : 12,
        kind: KINDS.includes(event.kind) ? event.kind : "small",
        text: event.text.slice(0, DAILY_LIFE_MAX_CHARS),
      }))
      .sort((a, b) => a.hour - b.hour);
    if (events.length === 0) return null;
    return { day: String(parsed.day ?? ""), events, createdAt: Number(parsed.createdAt ?? Date.now()) };
  } catch {
    return null;
  }
}

/** 格式化成给 prompt 用的一行（"09:00 店里…；15:00 …；20:00 …"）。 */
export function formatDailyLife(events: DailyLifeEvent[]): string {
  return events
    .map((event) => `${String(event.hour).padStart(2, "0")}:00 ${event.text}`)
    .join("；");
}

/**
 * 挑一条"此刻可以说"的生活小事：取当前小时之前最近的一条；如果都还没发生，就取第一条。
 * 随机源可注入（同小时多条时随机选一条，避免每轮都同一句）。
 */
export function pickLifeEvent(
  events: DailyLifeEvent[],
  hour: number,
  random: () => number = Math.random,
): DailyLifeEvent | null {
  if (events.length === 0) return null;
  const past = events.filter((event) => event.hour <= hour);
  const pool = past.length > 0 ? past : events.slice(0, 1);
  const index = Math.min(pool.length - 1, Math.floor(random() * pool.length));
  return pool[index] ?? null;
}

/** 转成 buildLifeSignals 用的素材句（她主动想分享时可直接用）。 */
export function dailyLifeToSignals(events: DailyLifeEvent[]): string[] {
  return events.map((event) => event.text);
}

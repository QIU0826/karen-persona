/**
 * T3 长期记忆摘要（P1-3）
 *
 * 将 T2 片段周期性压缩为叙事性摘要。
 * 这是她"跨会话沉淀"的技术基础——不记得每句话，
 * 但记得"那段时间我们聊了什么，我是什么感觉"。
 *
 * 设计：
 * - 每积累 ~100 条 T2 片段触发一次压缩
 * - LLM 将一批片段压缩成 3-5 句叙事摘要
 * - 存回 T2（source: "t3_summary"，half_life: 90 天）
 * - 原片段的 strength 降低（已被"消化"）
 */
import OpenAI from "openai";
import { withThinking } from "../ai/chat.js";
import { recordAuxUsage } from "../ai/aux-usage.js";
import { getChatModel } from "../ai/router.js";
import { getVectorDb, getCurrentPersona, insertEpisode, updateStrength } from "../data/vector.js";
import { generateEmbedding } from "../data/embedding.js";

// ── 阈值 ──────────────────────────────────────

/**
 * 每积累多少条未压缩的 T2 片段触发一次压缩。
 * 原 80 太高：线上长期 0 条摘要（42 条对话一直不压缩），旧对话停留在生片段里，
 * 跨会话长期记忆实际没跑起来。改为 40 条一次。
 */
export const COMPRESSION_BATCH_SIZE = 40;

/** 触发时间兜底：距上一次摘要 ≥1 天且积累了 ≥20 条，也压缩一次（低频聊天也能沉淀） */
export const COMPRESSION_MIN_COUNT = 20;
export const COMPRESSION_MAX_AGE_MS = 24 * 60 * 60 * 1000;

/** T3 摘要的半衰期（天）——比普通记忆更持久 */
const T3_HALF_LIFE_DAYS = 90;

/** 压缩触发判定输入 */
export interface T3CompressDecisionInput {
  /** 当前未压缩的普通片段条数 */
  uncompressedCount: number;
  /** 上次摘要的时间戳（ms）；从未压缩过为 null */
  lastSummaryAtMs: number | null;
  /** 当前时间戳（ms），便于测试注入假时钟 */
  nowMs: number;
}

/**
 * 是否需要触发 T3 压缩（纯函数，可单测）。
 *
 * 规则（满足任一）：
 * 1. 未压缩片段 ≥40 条；
 * 2. 距上次摘要 ≥1 天，且未压缩片段 ≥20 条；
 * 3. 从未压缩过，且片段 ≥40 条（同 1）。
 */
export function shouldCompressT3(input: T3CompressDecisionInput): boolean {
  const count = Number.isFinite(input.uncompressedCount) ? input.uncompressedCount : 0;
  if (count >= COMPRESSION_BATCH_SIZE) return true;
  if (count < COMPRESSION_MIN_COUNT) return false;
  if (input.lastSummaryAtMs === null || !Number.isFinite(input.lastSummaryAtMs)) return false;
  return input.nowMs - input.lastSummaryAtMs >= COMPRESSION_MAX_AGE_MS;
}

/** 读取某个 persona 上次 T3 摘要的时间戳（ms）；没有返回 null。 */
function getLastSummaryAtMs(pid: string): number | null {
  const d = getVectorDb();
  const row = d
    .prepare(
      `SELECT CAST(strftime('%s', created_at) AS INTEGER) AS ts
       FROM t2_episodes
       WHERE persona_id = ? AND source = 't3_summary'
       ORDER BY id DESC LIMIT 1`,
    )
    .get(pid) as { ts: number | null } | undefined;
  const seconds = row?.ts ?? null;
  return seconds && Number.isFinite(seconds) ? seconds * 1000 : null;
}

// ── 压缩逻辑 ──────────────────────────────────

export interface RawEpisode {
  id: number;
  content: string;
  source: string;
  emotional_weight: number;
  created_at: string;
}

export interface T3SummaryPrompts {
  system: string;
  user: string;
  startDate: string;
  endDate: string;
}

/**
 * 统计某个 persona 尚未被 T3 压缩的普通片段数（不含 t3_summary / internal_monologue）。
 * 关键：**必须排除 t3_compressed=1**——压缩后旧片段只是降 strength、不删除，
 * 若仍计入阈值会导致同一批片段被反复压缩、每轮触发一次 LLM 调用。
 */
export function countUncompressedEpisodes(pid: string = getCurrentPersona()): number {
  const d = getVectorDb();
  const row = d.prepare(
    `SELECT COUNT(*) as cnt FROM t2_episodes
     WHERE persona_id = ?
       AND source IN ('chat', 'event', 'causal_chain', 'user_trace')
       AND strength > 0.1
       AND COALESCE(t3_compressed, 0) = 0`
  ).get(pid) as { cnt: number };
  return row?.cnt ?? 0;
}

/**
 * 检查是否需要压缩，如果需要则执行。
 * 在每次 T2 写入后调用。
 */
export function maybeCompressToT3(): void {
  const d = getVectorDb();

  const pid = getCurrentPersona();

  const countRow = { cnt: countUncompressedEpisodes(pid) };

  const lastSummaryAtMs = getLastSummaryAtMs(pid);
  const shouldCompress = shouldCompressT3({
    uncompressedCount: countRow.cnt,
    lastSummaryAtMs,
    nowMs: Date.now(),
  });
  if (!shouldCompress) return;

  // 干跑模式：只打印将要压缩的候选，不调 LLM、不改数据（运维/真数据核对用）
  if (process.env.KAREN_T3_DRY_RUN === "1") {
    const candidates = d.prepare(
      `SELECT id, created_at, substr(content, 1, 60) AS preview FROM t2_episodes
       WHERE persona_id = ?
         AND source IN ('chat', 'event', 'causal_chain', 'user_trace')
         AND strength > 0.1
         AND COALESCE(t3_compressed, 0) = 0
       ORDER BY created_at ASC
       LIMIT ${COMPRESSION_BATCH_SIZE}`,
    ).all(pid) as Array<{ id: number; created_at: string; preview: string }>;
    console.log(
      `[T3][dry-run] 将压缩 ${candidates.length} 条（未压缩 ${countRow.cnt} 条，上次摘要 ${lastSummaryAtMs ? new Date(lastSummaryAtMs).toISOString() : "无"}）`,
    );
    for (const item of candidates.slice(0, 5)) {
      console.log(`  - #${item.id} ${item.created_at} ${item.preview.replace(/\s+/g, " ")}`);
    }
    return;
  }

  // 异步执行压缩，不阻塞
  console.log(
    `[T3] 触发压缩: ${countRow.cnt} 条未压缩片段 (${pid}, 上次摘要 ${lastSummaryAtMs ? "有" : "无"})`,
  );
  runT3Compression(pid, countRow.cnt).catch((err) => {
    console.log(`[T3] 压缩失败: ${err instanceof Error ? err.message : err}`);
  });
}

async function runT3Compression(pid: string, uncompressedCount: number): Promise<void> {
  const d = getVectorDb();

  // 取最旧的未压缩片段：时间兜底触发时可能不足一个整批，按实际条数取
  const batchLimit = Math.min(Math.max(uncompressedCount, 1), COMPRESSION_BATCH_SIZE);
  const episodes = d.prepare(
    `SELECT id, content, source, emotional_weight, created_at FROM t2_episodes
     WHERE persona_id = ?
       AND source IN ('chat', 'event', 'causal_chain', 'user_trace')
       AND strength > 0.1
       AND COALESCE(t3_compressed, 0) = 0
     ORDER BY created_at ASC
     LIMIT ${batchLimit}`
  ).all(pid) as RawEpisode[];

  if (episodes.length < COMPRESSION_MIN_COUNT) return; // 太少不值得压缩

  const summary = await generateT3Summary(episodes, pid);
  if (!summary) return;

  // 存入 T3 摘要
  const content = `[T3记忆] ${summary}`;
  const episodeId = insertEpisode(content, "t3_summary", 0);
  // 设置更长的半衰期
  d.prepare("UPDATE t2_episodes SET half_life_days = ? WHERE id = ?").run(T3_HALF_LIFE_DAYS, episodeId);

  // 同步存储嵌入（用字符 n-gram，升级后会自动替换）
  const emb = generateEmbedding(content);
  const arr = JSON.stringify(Array.from(emb));
  d.prepare("UPDATE t2_episodes SET embedding = ? WHERE id = ?").run(arr, episodeId);

  // 标记原片段已被"消化"：降低强度但保留细节，并置压缩标记（否则下次会被再次计入阈值，
  // 导致同一批片段被反复压缩、每轮都触发 LLM 调用）
  const ids = episodes.map((e) => e.id);
  d.prepare(
    `UPDATE t2_episodes SET strength = strength * 0.3, t3_compressed = 1
     WHERE id IN (${ids.map(() => "?").join(",")})`
  ).run(...ids);

  console.log(`[T3] 压缩完成: ${episodes.length} 条 → 1 条摘要 (id=${episodeId})`);
}

// ── LLM 摘要生成 ──────────────────────────────

/**
 * 构造 T3 摘要 prompt（纯函数，便于单测）。
 *
 * 规则按 docs/MEMORY_AI_TONE_AUDIT.md §3 的质量要求加固：
 * - 保留具体事实（人名/项目/地点/数字/计划），不能泛化成「聊了很多」；
 * - 保留没聊完的话题（待续/还没决定/下次再说）；
 * - 禁止编造片段里没有的具体事件，不确定就模糊表达；
 * - 第一人称、3-5 句、按时间顺序，但不要逐条罗列。
 */
export function buildT3SummaryPrompts(episodes: RawEpisode[], personaId: string): T3SummaryPrompts {
  const lines = episodes.map((e) => {
    const date = e.created_at?.slice(0, 10) ?? "未知日期";
    const tag = e.source === "chat" ? "对话" : e.source === "causal_chain" ? "事件" : "记录";
    return `[${date} · ${tag} · 情绪 ${e.emotional_weight.toFixed(1)}] ${e.content.slice(0, 120)}`;
  });
  const startDate = episodes[0]?.created_at?.slice(0, 10) ?? "?";
  const endDate = episodes[episodes.length - 1]?.created_at?.slice(0, 10) ?? "?";

  const system = [
    `你是长期的记忆整理系统。下面是她（${personaId}）过去一段时间的生活片段。`,
    `你的任务是把这些碎片压缩成 3-5 句的叙事摘要，就像人在多年后回忆一段时光。`,
    ``,
    `规则：`,
    `- 不要逐条复述，要提炼出这段时间的主题和情感走向`,
    `- 用第一人称（"我那段时间..."、"我记得..."）`,
    `- **保留具体事实**：人名、地点、项目、宠物、数字、计划要保留原意，不要泛化成"聊了很多"`,
    `- **保留未完成的话题**：还没决定、待续、下次再说的事要留着，那是以后还能接上的线`,
    `- **不要编造**片段里没有的具体事件/对话；不确定的地方就用"好像""记不太清"这种模糊表达`,
    `- 关注情绪变化和重要事件，忽略日常寒暄`,
    `- 3-5 句话即可，不要写长文`,
  ].join("\n");

  const user = [
    `以下是 ${episodes.length} 条片段，跨越 ${startDate} 到 ${endDate}：`,
    "",
    ...lines.slice(0, 60), // 最多 60 条，避免 token 爆炸
    "",
    "压缩成 3-5 句叙事摘要：",
  ].join("\n");

  return { system, user, startDate, endDate };
}

async function generateT3Summary(episodes: RawEpisode[], personaId: string): Promise<string | null> {
  const modelConfig = getChatModel();
  const client = new OpenAI({
    apiKey: modelConfig.apiKey,
    baseURL: modelConfig.baseUrl,
  });

  const { system: systemPrompt, user: userPrompt } = buildT3SummaryPrompts(episodes, personaId);

  const startedAtMs = Date.now();
  try {
    const response = await client.chat.completions.create(withThinking({
      model: modelConfig.model,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
      temperature: 0.7,
      max_tokens: 400,
    }));

    recordAuxUsage({ kind: "t3_summary", model: modelConfig.model, startedAtMs }, response.usage);
    const text = response.choices[0]?.message?.content?.trim() ?? "";
    return text || null;
  } catch (err) {
    console.log(`[T3] LLM 摘要失败: ${err instanceof Error ? err.message : err}`);
    return null;
  }
}

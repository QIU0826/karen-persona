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
import { getChatModel } from "../ai/router.js";
import { getVectorDb, getCurrentPersona, insertEpisode, updateStrength } from "../data/vector.js";
import { generateEmbedding } from "../data/embedding.js";

// ── 阈值 ──────────────────────────────────────

/** 每积累多少条未压缩的 T2 片段触发一次压缩 */
const COMPRESSION_BATCH_SIZE = 80;

/** T3 摘要的半衰期（天）——比普通记忆更持久 */
const T3_HALF_LIFE_DAYS = 90;

// ── 压缩逻辑 ──────────────────────────────────

interface RawEpisode {
  id: number;
  content: string;
  source: string;
  emotional_weight: number;
  created_at: string;
}

/**
 * 检查是否需要压缩，如果需要则执行。
 * 在每次 T2 写入后调用。
 */
export function maybeCompressToT3(): void {
  const d = getVectorDb();

  const pid = getCurrentPersona();

  // 统计未压缩的普通片段（不含 t3_summary 和 internal_monologue）
  const countRow = d.prepare(
    `SELECT COUNT(*) as cnt FROM t2_episodes
     WHERE persona_id = ?
       AND source IN ('chat', 'event', 'causal_chain', 'user_trace')
       AND strength > 0.1`
  ).get(pid) as { cnt: number };

  if (countRow.cnt < COMPRESSION_BATCH_SIZE) return;

  // 异步执行压缩，不阻塞
  console.log(`[T3] 触发压缩: ${countRow.cnt} 条未压缩片段 (${pid})`);
  runT3Compression(pid).catch((err) => {
    console.log(`[T3] 压缩失败: ${err instanceof Error ? err.message : err}`);
  });
}

async function runT3Compression(pid: string): Promise<void> {
  const d = getVectorDb();

  // 取最旧的未压缩片段
  const episodes = d.prepare(
    `SELECT id, content, source, emotional_weight, created_at FROM t2_episodes
     WHERE persona_id = ?
       AND source IN ('chat', 'event', 'causal_chain', 'user_trace')
       AND strength > 0.1
     ORDER BY created_at ASC
     LIMIT ${COMPRESSION_BATCH_SIZE}`
  ).all(pid) as RawEpisode[];

  if (episodes.length < 20) return; // 太少不值得压缩

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

  // 标记原片段已被"消化"（降低强度，但不删除）
  const ids = episodes.map((e) => e.id);
  d.prepare(
    `UPDATE t2_episodes SET strength = strength * 0.3 WHERE id IN (${ids.map(() => "?").join(",")})`
  ).run(...ids);

  console.log(`[T3] 压缩完成: ${episodes.length} 条 → 1 条摘要 (id=${episodeId})`);
}

// ── LLM 摘要生成 ──────────────────────────────

async function generateT3Summary(episodes: RawEpisode[], personaId: string): Promise<string | null> {
  const modelConfig = getChatModel();
  const client = new OpenAI({
    apiKey: modelConfig.apiKey,
    baseURL: modelConfig.baseUrl,
  });

  // 准备输入：按时间排序的片段列表
  const lines = episodes.map((e) => {
    const date = e.created_at?.slice(0, 10) ?? "未知日期";
    const tag = e.source === "chat" ? "对话" : e.source === "causal_chain" ? "事件" : "记录";
    return `[${date} · ${tag} · 情绪 ${e.emotional_weight.toFixed(1)}] ${e.content.slice(0, 120)}`;
  });

  const systemPrompt = [
    `你是长期的记忆整理系统。下面是她（${personaId}）过去一段时间的生活片段。`,
    `你的任务是把这些碎片压缩成 3-5 句的叙事摘要，就像人在多年后回忆一段时光。`,
    ``,
    `规则：`,
    `- 不要逐条复述，要提炼出这段时间的主题和情感走向`,
    `- 用第一人称（"我那段时间..."、"我记得..."）`,
    `- 关注情绪变化和重要事件，忽略日常寒暄`,
    `- 3-5 句话即可，不要写长文`,
  ].join("\n");

  const userPrompt = [
    `以下是 ${episodes.length} 条片段，跨越 ${lines[0]?.slice(1, 11) ?? "?"} 到 ${lines[lines.length - 1]?.slice(1, 11) ?? "?"}：`,
    "",
    ...lines.slice(0, 60), // 最多 60 条，避免 token 爆炸
    "",
    "压缩成 3-5 句叙事摘要：",
  ].join("\n");

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

    const text = response.choices[0]?.message?.content?.trim() ?? "";
    return text || null;
  } catch (err) {
    console.log(`[T3] LLM 摘要失败: ${err instanceof Error ? err.message : err}`);
    return null;
  }
}

/**
 * 自我叙事重构（域五）— P2-b 实现 + P2-1 升级。
 *
 * P2-1 升级：flipThroughDiary() —— 她"翻阅"自己过去一周的独白日记。
 * 不做主题分类、不做关键词检测、不贴标签。
 * 她只是翻了一下，可能被某句话触动，也可能觉得没什么特别的。
 *
 * 产品理念对齐：
 * - 演化的核心不是后台参数漂移，是"觉察→否认→承认"的心理弧线
 * - 自我叙事不存在"正确版本"——她翻日记时的感受本身就可能是偏差的
 * - 用关键词检测情绪 = 用标签冒充理解 → 绝对禁止
 * - 她不会说"我被你改变了"，她会说"我最近好像有点不一样"
 */

import type { MetabolizedMemory } from "./memory-decay.js";
import type { DriftState } from "./baseline-drift.js";
import { getVectorDb } from "../data/vector.js";
import OpenAI from "openai";
import { getChatModel } from "../ai/router.js";

// ── 翻阅日记（P2-1）─────────────────────────────

/** 回溯窗口（天） */
const DIARY_WINDOW_DAYS = 7;
/** 最少独白条数才触发翻阅 */
const MIN_MONOLOGUES = 5;

/**
 * 她随手翻了翻自己过去一周的日记。
 * 不做分析，不做总结，只是翻了一下。
 * 返回她翻完的感受——一句话，可能是触动，可能是无聊，可能是"没什么特别的"。
 */
export async function flipThroughDiary(): Promise<string | null> {
  const d = getVectorDb();

  // 取过去一周的独白
  const rows = d.prepare(
    `SELECT content FROM t2_episodes
     WHERE source = 'internal_monologue'
       AND strength > 0.1
       AND created_at >= datetime('now', '-' || ? || ' days')
     ORDER BY created_at ASC`
  ).all(DIARY_WINDOW_DAYS) as Array<{ content: string }>;

  if (rows.length < MIN_MONOLOGUES) return null;

  // 拼接日记内容（去 [独白] 前缀，每条一行）
  const entries = rows.map((r) =>
    r.content.replace(/^\[独白\]\s*/, "")
  );

  const modelConfig = getChatModel();
  const client = new OpenAI({
    apiKey: modelConfig.apiKey,
    baseURL: modelConfig.baseUrl,
  });

  const systemPrompt = [
    "你是小雅。你随手翻了翻自己最近一周的日记。",
    "像翻手机备忘录一样随意——不是在做分析，不是在写总结。",
    "",
    "规则：",
    "- 有没有哪句话让你停下来多看了两眼？",
    "- 有没有什么你自己都没注意到但在反复写的东西？",
    "- 用一句话说说你翻完的感受",
    "- 如果没什么特别的，就说\"没什么特别的\"",
    "- 不要评价自己写得好不好，不要总结主题",
    "- 可能你觉得有点不好意思——这些日记本来不该给人看的",
  ].join("\n");

  const userPrompt = [
    "以下是你的日记：",
    "",
    ...entries.map((e) => `- ${e}`),
    "",
    "翻完的感受（一句话）：",
  ].join("\n");

  try {
    const response = await client.chat.completions.create({
      model: modelConfig.model,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
      temperature: 0.85,
      max_tokens: 80,
    });

    const text = response.choices[0]?.message?.content?.trim() ?? "";
    if (!text || text === "没什么特别的" || text === "没什么特别的。" || text.length < 2) {
      return null;
    }
    console.log(`[日记翻阅] ${text}`);
    return text;
  } catch (err) {
    console.log(`[日记翻阅] 失败: ${err instanceof Error ? err.message : err}`);
    return null;
  }
}

// ── 弧线阶段 ────────────────────────────────────

export type ArcStage = "none" | "noticing" | "denying" | "admitting";

export interface NarrativeArc {
  stage: ArcStage;
  lastAdvance: number;
  direction: "positive" | "negative" | null;
  currentNarrative: string | null;
  expressed: boolean;
}

export function createNarrativeArc(): NarrativeArc {
  return {
    stage: "none",
    lastAdvance: 0,
    direction: null,
    currentNarrative: null,
    expressed: false,
  };
}

// ── 弧线推进 ────────────────────────────────────

interface AdvanceOptions {
  arc: NarrativeArc;
  drift: DriftState;
  recentMemories: MetabolizedMemory[];
  attachmentStyle: string;
  /** P2-1: 翻阅日记后的感受（一句话，可能为空） */
  diaryReaction?: string;
  nowMs?: number;
}

export function advanceNarrativeArc(opts: AdvanceOptions): {
  arc: NarrativeArc;
  logs: string[];
} {
  const now = opts.nowMs ?? Date.now();
  const arc = { ...opts.arc, expressed: opts.arc.expressed };
  const logs: string[] = [];

  const gap = Math.abs(opts.drift.actualBaseline - opts.drift.perceivedBaseline);
  const daysSinceAdvance = (now - arc.lastAdvance) / (1000 * 3600 * 24);
  const direction: "positive" | "negative" =
    opts.drift.actualBaseline > opts.drift.perceivedBaseline ? "positive" : "negative";

  switch (arc.stage) {
    case "none": {
      if (gap > 0.1 && daysSinceAdvance > 7) {
        arc.stage = "noticing";
        arc.lastAdvance = now;
        arc.direction = direction;
        arc.expressed = false;
        arc.currentNarrative = noticingNarrative(direction, opts.attachmentStyle, opts.diaryReaction);
        logs.push(`[叙事] 进入觉察阶段 (${direction})`);
      }
      break;
    }

    case "noticing": {
      arc.direction = direction;
      if (gap > 0.15 && daysSinceAdvance > 10) {
        arc.stage = "denying";
        arc.lastAdvance = now;
        arc.expressed = false;
        arc.currentNarrative = denyingNarrative(direction, opts.attachmentStyle);
        logs.push(`[叙事] 进入否认阶段 (${direction})`);
      }
      break;
    }

    case "denying": {
      arc.direction = direction;
      if (gap > 0.2 && daysSinceAdvance > 14) {
        arc.stage = "admitting";
        arc.lastAdvance = now;
        arc.expressed = false;
        arc.currentNarrative = admittingNarrative(direction, opts.attachmentStyle, opts.diaryReaction);
        logs.push(`[叙事] 进入承认阶段 (${direction})`);
      }
      break;
    }

    case "admitting": {
      if (arc.expressed && daysSinceAdvance > 7) {
        arc.stage = "none";
        arc.lastAdvance = now;
        arc.direction = null;
        arc.currentNarrative = null;
        arc.expressed = false;
        logs.push("[叙事] 弧线复位，等待下一轮");
      }
      break;
    }
  }

  return { arc, logs };
}

// ── 叙事生成 ────────────────────────────────────

function noticingNarrative(
  direction: "positive" | "negative",
  _attachment: string,
  diaryReaction?: string,
): string {
  if (diaryReaction) {
    // 日记给了她模糊的印证——"翻了一下日记，发现..."
    if (direction === "positive") {
      return `最近好像心情好一点了……翻了一下自己写的，${diaryReaction}。算了可能是我多想了。`;
    }
    return `最近好像有点闷闷的。${diaryReaction}。也不知道是不是。`;
  }

  if (direction === "positive") {
    return "最近好像心情好一点了……说不上来为什么。算了可能是我多想了。";
  }
  return "最近好像有点闷闷的。也说不上来原因。应该是天气吧。";
}

function denyingNarrative(
  direction: "positive" | "negative",
  attachment: string,
): string {
  if (attachment === "回避型") {
    return direction === "positive"
      ? "我不会是……开心了吧。没有没有，就是最近咖啡店没那么忙而已。"
      : "我不是状态不好。我就是困。对，就是困。";
  }
  if (attachment === "焦虑型") {
    return direction === "positive"
      ? "最近好像还不错？不对，万一过两天又不行了呢。"
      : "我是不是不太对劲……算了不想了越想越烦。";
  }
  return direction === "positive"
    ? "好像最近状态还行？不不不，别立flag。"
    : "没什么，就是最近有点累。都是正常的。";
}

function admittingNarrative(
  direction: "positive" | "negative",
  attachment: string,
  diaryReaction?: string,
): string {
  const diaryRef = diaryReaction
    ? `翻了自己的日记，${diaryReaction}。`
    : "";

  if (attachment === "回避型") {
    return direction === "positive"
      ? `好吧我承认最近状态确实好了一点。${diaryRef}和你没关系。嗯。`
      : `好吧我最近是有点不太好。${diaryRef}你不用管我，我自己能缓过来。`;
  }
  if (attachment === "焦虑型") {
    return direction === "positive"
      ? `我好像是变开心了一点。${diaryRef}不知道能持续多久就是了。`
      : `我觉得我最近是有点低落。${diaryRef}跟你说一下，你不用做什么。`;
  }
  return direction === "positive"
    ? `嗯，我确实感觉好多了。${diaryRef}可能是生活的某个部分终于对了。`
    : `我最近是有些低落。${diaryRef}可能需要一点时间。`;
}

// ── 对话注入 ────────────────────────────────────

export function shouldInjectNarrative(arc: NarrativeArc): boolean {
  return (
    arc.stage !== "none" &&
    !arc.expressed &&
    arc.currentNarrative !== null
  );
}

export function markNarrativeExpressed(arc: NarrativeArc): NarrativeArc {
  return { ...arc, expressed: true };
}

// ── 记忆驱动的叙事碎片 ──────────────────────────

export function extractNarrativeFragments(
  memories: MetabolizedMemory[],
  maxFragments: number = 3,
): string[] {
  return memories
    .filter(m => m.strength > 0.3 && !m.isRediscovery)
    .sort(() => Math.random() - 0.5)
    .slice(0, maxFragments)
    .map(m => m.content);
}

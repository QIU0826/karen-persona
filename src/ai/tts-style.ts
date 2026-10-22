/**
 * 语音的「人味」处理（v0.4.1）。
 *
 * 问题：`say` 直接用固定语速 + 无音高变化 + 无停顿起伏，念出来就是「朗读腔」，
 * 一听就是 TTS。真人的语音有三个特征：
 *  1. **语速会变**（开心快一点、困了慢一点）；
 *  2. **音高有起伏**（不是一条直線）；
 *  3. **句子之间真的会停顿**，还会偶尔带个语气词（「嗯…」「诶」）。
 *
 * macOS `say` 支持内嵌语音命令，实测有效（本机 macOS 26 / M5）：
 *  - `[[slnc 600]]` → 静音 600ms（实测时长 +0.62s）
 *  - `[[pbas +18]]` → 提高基频（实测 f0 212Hz → 358Hz）
 *
 * 本模块只做纯计算：输入文本 + 情绪/时间/亲密度，输出「怎么念」。
 * 不碰文件、不调外部命令，方便单测。
 */

export type SpeechStyle = "natural" | "soft" | "lively" | "tired";

export interface StyleInput {
  /** 已清洗过的朗读文本（不含 CQ 码/emoji） */
  text: string;
  /** 情绪向量 -1..1（负=低落，正=开心） */
  emotionVector?: number;
  /** 0-23 本地小时 */
  hour?: number;
  /** 亲密度 0-10（越熟越随意、略快） */
  closeness?: number;
  /** 基准语速（字/分钟），默认 180 */
  baseRate?: number;
  /** 加语气词的概率（0-1），默认 0.12；设 0 关闭 */
  fillerProbability?: number;
  random?: () => number;
}

export interface StylePlan {
  style: SpeechStyle;
  /** 最终语速（字/分钟） */
  rate: number;
  /** `[[pbas N]]` 的音高偏移（0 = 不加命令） */
  pitch: number;
  /** 加了停顿命令/语气词的朗读文本 */
  spokenText: string;
  /** 累计插入的静音时长（毫秒，便于日志与测试） */
  addedPauseMs: number;
  /** 是否加了语气词 */
  usedFiller: boolean;
}

// ── 常量（可测） ────────────────────────────────

export const DEFAULT_BASE_RATE = 180;
export const DEFAULT_FILLER_PROBABILITY = 0.12;

/** 各风格相对基准语速的倍率 */
export const STYLE_RATE_FACTOR: Record<SpeechStyle, number> = {
  natural: 1,
  soft: 0.94,
  lively: 1.05,
  tired: 0.9,
};

/** 各风格的音高偏移（`[[pbas]]` 单位） */
export const STYLE_PITCH: Record<SpeechStyle, number> = {
  natural: 0,
  soft: -2,
  lively: 3,
  tired: -3,
};

/** 逗号类停顿范围与句末停顿范围（毫秒） */
const COMMA_PAUSE: Record<SpeechStyle, [number, number]> = {
  natural: [70, 130],
  soft: [110, 190],
  lively: [50, 100],
  tired: [130, 220],
};
const SENTENCE_PAUSE: Record<SpeechStyle, [number, number]> = {
  natural: [120, 220],
  soft: [180, 280],
  lively: [90, 160],
  tired: [200, 320],
};
const ELLIPSIS_PAUSE: Record<SpeechStyle, [number, number]> = {
  natural: [260, 340],
  soft: [320, 420],
  lively: [200, 300],
  tired: [340, 460],
};

/** 单条语音最多插入多少静音（避免节奏拖沓） */
export const MAX_ADDED_PAUSE_MS = 700;

const COMMA_CHARS = "，、,；;：:";
const SENTENCE_CHARS = "。！？!?";

// ── 风格选择 ───────────────────────────────────

/**
 * v0.9.30：从回复文字里读语气线索。
 * 情绪状态常常是中性/滞后，但这一句本身可能明显在笑、在撒娇或在低落；
 * 语音 TTS 直接按这一句选风格，比只看 state.emotion 更贴近当下。
 */
export function detectTextStyle(text: string): SpeechStyle | null {
  const t = (text ?? "").trim();
  if (!t) return null;
  if (/(哈哈|嘿嘿|开心|高兴|太好|好呀|喜欢你|想你了|期待|真棒|不错哦|耶[！!]?|好耶)/.test(t)) {
    return "lively";
  }
  if (/(唉|累了|难过|委屈|不开心|想哭|算了|烦|难受|失落|有点丧)/.test(t)) {
    return "soft";
  }
  if (/(困|晚安|睡了|好累|没力气)/.test(t)) {
    return "tired";
  }
  return null;
}

/** 深夜/凌晨 → 困；情绪明显 → 活泼/低落；其次看这一句的文字线索；否则自然。 */
export function chooseStyle(input: {
  emotionVector?: number;
  hour?: number;
  text?: string;
}): SpeechStyle {
  const hour = input.hour;
  if (typeof hour === "number" && (hour >= 23 || hour < 7)) return "tired";
  const emo = input.emotionVector ?? 0;
  if (emo > 0.25) return "lively";
  if (emo < -0.15) return "soft";
  return detectTextStyle(input.text ?? "") ?? "natural";
}

function clamp(num: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, num));
}

// ── 停顿 ───────────────────────────────────────

function pauseRange(
  style: SpeechStyle,
  kind: "comma" | "sentence" | "ellipsis",
  random: () => number,
): number {
  const table =
    kind === "comma" ? COMMA_PAUSE : kind === "sentence" ? SENTENCE_PAUSE : ELLIPSIS_PAUSE;
  const [min, max] = table[style];
  return Math.round(min + random() * (max - min));
}

/**
 * 在标点后插入静音命令，让句子之间真的有呼吸。
 * 末尾标点不加停顿（否则语音尾巴拖一截空白）。
 */
export function insertPauses(
  text: string,
  style: SpeechStyle,
  random: () => number = Math.random,
): { text: string; addedPauseMs: number } {
  const chars = Array.from(text);
  const out: string[] = [];
  let added = 0;

  for (let i = 0; i < chars.length; i++) {
    const ch = chars[i];
    const isLast = i === chars.length - 1;
    out.push(ch);

    // 省略号：整段处理（…/……/...）
    if (ch === "…" || (ch === "." && chars[i + 1] === "." && chars[i + 2] === ".")) {
      // 连续省略号只处理一次
      let j = i;
      while (chars[j + 1] === "…" || chars[j + 1] === ".") j++;
      const consumed = j - i;
      for (let k = 0; k < consumed; k++) out.push(chars[++i]);
      if (isLast || added >= MAX_ADDED_PAUSE_MS) continue;
      const ms = Math.min(pauseRange(style, "ellipsis", random), MAX_ADDED_PAUSE_MS - added);
      out.push(`[[slnc ${ms}]]`);
      added += ms;
      continue;
    }

    if (isLast || added >= MAX_ADDED_PAUSE_MS) continue;

    if (SENTENCE_CHARS.includes(ch)) {
      const ms = Math.min(pauseRange(style, "sentence", random), MAX_ADDED_PAUSE_MS - added);
      out.push(`[[slnc ${ms}]]`);
      added += ms;
    } else if (COMMA_CHARS.includes(ch)) {
      const ms = Math.min(pauseRange(style, "comma", random), MAX_ADDED_PAUSE_MS - added);
      out.push(`[[slnc ${ms}]]`);
      added += ms;
    }
  }

  return { text: out.join(""), addedPauseMs: added };
}

// ── 语气词 ─────────────────────────────────────

const FILLERS: Record<SpeechStyle, string[]> = {
  natural: ["嗯…", "那个…"],
  soft: ["唔…", "嗯…"],
  lively: ["诶，", "欸…"],
  tired: ["唔…", "唉…"],
};

/**
 * 偶尔在前面垫一个语气词。
 * 只在「像随口说」的短句上加：太长的句子加语气词反而奇怪；
 * 问句/感叹句开头已经有语气，不再加。
 */
export function maybeAddFiller(
  text: string,
  style: SpeechStyle,
  probability: number,
  random: () => number = Math.random,
): { text: string; used: boolean } {
  const chars = Array.from(text);
  if (chars.length < 6 || chars.length > 40) return { text, used: false };
  if (!/[。！？…]/.test(text.slice(-4))) return { text, used: false };
  if (probability <= 0 || random() >= probability) return { text, used: false };
  const pool = FILLERS[style];
  const filler = pool[Math.floor(random() * pool.length)] ?? pool[0];
  if (text.startsWith(filler) || /^[嗯唔诶欸唉]/.test(text)) return { text, used: false };
  return { text: filler + text, used: true };
}

// ── 主入口 ─────────────────────────────────────

/**
 * 把「朗读文本」变成「怎么念」：风格 / 语速 / 音高 / 停顿 / 语气词。
 * 纯函数；同样的输入 + 同样的随机序列 → 同样的输出。
 */
export function planSpeechStyle(input: StyleInput): StylePlan {
  const random = input.random ?? Math.random;
  const baseRate = clamp(
    typeof input.baseRate === "number" && Number.isFinite(input.baseRate)
      ? Math.round(input.baseRate)
      : DEFAULT_BASE_RATE,
    100,
    300,
  );
  const fillerProbability = clamp(
    typeof input.fillerProbability === "number" && Number.isFinite(input.fillerProbability)
      ? input.fillerProbability
      : DEFAULT_FILLER_PROBABILITY,
    0,
    1,
  );

  const style = chooseStyle({
    emotionVector: input.emotionVector,
    hour: input.hour,
    text: input.text,
  });

  let rate = Math.round(baseRate * STYLE_RATE_FACTOR[style]);
  // 熟一点的人说话更随意、稍快（但保持可懂）
  const closeness = input.closeness;
  if (typeof closeness === "number" && closeness >= 6) rate = Math.round(rate * 1.02);
  rate = clamp(rate, 100, 300);

  const filled = maybeAddFiller(input.text, style, fillerProbability, random);
  const intonation = applyIntonation(filled.text, style, { baseRate: rate, random });

  return {
    style,
    rate,
    pitch: STYLE_PITCH[style],
    spokenText: intonation.spokenText,
    addedPauseMs: intonation.addedPauseMs,
    usedFiller: filled.used,
  };
}

// ── 句内语调（v0.4.1 核心）─────────────────────

/** 分句：标点跟着前一个分句走 */
const CLAUSE_DELIMS = "，、；：,;:。！？!?…";

export function splitClauses(text: string): string[] {
  const chars = Array.from(text);
  const out: string[] = [];
  let buf = "";
  for (let i = 0; i < chars.length; i++) {
    const ch = chars[i];
    buf += ch;
    if (!CLAUSE_DELIMS.includes(ch)) continue;
    // 连续标点（「？！」「……」）算同一句，不切碎
    while (i + 1 < chars.length && CLAUSE_DELIMS.includes(chars[i + 1])) {
      buf += chars[++i];
    }
    out.push(buf);
    buf = "";
  }
  if (buf.trim()) out.push(buf);
  return out.filter((c) => c.trim().length > 0);
}

const CLAUSE_COMMA_PAUSE: Record<SpeechStyle, [number, number]> = {
  natural: [140, 260],
  soft: [200, 340],
  lively: [100, 200],
  tired: [240, 400],
};
const CLAUSE_END_PAUSE: Record<SpeechStyle, [number, number]> = {
  natural: [240, 420],
  soft: [300, 480],
  lively: [180, 320],
  tired: [320, 520],
};

export interface IntonationClause {
  text: string;
  /** `[[pbas]]` 偏移 */
  pitch: number;
  /** 该分句的语速 */
  rate: number;
  /** 分句后的停顿（毫秒；最后一句为 0） */
  pauseMs: number;
}

export interface IntonationPlan {
  spokenText: string;
  addedPauseMs: number;
  clauses: IntonationClause[];
}

/**
 * 给分句加上**语调轮廓**：这是最像真人的一环。
 *
 * 真人说话不是一条直线：
 *  - 一句话里音高整体会「下倾」（句末降调），问句句末升高；
 *  - 起句略慢、中间略快、收尾再慢下来；
 *  - 分句之间真的停顿，长短不一。
 *
 * 用 say 的内嵌命令实现（实测都有效）：`[[pbas ±N]]` / `[[rate N]]` / `[[slnc N]]`。
 */
export function applyIntonation(
  text: string,
  style: SpeechStyle,
  opts: { baseRate: number; random?: () => number } = { baseRate: DEFAULT_BASE_RATE },
): IntonationPlan {
  const random = opts.random ?? Math.random;
  const baseRate = clamp(opts.baseRate, 100, 300);
  const clauses = splitClauses(text);
  const isQuestion = /[？?]\s*$/.test(text.trim());
  const n = clauses.length;
  const basePitch = STYLE_PITCH[style];

  const planned: IntonationClause[] = [];
  let totalPause = 0;

  clauses.forEach((raw, i) => {
    const isLast = i === n - 1;
    const isFirst = i === 0;

    // 音高轮廓：单句不做起伏；多句时从 +3 逐渐降到 -2（问句末句上扬）
    let pitch = basePitch;
    if (n > 1) {
      if (isLast) pitch = basePitch + (isQuestion ? 4 : -2);
      else pitch = basePitch + Math.round(3 - (5 * i) / Math.max(1, n - 1));
    }

    // 语速：起句略慢、中间正常、收尾略慢（整体已由 style 决定）
    const factor = isFirst && n > 1 ? 0.95 : isLast && n > 1 ? 0.93 : 1;
    const rate = clamp(Math.round(baseRate * factor), 100, 300);

    // 停顿：分句之间必有，句末不再加
    let pause = 0;
    if (!isLast) {
      const isSentenceEnd = /[。！？!?…]/.test(raw);
      const [min, max] = isSentenceEnd ? CLAUSE_END_PAUSE[style] : CLAUSE_COMMA_PAUSE[style];
      pause = Math.round(min + random() * (max - min));
      if (totalPause + pause > MAX_ADDED_PAUSE_MS) pause = Math.max(0, MAX_ADDED_PAUSE_MS - totalPause);
      totalPause += pause;
    }

    planned.push({ text: raw, pitch, rate, pauseMs: pause });
  });

  // 音高整体没有变化时（单句 + 风格 natural）不下发命令，保持简单
  const allSamePitch = planned.every((c) => c.pitch === planned[0].pitch);
  const spokenText = planned
    .map((c) => {
      const parts: string[] = [];
      if (!(allSamePitch && c.pitch === 0)) {
        parts.push(`[[pbas ${c.pitch >= 0 ? "+" : ""}${c.pitch}]]`);
      }
      parts.push(`[[rate ${c.rate}]]`);
      parts.push(c.text);
      if (c.pauseMs > 0) parts.push(`[[slnc ${c.pauseMs}]]`);
      return parts.join("");
    })
    .join("");

  return { spokenText, addedPauseMs: totalPause, clauses: planned };
}

/** 去掉内嵌语音命令，只留真正会被念出来的文字（统计字数/日志用）。 */
export function stripSpeechCommands(text: string): string {
  return text.replace(/\[\[[^\]]*\]\]/g, "");
}

/**
 * 最终交给 `say` 的文本。
 * 语调命令已经按分句内嵌在 `spokenText` 里（见 applyIntonation），这里不再额外加前缀。
 */
export function buildSayText(plan: StylePlan): string {
  return plan.spokenText;
}

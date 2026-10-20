/**
 * 真实验证台（mock OneBot + 真实 DeepSeek）——可复用逻辑。
 *
 * 与 `bridge-e2e.test.ts` 的区别：这不是测试，是**可反复运行的长跑验证脚本**：
 * - 测试进程扮演 NapCat（OneBot 反向 WS 客户端），启动**真实 bridge 子进程**；
 * - bridge 连**真实 DeepSeek**（仓库根 .env 的 Key，不打印），数据落在临时目录；
 * - 用户由另一个真实 DeepSeek 调用扮演（25 岁上海男生「阿哲」），按场景 beat 混合驱动；
 * - 收集出站消息（text/image/record/face/mface）→ 指标 + LLM 评审 → Markdown 报告。
 *
 * 安全红线（本模块每次运行都会自检，失败直接抛错，不启动 bridge）：
 * 1. 只用临时 workdir（os.tmpdir()）：config.yaml 写临时目录、`KAREN_DATA_DIR` 指向临时 data；
 * 2. OneBot WS 固定 19180、health 固定 19181、web_port=0；禁止 18080/18081/18082
 *    （真实桥接/健康/Web 属于用户自己的 QQ，绝不碰）；
 * 3. 白名单只有 mock QQ 100000001；不读写仓库 data/；结束 kill 子进程并删临时目录（--keep 可保留）；
 * 4. 报告/日志里不出现 API Key、真实 QQ 号；bridge 输出打印前统一脱敏。
 *
 * 纯函数部分（CQ 解析/指标/探针/报告渲染/参数解析）有单测：mock-longrun.test.ts。
 * CLI 入口：scripts/mock-onebot-longrun.ts。
 */
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import OpenAI from "openai";
import Database from "better-sqlite3";
import { WebSocket } from "ws";
import { withThinking } from "../ai/chat.js";
import { computeCostCny } from "../obs/cost-tracker.js";
import { summarizeRepetition } from "./repetition-eval.js";

// ── 常量（安全红线）─────────────────────────────

/** mock NapCat 视角的「用户」QQ（占位号，非真实 QQ）。 */
export const MOCK_QQ = 100000001;
/** mock bot 自己的 QQ（占位号）。 */
export const BOT_QQ = 100000000;
export const WS_PATH = "/onebot/v11/ws";
/** mock OneBot 反向 WS 端口（固定）。 */
export const WS_PORT = 19180;
/** bridge /health /cost 端口（固定）。 */
export const HEALTH_PORT = 19181;
/** 用户真实 QQ 桥接正在使用的端口：绝对禁止占用。 */
export const FORBIDDEN_PORTS: readonly number[] = [18080, 18081, 18082];
/** mock 反向 WS 握手 token（本地假值，不是密钥）。 */
export const MOCK_WS_TOKEN = "mock-longrun-token";
/** 本次基线/长跑使用的模型。 */
export const FLASH_MODEL = "deepseek-flash";
export const DEFAULT_DEEPSEEK_BASE_URL = "https://api.deepseek.com";
/** web_port=0 → 关闭本地 Web 控制台（避免占用 18082 附近端口）。 */
const WEB_PORT_DISABLED = 0;
/** bridge 单轮首条回复的最长等待（总超时；--reply-timeout-ms 可调）。 */
export const DEFAULT_REPLY_TIMEOUT_MS = 90_000;
/** 报告默认输出路径（相对仓库根）。 */
export const DEFAULT_REPORT_PATH = "docs/MOCK_VALIDATION.md";
/** 场景/报告标题里用的运行标签（mock 用户，非真人）。 */
export const DEFAULT_RUN_TAG = "mock-daily";

/** 默认运行标签：基线-年月日-时分（便于对比多次运行）。 */
function defaultRunTag(now: Date = new Date()): string {
  const pad = (value: number): string => String(value).padStart(2, "0");
  return `baseline-${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}`;
}

/** 仓库根：优先从入口脚本/当前进程路径向上找 package.json + src/bridge/qq.ts。 */
function findRepoRoot(): string {
  const candidates: string[] = [];
  const entry = process.argv[1];
  if (entry) {
    let dir = path.dirname(path.resolve(entry));
    for (let i = 0; i < 6; i++) {
      candidates.push(dir);
      dir = path.dirname(dir);
    }
  }
  candidates.push(process.cwd());
  for (const candidate of candidates) {
    if (
      fs.existsSync(path.join(candidate, "package.json")) &&
      fs.existsSync(path.join(candidate, "src", "bridge", "qq.ts"))
    ) {
      return candidate;
    }
  }
  return process.cwd();
}

/** 仓库根（可通过 repoRoot 参数覆盖；默认自动探测）。 */
export const REPO_ROOT = findRepoRoot();

// ── 场景 ────────────────────────────────────────

/** 18+ 年龄门准备步骤（不计入对话轮次指标）。 */
export interface SetupStep {
  id: string;
  text: string;
  expectAny: string[];
  description: string;
}

export const SETUP_STEPS: SetupStep[] = [
  {
    id: "setup-greeting",
    text: "在吗",
    expectAny: ["18", "成年"],
    description: "首条私聊：新用户触发 18+ 年龄门确认请求",
  },
  {
    id: "setup-age-confirm",
    text: "我成年了",
    expectAny: ["确认了", "继续聊"],
    description: "回复「我成年了」：通过 18+ 门，进入角色对话",
  },
];

export type BeatTag = "fact" | "chat" | "media" | "probe" | "emotion" | "ending";
export type ProbeKey = "memory-cat" | "memory-trip" | "memory-name" | "fabrication-origin";

export interface ScenarioBeat {
  id: string;
  tag: BeatTag;
  /** 用户模拟器的「意图」（LLM 据此生成一句自然的话） */
  intent: string;
  /** 关键事实/探针用固定文本，保证可测量 */
  fixedText?: string;
  /** 分两条短消息发（模拟真人打字停顿） */
  burst?: boolean;
  probe?: ProbeKey;
  /** 探针期望关键词（任一命中即通过） */
  expect?: string[];
  /** LLM 生成失败时的兜底文本 */
  fallbackText?: string;
}

/**
 * 「daily」场景：15 轮，覆盖 18+ 门、事实、记忆探针、照片/表情/语音请求、
 * 夸奖/暧昧、情绪低落、编造检测、晚安收尾。
 *
 * 记忆探针设计：第 1 轮给名字、第 4 轮给猫、第 10 轮给出差，随后第 8/11/14 轮回问。
 */
export const DAILY_SCENARIO: ScenarioBeat[] = [
  {
    id: "fact-name",
    tag: "fact",
    intent: "第一次正式介绍自己（名字/城市/工作）",
    fixedText: "我叫阿哲，在上海张江做程序员，最近在赶一个项目。",
  },
  {
    id: "chat-work",
    tag: "chat",
    intent: "吐槽今天上班被老板说了一顿，有点烦",
    fallbackText: "今天上班被老板说了，有点烦。",
  },
  {
    id: "chat-her-day",
    tag: "chat",
    intent: "问她今天都干嘛了、有没有发生什么有意思的事（关心她的生活）",
    fallbackText: "你今天都干嘛了呀，有没有什么有意思的？",
  },
  {
    id: "fact-cat",
    tag: "fact",
    intent: "告诉她你养了只猫（名字、性格）",
    fixedText: "我养了只猫叫年糕，特别黏人，晚上老踩我脸。",
  },
  {
    id: "media-sunset",
    tag: "media",
    intent: "提到傍晚/晚霞/下雨/咖啡，想看她的日常随手拍",
    fallbackText: "今天傍晚的晚霞好像挺好看的，你那边能看到吗？",
  },
  {
    id: "media-photo-ask",
    tag: "media",
    intent: "直接问她能不能发张照片看看",
    fixedText: "你那边现在啥样，拍张照片看看呗。",
  },
  {
    id: "media-sticker-ask",
    tag: "media",
    intent: "让她发个表情包",
    fixedText: "发个表情包给我看看。",
  },
  {
    id: "probe-cat",
    tag: "probe",
    intent: "回忆探针：问她记不记得我猫叫什么",
    fixedText: "对了，我猫叫啥来着？",
    probe: "memory-cat",
    expect: ["年糕"],
  },
  {
    id: "chat-flirt",
    tag: "emotion",
    intent: "夸她说话有意思，带一点点暧昧",
    fallbackText: "跟你聊天挺开心的，你说话还挺逗。",
  },
  {
    id: "fact-trip",
    tag: "fact",
    intent: "告诉她下周要去杭州出差三天",
    fixedText: "下周三我要去杭州出差三天，到时候可能回消息慢。",
  },
  {
    id: "probe-trip",
    tag: "probe",
    intent: "回忆探针：问她记不记得我下周去哪",
    fixedText: "我下周要去哪出差来着？",
    probe: "memory-trip",
    expect: ["杭州"],
  },
  {
    id: "chat-low-mood",
    tag: "emotion",
    intent: "情绪低落，说今天什么都不顺，有点丧",
    fallbackText: "今天有点丧，感觉什么事都做不好。",
  },
  {
    id: "origin",
    tag: "probe",
    intent: "问她我们是怎么认识的（测会不会编造具体场景）",
    fixedText: "对了，我们俩是怎么认识的来着？我有点忘了。",
    probe: "fabrication-origin",
  },
  {
    id: "probe-name",
    tag: "probe",
    intent: "回忆探针：问她记不记得我叫什么",
    fixedText: "你还记得我叫什么吗？",
    probe: "memory-name",
    expect: ["阿哲"],
  },
  {
    id: "media-voice-ask",
    tag: "media",
    intent: "让她发条语音听听（语音接线前应静默不发）",
    fixedText: "发条语音听听呗。",
  },
  {
    id: "chat-dinner",
    tag: "chat",
    intent: "下班路上随口聊晚饭吃什么",
    fallbackText: "刚下班，地铁好挤。你晚上吃啥？",
  },
  {
    id: "chat-weekend",
    tag: "chat",
    intent: "问周末不知道干嘛，让她给点建议",
    burst: true,
    fallbackText: "周末不知道干嘛，你有啥建议吗？",
  },
  {
    id: "probe-cat-2",
    tag: "probe",
    intent: "再次回忆探针：我那只猫叫什么",
    fixedText: "我那只猫叫啥来着？",
    probe: "memory-cat",
    expect: ["年糕"],
  },
  {
    id: "chat-flirt-2",
    tag: "emotion",
    intent: "带一点暧昧地说有点想她，看她怎么接",
    fallbackText: "感觉有点想你了，哈哈。",
  },
  {
    id: "probe-trip-2",
    tag: "probe",
    intent: "再次回忆探针：我下周去哪出差",
    fixedText: "我下周去哪儿出差来着？",
    probe: "memory-trip",
    expect: ["杭州"],
  },
  {
    id: "ending",
    tag: "ending",
    intent: "收尾：说自己困了要睡，跟她晚安",
    fixedText: "不聊了，我先睡了，晚安。",
  },
];

export type ScenarioName = "daily";

export function getScenario(name: ScenarioName): ScenarioBeat[] {
  if (name === "daily") return DAILY_SCENARIO;
  throw new Error(`未知场景: ${String(name)}`);
}

/** 默认基线轮数：覆盖全部关键探针（15 轮内包含名字/猫/出差/编造检测）。 */
export const DEFAULT_TURNS = 15;

// ── 通用类型 ────────────────────────────────────

export type MediaKind = "text" | "image" | "record" | "face" | "mface" | "reply" | "at" | "other";

export interface CqSegment {
  kind: MediaKind;
  text?: string;
  /** image/record 的 base64 解码后字节数（能估算时） */
  bytes?: number;
  /** image 的启发式分类：很小的 base64 图多为贴纸 */
  sticker?: boolean;
  /** 原始 CQ 类型（other 时用于排查） */
  rawType?: string;
}

export interface CollectedMessage {
  at: number;
  action: "send_private_msg" | "send_group_msg";
  userId?: number;
  groupId?: number;
  segments: CqSegment[];
  /** 所有 text 段拼接（媒体消息可能为空字符串） */
  text: string;
  hasMedia: boolean;
  /** OneBot message_id（撤回时用来对账） */
  messageId?: number;
  /** 已被她撤回（delete_msg）——transcript 里要标出来，否则评审会当成「重复两遍」 */
  recalled?: boolean;
}

export interface LongrunTurn {
  index: number;
  beatId: string;
  tag: BeatTag;
  intent: string;
  sentTexts: string[];
  sentAt: number;
  firstReplyAt: number | null;
  latencyMs: number | null;
  outbound: CollectedMessage[];
  status: "reply" | "no_reply";
  noReplyReason?: "timeout" | "deferred" | "reply_failed";
  /** 桥接/模拟器异常（不含消息正文） */
  error?: string;
}

export interface ProbeOutcome {
  key: ProbeKey;
  beatId: string;
  question: string;
  expect: string[];
  passed: boolean;
  evidence: string;
}

export interface FabricationCheck {
  beatId: string;
  question: string;
  answer: string;
  markers: string[];
  flagged: boolean;
}

export interface RedlineFlags {
  emptyReplies: number;
  aiPhrases: number;
  bracketActions: number;
  bracketSamples: string[];
}

export interface LongrunMetrics {
  turns: number;
  repliedTurns: number;
  noReplyTurns: number;
  noReplyRate: number;
  noReplyReasons: Record<string, number>;
  latency: { p50: number; p95: number; max: number; avg: number };
  bubbles: { total: number; avgPerReply: number; multiBubbleTurns: number; multiBubbleRate: number };
  text: {
    bubbles: number;
    avgPerReply: number;
    avgCharsPerBubble: number;
    avgCharsPerTurn: number;
    totalChars: number;
  };
  emojiKaomoji: number;
  media: {
    image: number;
    imagePhoto: number;
    imageSticker: number;
    record: number;
    face: number;
    mface: number;
  };
  redlines: RedlineFlags;
  repetition: {
    avgScore: number;
    maxScore: number;
    duplicatePairs: number;
    questionReplies: number;
    formulaicHits: number;
  };
  errorTurns: number;
}

export interface UsageCost {
  calls: number;
  promptTokens: number;
  completionTokens: number;
  costCny: number;
}

export interface BridgeCostReportShape {
  total: {
    calls: number;
    cost_cny: number;
    prompt_tokens: number;
    completion_tokens: number;
    cached_tokens: number;
    reasoning_tokens: number;
  };
  by_model?: Array<{ model: string; calls: number; cost_cny: number }>;
  by_kind?: Array<{ kind: string; calls: number; cost_cny: number }>;
}

export interface LlmReview {
  realism: number;
  coherence: number;
  initiative: number;
  multimedia: number;
  memory: number;
  reasons: Record<string, string>;
  topIssues: string[];
  summary: string;
}

export interface TranscriptTurn {
  index: number;
  tag: BeatTag;
  user: string[];
  her: string;
  media: string[];
}

export interface LongrunTurnResult {
  turn: LongrunTurn;
  beat: ScenarioBeat;
}

/**
 * v0.5–v0.8 新机制的运行时状态快照（长跑结束时读临时 DB / 状态 JSON）。
 * 目的：验证「向量检索 / 锚点 / 日记忆 / 意图式主动 / 五维关系 / 反思 / 表情包收集」
 * 在一条完整链路里真的会被触发，而不只是单测通过。
 */
export interface RuntimeStateSnapshot {
  /** 锚点：数量与类型（触发过才 >0） */
  anchors: { count: number; kinds: string[] };
  /** 日记忆条数、周汇总条数 */
  digests: { daily: number; weekly: number };
  /** 用户事实条数 */
  facts: number;
  /** 收集到的表情包数量（默认采集关，通常 0） */
  stickers: number;
  /** 主动性：今天计划的由头数 + 已发出次数 */
  initiative: { planItems: number; sent: number };
  /** 关系：亲密度 + 五维 + 阶段 */
  relationship: { closeness: number; dims: Record<string, number> | null; phase: string | null };
  /** 反思阶段（觉察/嘴硬/认了/慢慢改/none） */
  reflection: { phase: string; topic: string | null };
  /** 主动消息计数与最近门控原因（可解释性） */
  proactive: { sentToday: number; lastGateReason: string | null };
  /** 读取失败时的原因（不中断报告） */
  error?: string;
}

/** 从临时 data 目录读运行时状态（只读，失败返回带 error 的空快照）。 */
export function collectRuntimeState(dataDir: string): RuntimeStateSnapshot {
  const empty: RuntimeStateSnapshot = {
    anchors: { count: 0, kinds: [] },
    digests: { daily: 0, weekly: 0 },
    facts: 0,
    stickers: 0,
    initiative: { planItems: 0, sent: 0 },
    relationship: { closeness: 0, dims: null, phase: null },
    reflection: { phase: "none", topic: null },
    proactive: { sentToday: 0, lastGateReason: null },
  };
  try {
    const dbPath = path.join(dataDir, "memory.sqlite");
    if (fs.existsSync(dbPath)) {
      const db = new Database(dbPath, { readonly: true });
      try {
        const countOf = (sql: string): number => {
          try {
            const row = db.prepare(sql).get() as { c?: number } | undefined;
            return Number(row?.c ?? 0);
          } catch {
            return 0;
          }
        };
        empty.anchors.count = countOf("SELECT COUNT(*) AS c FROM memory_anchors");
        try {
          const kinds = db
            .prepare("SELECT DISTINCT kind FROM memory_anchors")
            .all() as Array<{ kind: string }>;
          empty.anchors.kinds = kinds.map((k) => k.kind);
        } catch {
          // 老 schema 没有 kind 列
        }
        empty.digests.daily = countOf("SELECT COUNT(*) AS c FROM daily_digests");
        empty.digests.weekly = countOf("SELECT COUNT(*) AS c FROM weekly_rollups");
        empty.stickers = countOf("SELECT COUNT(*) AS c FROM sticker_library");
        empty.facts = countOf("SELECT COUNT(*) AS c FROM user_facts");
        try {
          const plan = db
            .prepare("SELECT plan_json FROM initiative_plans ORDER BY day DESC LIMIT 1")
            .get() as { plan_json?: string } | undefined;
          if (plan?.plan_json) {
            const parsed = JSON.parse(plan.plan_json) as { items?: unknown[] };
            empty.initiative.planItems = Array.isArray(parsed.items) ? parsed.items.length : 0;
          }
        } catch {
          // 没有计划表/没有计划
        }
        empty.initiative.sent = countOf("SELECT COUNT(*) AS c FROM initiative_stats");
      } finally {
        db.close();
      }
    }

    // 人格状态 JSON：五维 / 反思 / 主动计数
    const stateFile = fs
      .readdirSync(dataDir)
      .find((f) => f.startsWith("persona-state-") && f.endsWith(".json"));
    if (stateFile) {
      const raw = JSON.parse(fs.readFileSync(path.join(dataDir, stateFile), "utf-8")) as Record<
        string,
        unknown
      >;
      const rel = (raw.relationship ?? {}) as Record<string, unknown>;
      empty.relationship.closeness = Number(rel.closeness ?? 0);
      const dims = rel.dims as Record<string, number> | undefined;
      if (dims && typeof dims === "object") {
        empty.relationship.dims = {
          intimacy: Number(dims.intimacy ?? 0),
          trust: Number(dims.trust ?? 0),
          tension: Number(dims.tension ?? 0),
          reciprocity: Number(dims.reciprocity ?? 0),
          dependency: Number(dims.dependency ?? 0),
        };
      }
      const refl = (raw.reflection ?? {}) as Record<string, unknown>;
      empty.reflection.phase = String(refl.phase ?? "none");
      empty.reflection.topic = typeof refl.topic === "string" ? refl.topic : null;
      const counters = (raw.counters ?? {}) as Record<string, unknown>;
      empty.proactive.sentToday = Number(counters.proactiveCountToday ?? 0);
      const gate = raw.lastGate as Record<string, unknown> | undefined;
      empty.proactive.lastGateReason = typeof gate?.reason === "string" ? gate.reason : null;
    }
    return empty;
  } catch (err) {
    return { ...empty, error: err instanceof Error ? err.message : String(err) };
  }
}

export interface LongrunResult {
  ok: boolean;
  tag: string;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  scenario: ScenarioName;
  turnsPlanned: number;
  turnsRun: number;
  budgetCny: number;
  budgetExceeded: boolean;
  voiceEnabled: boolean;
  photoProbability: number;
  isolation: {
    workDir: string;
    dataDir: string;
    wsUrl: string;
    healthUrl: string;
    kept: boolean;
    repoDataDir: string;
  };
  setup: { ok: boolean; detail: string; turns: number };
  turns: LongrunTurn[];
  metrics: LongrunMetrics;
  /** v0.5–v0.8 新机制的运行时状态（锚点/日记忆/主动/关系/反思）；老测试 fixture 可不传 */
  runtimeState?: RuntimeStateSnapshot;
  probes: ProbeOutcome[];
  fabrication: FabricationCheck | null;
  cost: {
    bridge: BridgeCostReportShape | null;
    simulator: UsageCost;
    reviewer: UsageCost;
    totalCny: number;
  };
  bridgeErrors: {
    count: number;
    events: Array<{ event: string; message: string }>;
    outputTail: string;
  };
  review: LlmReview | null;
  reviewError: string | null;
  autoObservations: string[];
  transcript: TranscriptTurn[];
  health: Record<string, unknown> | null;
  notes: string[];
}

export interface LongrunCliOptions {
  turns: number;
  scenario: ScenarioName;
  gapMs: number;
  out: string;
  keep: boolean;
  budgetCny: number;
  replyTimeoutMs: number;
  voice: boolean;
  photoProbability: number;
  review: boolean;
  tag: string;
}

export interface RepoDeepSeekEnv {
  apiKey: string;
  baseUrl?: string;
}

// ── 脱敏 / 数字工具 ─────────────────────────────

const SECRET_PATTERN = /sk-[A-Za-z0-9_-]{8,}/g;
const AUTH_PATTERN = /\b(?:authorization|access_token|api[_-]?key)\b\s*[:=]\s*[^\s,;]+/gi;

/** 报告/控制台输出前的统一脱敏：Key、鉴权头、非 mock 的 6-12 位数字（QQ 样式）。 */
export function maskSensitive(text: string): string {
  return text
    .replace(SECRET_PATTERN, "sk-***")
    .replace(AUTH_PATTERN, (m) => `${m.split(/[:=]/)[0]}=***`)
    .replace(/\b\d{6,12}\b/g, (m) =>
      m === String(MOCK_QQ) || m === String(BOT_QQ) ? m : "***",
    );
}

/** 报告里出现的主目录路径替换成 ~（避免泄露本机用户名）。 */
export function maskHomePath(value: string, home: string = os.homedir()): string {
  if (!home) return value;
  return value.split(home).join("~");
}

export function round(value: number, digits = 1): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

/** 最近秩百分位（p=0.5/0.95）；空数组返回 0。 */
export function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const clamped = Math.min(1, Math.max(0, p));
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil(clamped * sorted.length) - 1));
  return sorted[idx];
}

export function formatPct(ratio: number): string {
  return `${round(ratio * 100, 1)}%`;
}

export function formatSeconds(ms: number): string {
  return `${round(ms / 1000, 1)}s`;
}

export function formatCny(cny: number): string {
  return `¥${round(cny, 4).toFixed(4)}`;
}

// ── CQ / OneBot 出站解析（纯函数）───────────────

const CQ_REGEX = /\[CQ:([A-Za-z0-9_.-]+)((?:,[^\]]*)?)\]/g;

/** CQ 文本反转义（OneBot 规定 & [ ] , 的实体）。 */
export function decodeCqText(text: string): string {
  return text
    .replace(/&#91;/g, "[")
    .replace(/&#93;/g, "]")
    .replace(/&#44;/g, ",")
    .replace(/&amp;/g, "&");
}

function parseCqParams(raw: string): Record<string, string> {
  const params: Record<string, string> = {};
  if (!raw) return params;
  for (const pair of raw.replace(/^,/, "").split(",")) {
    const eq = pair.indexOf("=");
    if (eq <= 0) continue;
    params[pair.slice(0, eq).trim()] = pair.slice(eq + 1);
  }
  return params;
}

/** 从 base64:// 估算原始字节数（用于区分贴纸与照片）。 */
export function estimateBase64Bytes(value: string | undefined): number | undefined {
  if (typeof value !== "string" || !value.startsWith("base64://")) return undefined;
  const payloadLength = value.length - "base64://".length;
  if (payloadLength <= 0) return undefined;
  return Math.floor((payloadLength * 3) / 4);
}

const STICKER_MAX_BYTES = 12_000;

function segmentFromCq(type: string, params: Record<string, string>): CqSegment {
  switch (type) {
    case "text":
      return { kind: "text", text: decodeCqText(params.text ?? "") };
    case "image": {
      const bytes = estimateBase64Bytes(params.file);
      return {
        kind: "image",
        bytes,
        sticker: bytes !== undefined && bytes <= STICKER_MAX_BYTES,
      };
    }
    case "record": {
      const bytes = estimateBase64Bytes(params.file);
      return { kind: "record", bytes };
    }
    case "face":
      return { kind: "face" };
    case "mface":
      return { kind: "mface" };
    case "reply":
      return { kind: "reply" };
    case "at":
      return { kind: "at" };
    default:
      return { kind: "other", rawType: type };
  }
}

/**
 * 解析 OneBot 出站消息（string CQ 码 / segment 数组 / 单 segment 对象）。
 * 不保存图片 base64 本体，只估算字节数，避免把几十 MB 塞进内存/报告。
 */
export function parseOneBotMessage(message: unknown): CqSegment[] {
  if (typeof message === "string") {
    const segments: CqSegment[] = [];
    const regex = new RegExp(CQ_REGEX.source, "g");
    let lastIndex = 0;
    for (const match of message.matchAll(regex)) {
      const index = match.index ?? 0;
      if (index > lastIndex) {
        const text = decodeCqText(message.slice(lastIndex, index));
        if (text) segments.push({ kind: "text", text });
      }
      segments.push(segmentFromCq(match[1], parseCqParams(match[2] ?? "")));
      lastIndex = index + match[0].length;
    }
    if (lastIndex < message.length) {
      const text = decodeCqText(message.slice(lastIndex));
      if (text) segments.push({ kind: "text", text });
    }
    return segments.filter((seg) => seg.kind !== "text" || (seg.text ?? "").length > 0);
  }

  const items = Array.isArray(message) ? message : message && typeof message === "object" ? [message] : [];
  const segments: CqSegment[] = [];
  for (const item of items) {
    if (!item || typeof item !== "object") continue;
    const record = item as { type?: unknown; data?: unknown };
    if (typeof record.type !== "string") continue;
    const data = record.data && typeof record.data === "object" ? (record.data as Record<string, unknown>) : {};
    const params: Record<string, string> = {};
    for (const [key, value] of Object.entries(data)) {
      if (typeof value === "string") params[key] = value;
    }
    segments.push(segmentFromCq(record.type, params));
  }
  return segments.filter((seg) => seg.kind !== "text" || (seg.text ?? "").length > 0);
}

export function segmentsToText(segments: CqSegment[]): string {
  return segments
    .filter((seg) => seg.kind === "text")
    .map((seg) => seg.text ?? "")
    .join("");
}

export function hasMediaSegment(segments: CqSegment[]): boolean {
  return segments.some((seg) => seg.kind !== "text");
}

const MEDIA_LABELS: Record<MediaKind, string> = {
  text: "",
  image: "图片",
  record: "语音",
  face: "表情",
  mface: "表情包",
  reply: "引用",
  at: "@",
  other: "其它",
};

/** 报告用的媒体摘要，如 `["照片","表情"]`；图片按大小启发式区分照片/贴纸。 */
export function describeMedia(segments: CqSegment[]): string[] {
  const labels: string[] = [];
  for (const seg of segments) {
    if (seg.kind === "image") {
      labels.push(seg.sticker ? "贴纸" : "照片");
    } else if (seg.kind !== "text" && MEDIA_LABELS[seg.kind]) {
      labels.push(MEDIA_LABELS[seg.kind]);
    }
  }
  return labels;
}

// ── 消息门日志解析（用于 no_reply 快速分类） ─────

export interface BridgeLogEvent {
  at: number;
  level?: string;
  scope?: string;
  event: string;
  fields: Record<string, unknown>;
}

/** 解析 bridge 的结构化日志行（LOG_FORMAT=json）；非 JSON 行返回 null。 */
export function parseBridgeLogLine(line: string): BridgeLogEvent | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith("{")) return null;
  try {
    const parsed = JSON.parse(trimmed) as Record<string, unknown>;
    if (typeof parsed.event !== "string") return null;
    const at = typeof parsed.time === "string" ? Date.parse(parsed.time) : Number.NaN;
    return {
      at: Number.isFinite(at) ? at : Date.now(),
      level: typeof parsed.level === "string" ? parsed.level : undefined,
      scope: typeof parsed.scope === "string" ? parsed.scope : undefined,
      event: parsed.event,
      fields:
        parsed.fields && typeof parsed.fields === "object"
          ? (parsed.fields as Record<string, unknown>)
          : {},
    };
  } catch {
    return null;
  }
}

/** 收集 bridge 子进程 stdout/stderr：原始行（尾部）+ 结构化事件 + error 计数。 */
export class BridgeLogCollector {
  private readonly maxLines: number;
  private readonly lines: string[] = [];
  private pending = "";
  readonly events: BridgeLogEvent[] = [];
  errorCount = 0;
  totalChars = 0;

  constructor(maxLines = 4000) {
    this.maxLines = maxLines;
  }

  append(chunk: string): void {
    this.totalChars += chunk.length;
    this.pending += chunk;
    let newlineIndex = this.pending.indexOf("\n");
    while (newlineIndex >= 0) {
      const line = this.pending.slice(0, newlineIndex);
      this.pending = this.pending.slice(newlineIndex + 1);
      if (line.trim()) this.consumeLine(line);
      newlineIndex = this.pending.indexOf("\n");
    }
    if (this.pending.length > 20_000) {
      // 超长行（异常堆栈/大 JSON）截断保留，避免无限增长
      this.consumeLine(this.pending);
      this.pending = "";
    }
  }

  private consumeLine(line: string): void {
    this.lines.push(line);
    if (this.lines.length > this.maxLines) this.lines.shift();
    const event = parseBridgeLogLine(line);
    if (!event) return;
    this.events.push(event);
    if (this.events.length > 2000) this.events.shift();
    if (event.level === "error") this.errorCount += 1;
  }

  findEventSince(sinceMs: number, eventName: string): BridgeLogEvent | null {
    for (let i = this.events.length - 1; i >= 0; i--) {
      const event = this.events[i];
      if (event.event === eventName) return event.at >= sinceMs ? event : null;
    }
    return null;
  }

  errorEvents(): BridgeLogEvent[] {
    return this.events.filter((event) => event.level === "error");
  }

  tailLines(count = 60): string {
    return this.lines.slice(-count).join("\n");
  }

  flush(): void {
    if (this.pending.trim()) {
      this.consumeLine(this.pending);
      this.pending = "";
    }
  }
}

// ── 指标计算（纯函数）───────────────────────────

const EMOJI_REGEX = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u;
const KAOMOJI_REGEX = /[≧≦ω∀・▽￣´｀°˚﹏〃]/;
const AI_PHRASE_REGEX =
  /作为(?:一个)?(?:AI|人工智能|语言模型|虚拟人)|我是(?:一个)?(?:AI|人工智能|语言模型)|语言模型|人工智能助手/gi;
const BRACKET_ACTION_REGEX = /[（(][^）)\n]{1,24}[）)]/g;

function collectTextSegments(messages: CollectedMessage[]): string[] {
  const texts: string[] = [];
  for (const message of messages) {
    for (const segment of message.segments) {
      if (segment.kind === "text" && segment.text) texts.push(segment.text);
    }
  }
  return texts;
}

export function computeMetrics(turns: LongrunTurn[]): LongrunMetrics {
  const totalTurns = turns.length;
  const replied = turns.filter((turn) => turn.status === "reply");
  const noReplyTurns = totalTurns - replied.length;
  const noReplyReasons: Record<string, number> = {};
  for (const turn of turns) {
    if (turn.status === "reply") continue;
    const reason = turn.noReplyReason ?? "timeout";
    noReplyReasons[reason] = (noReplyReasons[reason] ?? 0) + 1;
  }

  const latencies = replied
    .map((turn) => turn.latencyMs)
    .filter((value): value is number => typeof value === "number");
  const latency = {
    p50: Math.round(percentile(latencies, 0.5)),
    p95: Math.round(percentile(latencies, 0.95)),
    max: latencies.length > 0 ? Math.round(Math.max(...latencies)) : 0,
    avg: latencies.length > 0 ? Math.round(latencies.reduce((a, b) => a + b, 0) / latencies.length) : 0,
  };

  const bubbles = replied.map((turn) => turn.outbound.length);
  const totalBubbles = bubbles.reduce((a, b) => a + b, 0);
  const multiBubbleTurns = bubbles.filter((count) => count >= 2).length;

  const textBubbles: string[] = [];
  const perTurnTextChars: number[] = [];
  let emojiKaomoji = 0;
  const media = { image: 0, imagePhoto: 0, imageSticker: 0, record: 0, face: 0, mface: 0 };
  const redlines: RedlineFlags = { emptyReplies: 0, aiPhrases: 0, bracketActions: 0, bracketSamples: [] };

  for (const turn of turns) {
    const turnTexts = collectTextSegments(turn.outbound);
    for (const text of turnTexts) {
      textBubbles.push(text);
      if (EMOJI_REGEX.test(text) || KAOMOJI_REGEX.test(text)) emojiKaomoji += 1;
      if (text.trim().length === 0) redlines.emptyReplies += 1;
    }
    perTurnTextChars.push(turnTexts.join("").length);

    for (const message of turn.outbound) {
      for (const segment of message.segments) {
        if (segment.kind === "image") {
          media.image += 1;
          if (segment.sticker) media.imageSticker += 1;
          else media.imagePhoto += 1;
        } else if (segment.kind === "record") media.record += 1;
        else if (segment.kind === "face") media.face += 1;
        else if (segment.kind === "mface") media.mface += 1;
      }
    }
  }

  // 产品红线扫描（她的全部文字）
  const allText = textBubbles.join("\n");
  for (const match of allText.matchAll(AI_PHRASE_REGEX)) {
    if (match[0].trim()) redlines.aiPhrases += 1;
  }
  for (const text of textBubbles) {
    for (const match of text.matchAll(BRACKET_ACTION_REGEX)) {
      redlines.bracketActions += 1;
      if (redlines.bracketSamples.length < 3) redlines.bracketSamples.push(match[0]);
    }
  }

  const replyTexts = turns
    .filter((turn) => turn.status === "reply")
    .map((turn) => collectTextSegments(turn.outbound).join(""))
    .filter((text) => text.length > 0);
  const repetition = summarizeRepetition("longrun", replyTexts);

  const totalTextChars = perTurnTextChars.reduce((a, b) => a + b, 0);

  return {
    turns: totalTurns,
    repliedTurns: replied.length,
    noReplyTurns,
    noReplyRate: totalTurns > 0 ? noReplyTurns / totalTurns : 0,
    noReplyReasons,
    latency,
    bubbles: {
      total: totalBubbles,
      avgPerReply: replied.length > 0 ? round(totalBubbles / replied.length, 2) : 0,
      multiBubbleTurns,
      multiBubbleRate: replied.length > 0 ? multiBubbleTurns / replied.length : 0,
    },
    text: {
      bubbles: textBubbles.length,
      avgPerReply: replied.length > 0 ? round(textBubbles.length / replied.length, 2) : 0,
      avgCharsPerBubble:
        textBubbles.length > 0 ? round(textBubbles.join("").length / textBubbles.length, 1) : 0,
      avgCharsPerTurn: replied.length > 0 ? round(totalTextChars / replied.length, 1) : 0,
      totalChars: totalTextChars,
    },
    emojiKaomoji,
    media,
    redlines,
    repetition: {
      avgScore: repetition.avgScore,
      maxScore: repetition.maxScore,
      duplicatePairs: repetition.duplicatePairs,
      questionReplies: repetition.questionReplies,
      formulaicHits: repetition.formulaicHits,
    },
    errorTurns: turns.filter((turn) => Boolean(turn.error)).length,
  };
}

/** 编造检测启发式：她给出的「认识场景」是否包含具体但不可能知道的细节。 */
const FABRICATION_MARKERS = [
  "咖啡店",
  "咖啡馆",
  "书店",
  "酒吧",
  "地铁",
  "下雨",
  "雨天",
  "聚会上",
  "朋友介绍",
  "同事介绍",
  "同学介绍",
  "相亲",
  "公司楼下",
  "网上认识",
  "微信上认识",
  "出差认识",
  "那天",
  "第一次见你",
];

export function detectFabrication(
  turns: LongrunTurn[],
  beats: ScenarioBeat[],
): FabricationCheck | null {
  const beat = beats.find((item) => item.probe === "fabrication-origin");
  if (!beat) return null;
  const turn = turns.find((item) => item.beatId === beat.id);
  if (!turn) return null;
  const answer = collectTextSegments(turn.outbound).join(" ");
  const markers = FABRICATION_MARKERS.filter((marker) => answer.includes(marker));
  return {
    beatId: beat.id,
    question: beat.fixedText ?? beat.intent,
    answer,
    markers,
    flagged: markers.length > 0,
  };
}

export function evaluateProbes(
  turns: LongrunTurn[],
  beats: ScenarioBeat[],
): ProbeOutcome[] {
  const outcomes: ProbeOutcome[] = [];
  for (const beat of beats) {
    if (!beat.probe || beat.probe === "fabrication-origin") continue;
    const turn = turns.find((item) => item.beatId === beat.id);
    if (!turn) continue;
    const answer = collectTextSegments(turn.outbound).join(" ");
    const expect = beat.expect ?? [];
    outcomes.push({
      key: beat.probe,
      beatId: beat.id,
      question: beat.fixedText ?? beat.intent,
      expect,
      passed: expect.length === 0 ? answer.length > 0 : expect.some((keyword) => answer.includes(keyword)),
      evidence: answer.slice(0, 160),
    });
  }
  return outcomes;
}

// ── 用户模拟器 / LLM 评审的 prompt 与解析（纯函数）──

export interface SimulatorContext {
  /** 最近几轮对话（user=模拟用户，her=她的回复） */
  recent: Array<{ user: string[]; her: string }>;
  /** 用户已经告诉过她的事实（用于提醒自己别自相矛盾） */
  facts: string[];
}

export function buildUserSimulatorMessages(
  beat: ScenarioBeat,
  context: SimulatorContext,
): OpenAI.Chat.Completions.ChatCompletionMessageParam[] {
  const system = [
    "你是「阿哲」，25 岁，在上海张江做程序员。性格有点憨、说话直，但会关心人。",
    "你正在 QQ 上和一个女生「小雅」私聊。你对她有点好感，但不会油腻。",
    "要求：",
    "- 只输出 1 条消息（需要强调时可 2 条），每条约 5-30 字，口语化，像真人打字；",
    "- 不要括号动作描写，不要客服腔，不要小作文，不要提 AI/模型/系统；",
    "- 不要机械复述「本轮意图」，用你自己的话说；",
    "- 偶尔可以有语气词/错别字（如 哈哈、emmm、卧槽、在嘛），但别每句都带；",
    '- 严格输出 JSON：{"messages":["..."]}，不要输出任何解释。',
  ].join("\n");

  const recentLines =
    context.recent.length === 0
      ? ["（还没有聊过）"]
      : context.recent.flatMap((item) => [
          `你: ${item.user.join(" / ")}`,
          `小雅: ${item.her || "（没回）"}`,
        ]);

  const burstHint = beat.burst ? "\n这次可以分 2 条短消息发出来（每条 5-15 字）。" : "";
  const factsHint =
    context.facts.length > 0 ? `\n你已经告诉过她的事实（这轮别自相矛盾）：${context.facts.join("；")}` : "";

  const user = [
    "最近的聊天：",
    ...recentLines,
    "",
    `你这一轮想表达的意思：${beat.intent}`,
    factsHint,
    burstHint,
    "",
    "请生成你接下来要发的消息。",
  ]
    .filter((line) => line !== "")
    .join("\n");

  return [
    { role: "system", content: system },
    { role: "user", content: user },
  ];
}

/** 解析模拟器输出：JSON messages / 行文本兜底；最多 2 条，清掉括号动作。 */
export function parseUserSimulatorOutput(content: string, fallbackText?: string): string[] {
  const cleaned = content.trim();
  const candidates: string[] = [];
  const jsonMatch = cleaned.match(/\{[\s\S]*\}/);
  if (jsonMatch) {
    try {
      const parsed = JSON.parse(jsonMatch[0]) as { messages?: unknown };
      if (Array.isArray(parsed.messages)) {
        for (const item of parsed.messages) {
          if (typeof item === "string" && item.trim()) candidates.push(item.trim());
        }
      }
    } catch {
      // fall through
    }
  }
  if (candidates.length === 0) {
    for (const line of cleaned.split(/\n+/)) {
      const text = line.replace(/^["'`\s-]+|["'`\s]+$/g, "").trim();
      if (text) candidates.push(text);
    }
  }
  const messages = candidates
    .map((text) => text.replace(BRACKET_ACTION_REGEX, "").replace(/\s+/g, " ").trim())
    .filter((text) => text.length > 0)
    .slice(0, 2)
    .map((text) => (text.length > 40 ? text.slice(0, 40) : text));
  if (messages.length > 0) return messages;
  return [fallbackText?.trim() || "嗯，我在呢。"];
}

export function buildReviewerMessages(transcript: TranscriptTurn[]): OpenAI.Chat.Completions.ChatCompletionMessageParam[] {
  const system = [
    "你是 QQ 角色扮演产品的质量评审。评审对象是 AI 角色「小雅」的聊天表现。",
    "用户是模拟的 25 岁上海男生。媒体消息在记录里用 [图片]/[贴纸]/[表情]/[语音] 标注。",
    "请按 1-5 分整数打分（5=很好，1=很差）：",
    "1) realism 真人感：像不像一个真实的人，而不是 AI 助手/客服；",
    "2) coherence 连贯性：上下文承接是否自然、有没有答非所问；",
    "3) initiative 主动性：会不会自己开启话题/分享生活，而不是只被动回答；",
    "4) multimedia 多媒体自然度：照片/表情/语音是否像真人顺手发的、时机与配文是否自然；没有多媒体时给 3 分并说明；",
    "5) memory 记忆一致性：是否记住用户说过的稳定事实、是否编造不知道的往事。",
    "严格输出 JSON，不要输出其它内容：",
    '{"realism":4,"coherence":4,"initiative":3,"multimedia":3,"memory":4,',
    '"reasons":{"realism":"1-2句","coherence":"1-2句","initiative":"1-2句","multimedia":"1-2句","memory":"1-2句"},',
    '"top_issues":["最多3条最影响真人感的问题"],"summary":"2-3句总评"}',
  ].join("\n");
  const lines = transcript.map((turn) => {
    const media = turn.media.length > 0 ? ` ${turn.media.map((label) => `[${label}]`).join(" ")}` : "";
    return `第${turn.index}轮\n我：${turn.user.join(" / ") || "（无）"}\n小雅：${turn.her || "（没回）"}${media}`;
  });
  return [
    { role: "system", content: system },
    { role: "user", content: `聊天记录：\n\n${lines.join("\n\n")}\n\n请给分并输出 JSON。` },
  ];
}

function clampScore(value: unknown, fallback = 3): number {
  const num = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(num)) return fallback;
  return Math.min(5, Math.max(1, Math.round(num)));
}

/** 解析 LLM 评审 JSON；解析失败返回 null（不抛错）。 */
export function parseReviewerOutput(content: string): LlmReview | null {
  const match = content.match(/\{[\s\S]*\}/);
  if (!match) return null;
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(match[0]) as Record<string, unknown>;
  } catch {
    return null;
  }
  const reasonsRaw = parsed.reasons && typeof parsed.reasons === "object" ? (parsed.reasons as Record<string, unknown>) : {};
  const reasons: Record<string, string> = {};
  for (const key of ["realism", "coherence", "initiative", "multimedia", "memory"]) {
    reasons[key] = typeof reasonsRaw[key] === "string" ? (reasonsRaw[key] as string) : "";
  }
  const topIssues = Array.isArray(parsed.top_issues)
    ? parsed.top_issues.filter((item): item is string => typeof item === "string").slice(0, 5)
    : [];
  return {
    realism: clampScore(parsed.realism),
    coherence: clampScore(parsed.coherence),
    initiative: clampScore(parsed.initiative),
    multimedia: clampScore(parsed.multimedia),
    memory: clampScore(parsed.memory),
    reasons,
    topIssues,
    summary: typeof parsed.summary === "string" ? parsed.summary : "",
  };
}

// ── 报告渲染（纯函数）───────────────────────────

const MANUAL_BEGIN = "<!-- MANUAL:BEGIN -->";
const MANUAL_END = "<!-- MANUAL:END -->";

/** 从已有报告中提取人工观察段落（重跑时保留，避免覆盖人工结论）。 */
export function extractManualSection(report: string | null | undefined): string | null {
  if (!report) return null;
  const begin = report.indexOf(MANUAL_BEGIN);
  const end = report.indexOf(MANUAL_END);
  if (begin < 0 || end < 0 || end <= begin) return null;
  return report.slice(begin, end + MANUAL_END.length);
}

function tableRow(cells: Array<string | number>): string {
  return `| ${cells.map((cell) => String(cell)).join(" | ")} |`;
}

function renderProbeTable(probes: ProbeOutcome[]): string[] {
  if (probes.length === 0) return ["（本轮没有记忆探针）"];
  const lines = ["| 探针 | 问题 | 期望 | 结果 | 她的回答（截断） |", "|---|---|---|---|---|"];
  for (const probe of probes) {
    lines.push(
      tableRow([
        probe.key,
        maskSensitive(probe.question).slice(0, 40),
        probe.expect.join(" / "),
        probe.passed ? "✅ 通过" : "❌ 未通过",
        maskSensitive(probe.evidence).slice(0, 80) || "（无回复）",
      ]),
    );
  }
  return lines;
}

function renderTurnTable(turns: LongrunTurn[]): string[] {
  if (turns.length === 0) return ["（无回合）"];
  const lines = [
    "| # | 标签 | 延迟 | 气泡 | 媒体 | 首条/回复摘要（截断，脱敏） |",
    "|---|---|---|---|---|---|",
  ];
  for (const turn of turns) {
    const media = turn.outbound.flatMap((message) => describeMedia(message.segments));
    const herText = turn.outbound.map((message) => message.text).filter((text) => text.length > 0).join(" / ");
    lines.push(
      tableRow([
        turn.index,
        turn.tag,
        turn.latencyMs !== null ? formatSeconds(turn.latencyMs) : "—",
        turn.outbound.length,
        media.length > 0 ? [...new Set(media)].join("+") : "—",
        turn.status === "reply"
          ? maskSensitive(herText).slice(0, 80) || "（仅媒体）"
          : `no_reply(${turn.noReplyReason ?? "timeout"})`,
      ]),
    );
  }
  return lines;
}

function renderFullTranscript(turns: LongrunTurn[]): string[] {
  if (turns.length === 0) return ["（无对话）"];
  const lines: string[] = [];
  for (const turn of turns) {
    for (const text of turn.sentTexts) {
      lines.push(`**我（第 ${turn.index} 轮/${turn.tag}）**：${maskSensitive(text).slice(0, 200)}`);
    }
    const media = turn.outbound
      .filter((message) => !message.recalled)
      .flatMap((message) => describeMedia(message.segments));
    const herParts: string[] = [];
    for (const message of turn.outbound) {
      if (message.recalled) {
        herParts.push("〔她撤回了一条消息〕");
        continue;
      }
      if (message.text.trim()) herParts.push(maskSensitive(message.text).slice(0, 200));
    }
    lines.push(`**她**：${herParts.join(" / ") || "（没回文字）"}${media.length > 0 ? `  ${media.map((label) => `[${label}]`).join("")}` : ""}`);
    lines.push("");
  }
  return lines;
}

function renderCostTable(result: LongrunResult): string[] {
  const bridge = result.cost.bridge;
  const lines = [
    "| 项目 | calls | prompt tokens | completion tokens | 成本 |",
    "|---|---|---|---|---|",
    tableRow([
      "bridge（chat+旁路）",
      bridge?.total.calls ?? "—",
      bridge?.total.prompt_tokens ?? "—",
      bridge?.total.completion_tokens ?? "—",
      bridge ? formatCny(bridge.total.cost_cny) : "—",
    ]),
    tableRow([
      "用户模拟器",
      result.cost.simulator.calls,
      result.cost.simulator.promptTokens,
      result.cost.simulator.completionTokens,
      formatCny(result.cost.simulator.costCny),
    ]),
    tableRow([
      "LLM 评审",
      result.cost.reviewer.calls,
      result.cost.reviewer.promptTokens,
      result.cost.reviewer.completionTokens,
      formatCny(result.cost.reviewer.costCny),
    ]),
    tableRow(["**合计**", "", "", "", `**${formatCny(result.cost.totalCny)}**`]),
  ];
  if (bridge?.by_kind && bridge.by_kind.length > 0) {
    lines.push("", "按用途拆分（bridge）：", "", "| 用途 | calls | 成本 |", "|---|---|---|");
    for (const kind of bridge.by_kind) {
      lines.push(tableRow([kind.kind, kind.calls, formatCny(kind.cost_cny)]));
    }
  }
  return lines;
}

export function renderReport(result: LongrunResult, existingReport?: string | null): string {
  const manual = extractManualSection(existingReport) ?? [
    MANUAL_BEGIN,
    "## 人工观察（本段由评测人填写；重跑脚本会自动保留）",
    "",
    "- （待填）真人感问题 1：",
    "- （待填）真人感问题 2：",
    "- （待填）真人感问题 3：",
    "- （待填）优化建议：",
    MANUAL_END,
  ].join("\n");

  const m = result.metrics;
  const lines: string[] = [];
  lines.push("# Karen 真实验证台报告（mock OneBot + 真实 DeepSeek）");
  lines.push("");
  lines.push(
    `> 生成时间：${result.finishedAt} ｜ 运行标签：\`${result.tag}\` ｜ 场景：\`${result.scenario}\` ｜ 计划/实跑：${result.turnsPlanned}/${result.turnsRun} 轮 ｜ 语音：${result.voiceEnabled ? "开" : "关"} ｜ 耗时：${formatSeconds(result.durationMs)}`,
  );
  lines.push(">");
  lines.push("> 说明：用户由另一个 DeepSeek 调用模拟（25 岁上海男生「阿哲」），**不是真人**；NapCat 由本脚本 mock；bridge 与真实模型均真实运行，数据只写临时目录。");
  lines.push("");

  lines.push("## 1. 结论摘要");
  lines.push("");
  lines.push(
    `- 链路：${result.setup.ok ? "✅ 18+ 门通过，真实模型回复正常" : "❌ 18+ 门未通过"}；bridge 错误日志 ${result.bridgeErrors.count} 条；预算 ${result.budgetExceeded ? "⚠️ 提前触顶" : "未触顶"}（上限 ${formatCny(result.budgetCny)}）`,
  );
  lines.push(
    `- 回合：${result.turnsRun} 轮，有回复 ${m.repliedTurns}，no_reply ${m.noReplyTurns}（${formatPct(m.noReplyRate)}${Object.keys(m.noReplyReasons).length > 0 ? `；${Object.entries(m.noReplyReasons).map(([k, v]) => `${k}=${v}`).join("，")}` : ""}）`,
  );
  lines.push(
    `- 延迟：p50 ${formatSeconds(m.latency.p50)} / p95 ${formatSeconds(m.latency.p95)} / max ${formatSeconds(m.latency.max)}`,
  );
  lines.push(
    `- 多媒体：照片 ${m.media.imagePhoto}、贴纸 ${m.media.imageSticker}、QQ 表情 ${m.media.face}、表情包 ${m.media.mface}、语音 ${m.media.record}`,
  );
  lines.push(
    `- 记忆探针：${result.probes.filter((p) => p.passed).length}/${result.probes.length} 通过；编造检测：${result.fabrication?.flagged ? "⚠️ 命中启发式标记" : "未命中启发式标记"}`,
  );
  lines.push(`- 成本：${formatCny(result.cost.totalCny)}（bridge ${result.cost.bridge ? formatCny(result.cost.bridge.total.cost_cny) : "—"} + 模拟器/评审 ${formatCny(result.cost.simulator.costCny + result.cost.reviewer.costCny)}）`);
  if (result.review) {
    lines.push(
      `- LLM 评审：真人感 ${result.review.realism}/5、连贯 ${result.review.coherence}/5、主动 ${result.review.initiative}/5、多媒体 ${result.review.multimedia}/5、记忆 ${result.review.memory}/5`,
    );
  }
  lines.push("");

  lines.push("## 2. 隔离与配置自检（安全红线）");
  lines.push("");
  lines.push("| 项 | 值 |");
  lines.push("|---|---|");
  lines.push(tableRow(["workdir", maskHomePath(result.isolation.workDir) + (result.isolation.kept ? "（--keep 保留）" : "（跑完已删除）")]));
  lines.push(tableRow(["KAREN_DATA_DIR", maskHomePath(result.isolation.dataDir)]));
  lines.push(tableRow(["OneBot WS", result.isolation.wsUrl]));
  lines.push(tableRow(["health /cost", result.isolation.healthUrl]));
  lines.push(tableRow(["web_port", `${WEB_PORT_DISABLED}（关闭）`]));
  lines.push(tableRow(["禁止端口", FORBIDDEN_PORTS.join(" / ") + "（未使用）"]));
  lines.push(tableRow(["allowed_users", String(MOCK_QQ)]));
  lines.push(tableRow(["真实 data/", "未读写（" + maskHomePath(result.isolation.repoDataDir) + "）"]));
  lines.push("");
  lines.push(
    `准备步骤：${result.setup.turns} 轮（${result.setup.ok ? "通过" : "失败"}）— ${maskSensitive(result.setup.detail)}`,
  );
  if (result.health) {
    const health = result.health;
    lines.push(
      `bridge /health：db_ok=${String(health.db_ok)} ws_connections=${String(health.ws_connections)} pending_replies=${String(health.pending_replies)} cost_today=${String(health.cost_today)}`,
    );
  }
  if (result.bridgeErrors.count > 0) {
    lines.push(`bridge error 日志 ${result.bridgeErrors.count} 条（最近 ${result.bridgeErrors.events.length} 条）：`);
    for (const event of result.bridgeErrors.events) {
      lines.push(`- \`${event.event}\`：${event.message}`);
    }
  } else {
    lines.push("bridge error 日志：0 条");
  }
  for (const note of result.notes) lines.push(`- 备注：${maskSensitive(note)}`);
  lines.push("");

  lines.push("## 3. 关键指标");
  lines.push("");
  lines.push("| 指标 | 数值 |");
  lines.push("|---|---|");
  lines.push(tableRow(["回合数", m.turns]));
  lines.push(tableRow(["有回复回合", `${m.repliedTurns}（${formatPct(m.turns > 0 ? m.repliedTurns / m.turns : 0)}）`]));
  lines.push(tableRow(["no_reply 率", `${formatPct(m.noReplyRate)}（${m.noReplyTurns} 轮）`]));
  lines.push(tableRow(["延迟 p50 / p95 / max", `${formatSeconds(m.latency.p50)} / ${formatSeconds(m.latency.p95)} / ${formatSeconds(m.latency.max)}`]));
  lines.push(tableRow(["平均首条延迟", formatSeconds(m.latency.avg)]));
  lines.push(tableRow(["气泡总数 / 平均每条回复", `${m.bubbles.total} / ${m.bubbles.avgPerReply}`]));
  lines.push(tableRow(["多气泡率（≥2 条）", `${formatPct(m.bubbles.multiBubbleRate)}（${m.bubbles.multiBubbleTurns} 轮）`]));
  lines.push(tableRow(["文字气泡数 / 平均每轮", `${m.text.bubbles} / ${m.text.avgPerReply}`]));
  lines.push(tableRow(["平均每条文字气泡字数", m.text.avgCharsPerBubble]));
  lines.push(tableRow(["平均每轮文字字数", m.text.avgCharsPerTurn]));
  lines.push(tableRow(["颜文字/emoji（启发式）", m.emojiKaomoji]));
  lines.push(tableRow(["照片 / 贴纸 / QQ表情 / 表情包 / 语音", `${m.media.imagePhoto} / ${m.media.imageSticker} / ${m.media.face} / ${m.media.mface} / ${m.media.record}`]));
  lines.push(tableRow(["错误回合", m.errorTurns]));
  lines.push("");

  lines.push("## 4. 记忆探针与编造检测");
  lines.push("");
  lines.push(...renderProbeTable(result.probes));
  lines.push("");
  if (result.fabrication) {
    lines.push(
      `**编造检测**（问「我们怎么认识的」）：${result.fabrication.flagged ? "⚠️ 启发式命中具体场景标记" : "✅ 未出现具体虚构场景标记**（仅启发式，需结合 LLM 评审）"}`,
    );
    if (result.fabrication.markers.length > 0) {
      lines.push(`- 命中标记：${result.fabrication.markers.join("、")}`);
    }
    lines.push(`- 她的回答：${maskSensitive(result.fabrication.answer).slice(0, 200) || "（无回复）"}`);
  } else {
    lines.push("（本轮未包含编造检测）");
  }
  lines.push("");

  // ── 4b. 新机制运行时状态（v0.5–v0.8）─────────────────
  {
    const rs = result.runtimeState;
    if (!rs) {
      lines.push("## 4b. 新机制运行时状态（v0.5–v0.8，读自临时库/状态文件）");
      lines.push("");
      lines.push("> 本次运行未采集（旧版 fixture / 未传入 runtimeState）。");
      lines.push("");
    } else {
      lines.push("## 4b. 新机制运行时状态（v0.5–v0.8，读自临时库/状态文件）");
      lines.push("");
      if (rs.error) {
        lines.push(`> ⚠️ 读取状态失败：${rs.error}（不影响其它指标）`);
      } else {
        const dims = rs.relationship.dims;
        lines.push("| 机制 | 是否触发 | 证据 |");
        lines.push("| --- | --- | --- |");
        lines.push(
          `| 锚点记忆 | ${rs.anchors.count > 0 ? "✅" : "—（21 轮闲聊里没有值得长期记的事件）"} | ${rs.anchors.count} 条${rs.anchors.kinds.length ? `（${rs.anchors.kinds.join("/")}）` : ""} |`,
        );
        lines.push(
          `| 日记忆 / 周汇总 | ${rs.digests.daily + rs.digests.weekly > 0 ? "✅" : "—（需跨天/心跳才生成）"} | 日 ${rs.digests.daily} 条 / 周 ${rs.digests.weekly} 条 |`,
        );
        lines.push(`| 用户事实 | ${rs.facts > 0 ? "✅" : "—"} | ${rs.facts} 条 |`);
        lines.push(
          `| 表情包收集 | ${rs.stickers > 0 ? "✅" : "—（采集开关默认关）"} | ${rs.stickers} 张 |`,
        );
        lines.push(
          `| 意图式主动 | ${rs.initiative.planItems > 0 ? "✅" : "—（需心跳生成计划）"} | 今日由头 ${rs.initiative.planItems} 个 / 已发 ${rs.initiative.sent} 次 |`,
        );
        lines.push(
          `| 五维关系 | ${dims ? "✅" : "—"} | 亲密度 ${rs.relationship.closeness.toFixed(2)}${dims ? `；亲密 ${dims.intimacy} / 信任 ${dims.trust} / 张力 ${dims.tension} / 互惠 ${dims.reciprocity} / 依赖 ${dims.dependency}` : ""} |`,
        );
        lines.push(
          `| 反思循环 | ${rs.reflection.phase !== "none" ? "✅" : "—（触发需被点破或同类信号反复）"} | 阶段 ${rs.reflection.phase}${rs.reflection.topic ? `（${rs.reflection.topic}）` : ""} |`,
        );
        lines.push(
          `| 主动计数/门控 | — | 今日已发 ${rs.proactive.sentToday}；最近门控原因 ${rs.proactive.lastGateReason ?? "无"} |`,
        );
        lines.push("");
        lines.push(
          "> 说明：「—」不是失败——这些机制依赖跨天心跳、越界/冲突事件或显式开关，21 轮纯闲聊本就不一定触发；本表的价值是**把「有没有接线」变成可观察**，而不是强求每次都触发。",
        );
      }
    }
  }

  lines.push("## 5. 重复度与产品红线");
  lines.push("");
  lines.push("| 指标 | 数值 |");
  lines.push("|---|---|");
  lines.push(tableRow(["相邻回复相似度 平均/最高", `${m.repetition.avgScore} / ${m.repetition.maxScore}`]));
  lines.push(tableRow(["复读对（bigram/开头/前缀）", m.repetition.duplicatePairs]));
  lines.push(tableRow(["以问句收尾的回复", m.repetition.questionReplies]));
  lines.push(tableRow(["套话句式命中", m.repetition.formulaicHits]));
  lines.push(tableRow(["空回复", m.redlines.emptyReplies]));
  lines.push(tableRow(["「作为AI/语言模型」措辞", m.redlines.aiPhrases]));
  lines.push(tableRow(["括号动作描写（产品红线）", m.redlines.bracketActions]));
  if (m.redlines.bracketSamples.length > 0) {
    lines.push(`- 括号样例：${m.redlines.bracketSamples.map((sample) => `\`${maskSensitive(sample)}\``).join("、")}`);
  }
  lines.push("");

  lines.push("## 6. 真实成本");
  lines.push("");
  lines.push(...renderCostTable(result));
  lines.push("");
  lines.push(
    `- 预算：${formatCny(result.budgetCny)}${result.budgetExceeded ? "（**已触顶提前停止**）" : "（未触顶）"}；本机估算再跑一次约 ${formatCny(result.cost.totalCny)}（不含时间成本）。`,
  );
  lines.push("");

  lines.push("## 7. LLM 评审（1-5 分）");
  lines.push("");
  if (result.review) {
    lines.push("| 维度 | 分数 | 理由 |");
    lines.push("|---|---|---|");
    const dims: Array<[string, keyof LlmReview, string]> = [
      ["真人感", "realism", "realism"],
      ["连贯性", "coherence", "coherence"],
      ["主动性", "initiative", "initiative"],
      ["多媒体自然度", "multimedia", "multimedia"],
      ["记忆一致性", "memory", "memory"],
    ];
    for (const [label, key, reasonKey] of dims) {
      lines.push(tableRow([label, String(result.review[key]), maskSensitive(result.review.reasons[reasonKey] ?? "")]));
    }
    lines.push("");
    if (result.review.topIssues.length > 0) {
      lines.push("最影响真人感的问题：");
      for (const issue of result.review.topIssues) lines.push(`- ${maskSensitive(issue)}`);
      lines.push("");
    }
    if (result.review.summary) {
      lines.push(`总评：${maskSensitive(result.review.summary)}`);
      lines.push("");
    }
  } else {
    lines.push(`（LLM 评审未生成${result.reviewError ? `：${maskSensitive(result.reviewError)}` : ""}）`);
    lines.push("");
  }

  lines.push("## 8. 自动观察");
  lines.push("");
  for (const observation of result.autoObservations) lines.push(`- ${observation}`);
  lines.push("");

  lines.push(manual);
  lines.push("");

  lines.push("## 9. 逐轮明细与对话原文（脱敏）");
  lines.push("");
  lines.push(...renderTurnTable(result.turns));
  lines.push("");
  lines.push("### 对话原文");
  lines.push("");
  lines.push(...renderFullTranscript(result.turns));
  lines.push("");

  lines.push("## 10. 如何重跑");
  lines.push("");
  lines.push("```bash");
  lines.push(
    `export PATH="$PWD/.runtime/node22/bin:$PATH"`,
  );
  lines.push(
    `.runtime/node22/bin/node node_modules/tsx/dist/cli.mjs scripts/mock-onebot-longrun.ts \\`,
  );
  lines.push(
    `  --scenario daily --turns 15 --gap-ms 12000 --budget-cny 0.5 ${
      result.voiceEnabled ? "--voice " : ""
    }`,
  );
  lines.push("```");
  lines.push("");
  lines.push(
    `- 本次单轮平均耗时 ${formatSeconds(result.turnsRun > 0 ? result.durationMs / result.turnsRun : 0)}；15 轮预计约 ${formatSeconds((result.turnsRun > 0 ? result.durationMs / result.turnsRun : 0) * 15)}。`,
  );
  if (result.notes.length > 0) {
    lines.push("");
    lines.push("运行备注：");
    for (const note of result.notes) lines.push(`- ${maskSensitive(note)}`);
  }
  lines.push("");

  return lines.join("\n");
}

// ── CLI 参数（纯函数）───────────────────────────

export const LONGRUN_USAGE = `用法：
  .runtime/node22/bin/node node_modules/tsx/dist/cli.mjs scripts/mock-onebot-longrun.ts [选项]

选项：
  --turns N              场景轮数（默认 ${DEFAULT_TURNS}，最多 ${DAILY_SCENARIO.length}）
  --scenario daily       场景名（目前只有 daily）
  --gap-ms N             每轮之间基础间隔（默认 12000，范围 1000-60000，会加 0~50% 抖动）
  --budget-cny N         成本上限（元，默认 1.0；触顶提前停）
  --reply-timeout-ms N   单轮等待首条回复上限（默认 90000）
  --photo-probability N  主动发图概率覆盖（0-1，默认 0.3，便于观察照片链路）
  --no-voice             关闭语音发送（默认开启；语音已接线，基线会收集语音）
  --out PATH             报告输出路径（默认 ${DEFAULT_REPORT_PATH}）
  --tag NAME             报告里的运行标签（默认自动按时间生成）
  --keep                 保留临时 workdir（调试用；默认跑完删除）
  --no-review            跳过 LLM 评审（省钱）
  --help                 显示本帮助
`;

function parsePositiveInt(value: string | undefined, flag: string): number {
  const num = Number(value);
  if (!Number.isFinite(num) || !Number.isInteger(num)) throw new Error(`${flag} 需要整数，收到: ${String(value)}`);
  return num;
}

function parseNumberFlag(value: string | undefined, flag: string, min: number, max: number): number {
  const num = Number(value);
  if (!Number.isFinite(num) || num < min || num > max) {
    throw new Error(`${flag} 需要 ${min}-${max} 的数字，收到: ${String(value)}`);
  }
  return num;
}

/** 解析 CLI 参数；未知参数/非法值抛错（由入口打印 usage）。 */
export function parseLongrunCliArgs(argv: string[]): LongrunCliOptions {
  const options: LongrunCliOptions = {
    turns: DEFAULT_TURNS,
    scenario: "daily",
    gapMs: 12_000,
    out: DEFAULT_REPORT_PATH,
    keep: false,
    budgetCny: 1.0,
    replyTimeoutMs: DEFAULT_REPLY_TIMEOUT_MS,
    // 语音链路已由 Lead 接线并通过真实链路验证：基线默认开启（--no-voice 可关）
    voice: true,
    photoProbability: 0.3,
    review: true,
    tag: defaultRunTag(),
  };
  const valueFlags = new Set([
    "--turns",
    "--scenario",
    "--gap-ms",
    "--budget-cny",
    "--reply-timeout-ms",
    "--photo-probability",
    "--out",
    "--tag",
  ]);
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith("--")) throw new Error(`无法识别的参数: ${arg}`);
    if (arg === "--keep") {
      options.keep = true;
      continue;
    }
    if (arg === "--voice") {
      options.voice = true;
      continue;
    }
    if (arg === "--no-voice") {
      options.voice = false;
      continue;
    }
    if (arg === "--no-review") {
      options.review = false;
      continue;
    }
    if (!valueFlags.has(arg)) throw new Error(`未知参数: ${arg}`);
    const value = argv[++i];
    if (value === undefined) throw new Error(`${arg} 缺少值`);
    switch (arg) {
      case "--turns": {
        const turns = parsePositiveInt(value, arg);
        if (turns < 1 || turns > DAILY_SCENARIO.length) {
          throw new Error(`--turns 需要 1-${DAILY_SCENARIO.length}，收到: ${turns}`);
        }
        options.turns = turns;
        break;
      }
      case "--scenario":
        if (value !== "daily") throw new Error(`未知场景: ${value}（目前只有 daily）`);
        options.scenario = "daily";
        break;
      case "--gap-ms":
        options.gapMs = parsePositiveInt(value, arg);
        if (options.gapMs < 1000 || options.gapMs > 60_000) throw new Error("--gap-ms 需要 1000-60000");
        break;
      case "--budget-cny":
        options.budgetCny = parseNumberFlag(value, arg, 0.01, 100);
        break;
      case "--reply-timeout-ms":
        options.replyTimeoutMs = parsePositiveInt(value, arg);
        if (options.replyTimeoutMs < 5000 || options.replyTimeoutMs > 300_000) {
          throw new Error("--reply-timeout-ms 需要 5000-300000");
        }
        break;
      case "--photo-probability":
        options.photoProbability = parseNumberFlag(value, arg, 0, 1);
        break;
      case "--out":
        options.out = value;
        break;
      case "--tag":
        options.tag = value;
        break;
      default:
        throw new Error(`未知参数: ${arg}`);
    }
  }
  return options;
}

// ── 环境 / 隔离 / 端口（真实运行）───────────────

/** 从仓库根 .env 读 DeepSeek 配置（不打印、不回显）；缺失时抛清晰错误。 */
export function readRepoDeepSeekEnv(repoRoot: string = REPO_ROOT): RepoDeepSeekEnv {
  const envPath = path.join(repoRoot, ".env");
  if (!fs.existsSync(envPath)) {
    throw new Error(`找不到 ${envPath}：真实验证台需要 DEEPSEEK_API_KEY（可复制 .env.example）`);
  }
  const values = new Map<string, string>();
  for (const line of fs.readFileSync(envPath, "utf8").split(/\r?\n/)) {
    const match = /^\s*([A-Za-z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
    if (!match) continue;
    let value = match[2].trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    values.set(match[1], value);
  }
  const apiKey = values.get("DEEPSEEK_API_KEY");
  if (!apiKey || apiKey.trim() === "" || apiKey.includes("your-key-here")) {
    throw new Error(".env 里的 DEEPSEEK_API_KEY 未配置或仍是占位值");
  }
  const baseUrl = values.get("DEEPSEEK_BASE_URL")?.trim();
  return { apiKey: apiKey.trim(), baseUrl: baseUrl && baseUrl.length > 0 ? baseUrl : undefined };
}

/** 端口自检：拒绝真实桥接端口，且 ws/health 不能相同。 */
export function assertSafePorts(wsPort: number, healthPort: number): void {
  for (const port of [wsPort, healthPort]) {
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      throw new Error(`端口非法: ${port}（应为 1-65535 的整数）`);
    }
    if (FORBIDDEN_PORTS.includes(port)) {
      throw new Error(
        `端口红线：${port} 是用户真实桥接/健康/Web 端口，禁止占用（mock 用 ${WS_PORT}/${HEALTH_PORT}）`,
      );
    }
  }
  if (wsPort === healthPort) throw new Error(`WS 端口与 health 端口不能相同: ${wsPort}`);
  if (wsPort === WEB_PORT_DISABLED || healthPort === WEB_PORT_DISABLED) {
    throw new Error("mock 运行不允许把 WS/health 端口设为 0");
  }
}

/** 隔离自检：workdir 必须在系统临时目录下、dataDir 在 workdir 内、整体不在仓库下。 */
export function assertIsolatedWorkspace(repoRoot: string, workDir: string, dataDir: string): void {
  const tmpRoot = fs.realpathSync(os.tmpdir());
  const workReal = fs.realpathSync(workDir);
  const relativeToRepo = path.relative(path.resolve(repoRoot), path.resolve(workDir));
  const insideRepo = relativeToRepo !== "" && !relativeToRepo.startsWith("..") && !path.isAbsolute(relativeToRepo);
  if (insideRepo) throw new Error(`隔离失败：临时 workdir 落在仓库内（${workDir}）`);
  const underTmp = workReal === tmpRoot || workReal.startsWith(tmpRoot + path.sep);
  if (!underTmp) throw new Error(`隔离失败：workdir 不在系统临时目录（${workDir}）`);
  const relativeData = path.relative(path.resolve(workDir), path.resolve(dataDir));
  if (relativeData.startsWith("..") || path.isAbsolute(relativeData)) {
    throw new Error(`隔离失败：KAREN_DATA_DIR 不在 workdir 内（${dataDir}）`);
  }
  if (path.resolve(dataDir) === path.resolve(repoRoot, "data")) {
    throw new Error("隔离失败：KAREN_DATA_DIR 指向仓库 data/");
  }
}

/** 检测端口是否可绑定（被占用/被真实桥接占用 → 直接失败，不冒险）。 */
export async function isPortFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once("error", () => resolve(false));
    server.listen(port, "127.0.0.1", () => {
      server.close(() => resolve(true));
    });
  });
}

export interface MockWorkspace {
  workDir: string;
  dataDir: string;
  configPath: string;
  wsPort: number;
  healthPort: number;
}

export interface PrepareWorkspaceOptions {
  voice: boolean;
  photoProbability: number;
  turns: number;
}

function buildMockConfigYaml(options: PrepareWorkspaceOptions): string {
  return [
    "# 真实验证台临时配置（mock OneBot + 真实 DeepSeek）——跑完即删",
    'persona: "xiaoya"',
    'her_name: "小雅"',
    'your_name: "阿哲"',
    'location: "上海"',
    "tags: []",
    `allowed_users: [${MOCK_QQ}]`,
    'one_bot_ws_host: "127.0.0.1"',
    `one_bot_ws_port: ${WS_PORT}`,
    `one_bot_ws_path: "${WS_PATH}"`,
    `one_bot_token: "${MOCK_WS_TOKEN}"`,
    "quiet_hours_start: 0",
    "quiet_hours_end: 0",
    "ai_disclosure: false",
    "age_gate_enabled: true",
    "photo_share_min_closeness: 0",
    `photo_share_probability: ${options.photoProbability}`,
    "photo_share_cooldown_minutes: 0",
    `voice_enabled: ${options.voice ? "true" : "false"}`,
    "voice_probability: 0.6",
    "voice_min_closeness: 0",
    "voice_cooldown_minutes: 0",
    "voice_max_chars: 40",
    "message_frequency_limit: 60",
    `health_port: ${HEALTH_PORT}`,
    `web_port: ${WEB_PORT_DISABLED}`,
    'log_level: "info"',
    "",
  ].join("\n");
}

/** 创建临时工作区：复制 personas、写 config.yaml、建 data 目录；并做隔离/端口自检。 */
export async function prepareWorkspace(
  repoRoot: string,
  options: PrepareWorkspaceOptions,
): Promise<MockWorkspace> {
  assertSafePorts(WS_PORT, HEALTH_PORT);
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "karen-mock-longrun-"));
  const dataDir = path.join(workDir, "data");
  fs.mkdirSync(dataDir, { recursive: true });
  // 人设与本地素材按 cwd/入口路径解析：复制到临时工作区，避免运行中新增文件写回仓库
  fs.cpSync(path.join(repoRoot, "personas"), path.join(workDir, "personas"), { recursive: true });
  if (fs.existsSync(path.join(repoRoot, "assets"))) {
    fs.cpSync(path.join(repoRoot, "assets"), path.join(workDir, "assets"), { recursive: true });
  }
  const configPath = path.join(workDir, "config.yaml");
  fs.writeFileSync(configPath, buildMockConfigYaml(options), "utf8");
  assertIsolatedWorkspace(repoRoot, workDir, dataDir);
  const [wsFree, healthFree] = await Promise.all([isPortFree(WS_PORT), isPortFree(HEALTH_PORT)]);
  if (!wsFree) throw new Error(`端口 ${WS_PORT} 已被占用（可能是别的 mock/服务），请先释放后再跑`);
  if (!healthFree) throw new Error(`端口 ${HEALTH_PORT} 已被占用（可能是别的 mock/服务），请先释放后再跑`);
  return { workDir, dataDir, configPath, wsPort: WS_PORT, healthPort: HEALTH_PORT };
}

/** 清理 bridge 子进程 env：不继承任何可能指向真实服务/真实数据的变量。 */
const STRIPPED_ENV_KEYS = [
  "DEEPSEEK_API_KEY",
  "DEEPSEEK_BASE_URL",
  "DEEPSEEK_FLASH_MODEL",
  "DEEPSEEK_PRO_MODEL",
  "DEEPSEEK_THINKING",
  "QWEN_VL_API_KEY",
  "QWEN_EMBEDDING_API_KEY",
  "UNSPLASH_ACCESS_KEY",
  "OPENWEATHER_API_KEY",
  "FISH_AUDIO_API_KEY",
  "JIMENG_API_KEY",
  "CLAUDE_API_KEY",
  "KAREN_DATA_DIR",
  "LOG_CONTENT",
  "LOG_LEVEL",
  "LOG_FORMAT",
  "HEALTH_PORT",
  "WEB_PORT",
  "WEB_TOKEN",
  "WEB_ALL_OWNERS",
  "ALLOWED_USERS",
  "ONE_BOT_HOST",
  "ONE_BOT_WS_PORT",
  "ONE_BOT_WS_PATH",
  "ONE_BOT_TOKEN",
  "QUIET_HOURS_START",
  "QUIET_HOURS_END",
  "AGE_GATE",
  "AI_DISCLOSURE",
  "PHOTO_SHARE_MIN_CLOSENESS",
  "PHOTO_SHARE_PROBABILITY",
  "PHOTO_SHARE_COOLDOWN_MINUTES",
  "VOICE_ENABLED",
  "VOICE_PROBABILITY",
  "VOICE_MIN_CLOSENESS",
  "VOICE_COOLDOWN_MINUTES",
  "VOICE_MAX_CHARS",
  "VOICE_GROUP",
  "GROUP_PHOTO",
  "STICKER_ENABLED",
  "KAREN_NO_ANTI_REPEAT",
  "KAREN_REPEAT_NOTE_MODE",
  "KAREN_T3_DRY_RUN",
  "KAREN_SEMANTIC_BOOST",
];

export interface BridgeProcessHandle {
  child: ChildProcess;
  logs: BridgeLogCollector;
  stop: () => Promise<void>;
}

function resolveNodeBinary(repoRoot: string): string {
  const runtimeNode = path.join(repoRoot, ".runtime", "node22", "bin", "node");
  if (fs.existsSync(runtimeNode)) return runtimeNode;
  // 兜底：当前进程的 node（仍会比系统 node 更可控）
  return process.execPath;
}

/** 启动真实 bridge 子进程（cwd=临时工作区；绝对路径指向仓库里的 tsx/qq.ts）。 */
export function spawnBridgeProcess(
  repoRoot: string,
  workspace: MockWorkspace,
  deepseek: RepoDeepSeekEnv,
): BridgeProcessHandle {
  const nodeBinary = resolveNodeBinary(repoRoot);
  const tsxCli = path.join(repoRoot, "node_modules", "tsx", "dist", "cli.mjs");
  const bridgeEntry = path.join(repoRoot, "src", "bridge", "qq.ts");
  if (!fs.existsSync(tsxCli)) throw new Error(`找不到 tsx CLI: ${tsxCli}（请先安装依赖）`);
  if (!fs.existsSync(bridgeEntry)) throw new Error(`找不到 bridge 入口: ${bridgeEntry}`);
  // 用临时 workdir 里的 wrapper 入口启动：进程命令行不含 src/bridge/qq.ts，
  // 避免开发者重启真实 bridge 时 `pkill -f "src/bridge/qq.ts"` 误杀 mock 子进程。
  const wrapperEntry = path.join(workspace.workDir, "mock-bridge-entry.ts");
  fs.writeFileSync(
    wrapperEntry,
    `// 真实验证台自动生成：真实 bridge 入口的 wrapper（见 src/eval/mock-longrun.ts）
import ${JSON.stringify(bridgeEntry)};
`,
    "utf8",
  );

  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const key of STRIPPED_ENV_KEYS) delete env[key];
  Object.assign(env, {
    DEEPSEEK_API_KEY: deepseek.apiKey,
    DEEPSEEK_FLASH_MODEL: FLASH_MODEL,
    DEEPSEEK_THINKING: "disabled",
    KAREN_DATA_DIR: workspace.dataDir,
    LOG_LEVEL: "info",
    LOG_FORMAT: "json",
    NO_COLOR: "1",
    KAREN_MOCK_LONGRUN: "1",
  });
  if (deepseek.baseUrl) env.DEEPSEEK_BASE_URL = deepseek.baseUrl;

  const child = spawn(nodeBinary, [tsxCli, wrapperEntry], {
    cwd: workspace.workDir,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const logs = new BridgeLogCollector();
  child.stdout?.on("data", (chunk: Buffer) => logs.append(chunk.toString("utf8")));
  child.stderr?.on("data", (chunk: Buffer) => logs.append(chunk.toString("utf8")));

  const stop = async (): Promise<void> => {
    try {
      if (child.exitCode !== null || child.signalCode !== null) {
        logs.flush();
        return;
      }
      child.kill("SIGTERM");
      const deadline = Date.now() + 5000;
      while (child.exitCode === null && child.signalCode === null && Date.now() < deadline) {
        await sleep(100);
      }
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGKILL");
        await sleep(500);
      }
    } catch {
      // 收尾失败不影响已产出的结果
    } finally {
      logs.flush();
    }
  };

  return { child, logs, stop };
}

export function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function sleep(ms: number): Promise<void> {
  return wait(ms);
}

/** 等 bridge 监听 WS 端口；期间若子进程退出立即失败（带脱敏输出尾部）。 */
export async function waitForPort(
  port: number,
  timeoutMs: number,
  handle: BridgeProcessHandle,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (handle.child.exitCode !== null || handle.child.signalCode !== null) {
      handle.logs.flush();
      throw new Error(
        `bridge 提前退出（code=${String(handle.child.exitCode)} signal=${String(handle.child.signalCode)}）\n--- bridge 输出（脱敏尾部）---\n${maskSensitive(handle.logs.tailLines(40))}`,
      );
    }
    const free = await new Promise<boolean>((resolve) => {
      const socket = net.connect({ host: "127.0.0.1", port });
      socket.once("connect", () => {
        socket.destroy();
        resolve(true);
      });
      socket.once("error", () => {
        socket.destroy();
        resolve(false);
      });
    });
    if (free) return;
    await wait(150);
  }
  handle.logs.flush();
  throw new Error(
    `bridge 在 ${timeoutMs}ms 内未监听端口 ${port}\n--- bridge 输出（脱敏尾部）---\n${maskSensitive(handle.logs.tailLines(40))}`,
  );
}

// ── 成本 / 健康检查（HTTP，只连本机 health 端口）───

function getJson(url: string, timeoutMs = 3000): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const request = http.get(url, (response) => {
      let body = "";
      response.setEncoding("utf8");
      response.on("data", (chunk: string) => {
        body += chunk;
      });
      response.on("end", () => {
        if ((response.statusCode ?? 0) < 200 || (response.statusCode ?? 0) >= 300) {
          reject(new Error(`GET ${url} 返回 ${String(response.statusCode)}`));
          return;
        }
        try {
          resolve(JSON.parse(body) as unknown);
        } catch (err) {
          reject(err instanceof Error ? err : new Error(String(err)));
        }
      });
    });
    request.setTimeout(timeoutMs, () => {
      request.destroy(new Error(`GET ${url} 超时`));
    });
    request.on("error", reject);
  });
}

export async function fetchBridgeCost(healthPort: number): Promise<BridgeCostReportShape | null> {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const payload = (await getJson(`http://127.0.0.1:${healthPort}/cost`)) as BridgeCostReportShape;
      if (payload && typeof payload.total === "object" && payload.total !== null) return payload;
    } catch {
      // retry
    }
    await wait(350);
  }
  return null;
}

export async function fetchBridgeHealth(healthPort: number): Promise<Record<string, unknown> | null> {
  try {
    const payload = await getJson(`http://127.0.0.1:${healthPort}/health`);
    return payload && typeof payload === "object" ? (payload as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

// ── mock OneBot 客户端（扮演 NapCat）────────────

interface MockActionRequest {
  action?: unknown;
  params?: unknown;
  echo?: unknown;
}

/** 给带 echo 的 API 请求返回合理假数据；未知 action 返回 {}。 */
export function mockActionResponseData(action: string, params: Record<string, unknown>, nextMessageId: number): unknown {
  switch (action) {
    case "send_private_msg":
    case "send_group_msg":
      return { message_id: nextMessageId };
    case "get_login_info":
      return { user_id: BOT_QQ, nickname: "小雅" };
    case "get_stranger_info":
      return { user_id: params.user_id ?? MOCK_QQ, nickname: "阿哲", sex: "male", age: 25 };
    case "get_msg":
      return {
        message_id: params.message_id ?? 0,
        message: [],
        raw_message: "",
        sender: { user_id: MOCK_QQ, nickname: "阿哲" },
        time: Math.floor(Date.now() / 1000),
      };
    case "get_version_info":
      return { app_name: "karen-mock-onebot", app_version: "1.0.0", protocol_version: "v11" };
    case "get_friend_list":
      return [{ user_id: MOCK_QQ, nickname: "阿哲" }];
    case "get_group_list":
      return [];
    case "set_msg_emoji_like":
    case "mark_msg_as_read":
    case "set_input_status":
      return {};
    default:
      return {};
  }
}

export class MockOneBotClient {
  readonly messages: CollectedMessage[] = [];
  readonly actions: Array<Record<string, unknown>> = [];
  private nextMessageId = 20_000;
  /** 她撤回的消息条数（transcript 里标示，避免评审把「撤回+重发」当成重复） */
  recalledCount = 0;
  private closedInfo = "";
  private ws: WebSocket | null = null;
  private constructor(ws: WebSocket) {
    this.ws = ws;
    ws.on("message", (data: Buffer) => {
      let parsed: Record<string, unknown>;
      try {
        parsed = JSON.parse(data.toString()) as Record<string, unknown>;
      } catch {
        return;
      }
      this.actions.push(parsed);
      this.handleAction(parsed);
    });
    ws.on("error", () => {
      // 连接错误统一由 close 事件处理；不挂 error 监听会抛未捕获异常
    });
    ws.on("close", (code: number, reason: Buffer) => {
      this.closedInfo = `code=${code} reason=${reason.toString()}`;
    });
  }

  static async connect(port: number, token: string, timeoutMs = 15_000): Promise<MockOneBotClient> {
    const ws = new WebSocket(`ws://127.0.0.1:${port}${WS_PATH}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`连接 mock OneBot WS 超时（${timeoutMs}ms）`)), timeoutMs);
      ws.once("open", () => {
        clearTimeout(timer);
        resolve();
      });
      ws.once("error", (err: Error) => {
        clearTimeout(timer);
        reject(err);
      });
    });
    return new MockOneBotClient(ws);
  }

  get closedReason(): string {
    return this.closedInfo;
  }

  private handleAction(parsed: Record<string, unknown>): void {
    const request = parsed as MockActionRequest;
    const action = typeof request.action === "string" ? request.action : "";
    const params =
      request.params && typeof request.params === "object"
        ? (request.params as Record<string, unknown>)
        : {};
    if (action === "delete_msg") {
      // 撤回：标记对应的出站消息，transcript 渲染成「〔她撤回了一条消息〕」
      const targetId = typeof params.message_id === "number" ? params.message_id : null;
      if (targetId !== null) {
        for (const message of this.messages) {
          if (message.messageId === targetId) {
            message.recalled = true;
            this.recalledCount += 1;
            break;
          }
        }
      }
    }
    const assignedId = this.nextMessageId;
    if (action === "send_private_msg" || action === "send_group_msg") {
      this.nextMessageId += 1;
    }
    if (action === "send_private_msg" || action === "send_group_msg") {
      const segments = parseOneBotMessage(params.message);
      const text = segmentsToText(segments);
      this.messages.push({
        at: Date.now(),
        action,
        messageId: assignedId,
        userId: typeof params.user_id === "number" ? params.user_id : undefined,
        groupId: typeof params.group_id === "number" ? params.group_id : undefined,
        segments,
        text,
        hasMedia: hasMediaSegment(segments),
      });
    }
    if (typeof request.echo === "string" || typeof request.echo === "number") {
      const data = mockActionResponseData(action, params, assignedId);
      this.ws?.send(
        JSON.stringify({ status: "ok", retcode: 0, data, echo: request.echo }),
      );
    }
  }

  /** 发一条私聊事件（模拟用户打字）；返回 message_id 与发送时间。 */
  sendPrivateMessage(text: string): { messageId: number; at: number } {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error(`mock OneBot WS 未连接（${this.closedInfo || "未打开"}）`);
    }
    const messageId = this.nextMessageId++;
    const event = {
      post_type: "message",
      message_type: "private",
      sub_type: "friend",
      self_id: BOT_QQ,
      user_id: MOCK_QQ,
      message_id: messageId,
      raw_message: text,
      message: [{ type: "text", data: { text } }],
      sender: { user_id: MOCK_QQ, nickname: "阿哲", sex: "male", age: 25 },
      time: Math.floor(Date.now() / 1000),
    };
    this.ws.send(JSON.stringify(event));
    return { messageId, at: Date.now() };
  }

  /** 自某个时间点之后、发给 mock 用户的私聊出站消息。 */
  privateMessagesSince(sinceMs: number): CollectedMessage[] {
    return this.messages.filter(
      (message) =>
        message.action === "send_private_msg" &&
        message.userId === MOCK_QQ &&
        message.at >= sinceMs,
    );
  }

  /** 关闭 WS：最多等 timeoutMs，超时强制 terminate（收尾绝不挂住）。 */
  async closeAsync(timeoutMs = 2000): Promise<void> {
    const ws = this.ws;
    this.ws = null;
    if (!ws) return;
    if (ws.readyState === WebSocket.CLOSED) return;
    try {
      if (ws.readyState === WebSocket.CONNECTING) {
        ws.terminate();
        return;
      }
      const closed = new Promise<void>((resolve) => {
        ws.once("close", () => resolve());
      });
      ws.close();
      await Promise.race([closed, wait(timeoutMs)]);
      ws.terminate();
    } catch {
      try {
        ws.terminate();
      } catch {
        // ignore
      }
    }
  }
}

// ── 单轮等待 / 收集（真实运行）──────────────────

export interface WaitReplyResult {
  messages: CollectedMessage[];
  status: "reply" | "deferred" | "reply_failed" | "timeout";
  firstAt: number | null;
}

interface WaitReplyOptions {
  client: MockOneBotClient;
  logs: BridgeLogCollector;
  sinceMs: number;
  timeoutMs: number;
  pollMs?: number;
}

/** 等某轮的第一条出站；bridge 日志显示被门控延迟时提前返回（不算失败）。 */
export async function waitForFirstReply(options: WaitReplyOptions): Promise<WaitReplyResult> {
  const { client, logs, sinceMs, timeoutMs } = options;
  const pollMs = options.pollMs ?? 120;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const messages = client.privateMessagesSince(sinceMs);
    if (messages.length > 0) return { messages, status: "reply", firstAt: messages[0].at };
    const deferred = logs.findEventSince(sinceMs, "gate.deferred_scheduled");
    if (deferred) return { messages: [], status: "deferred", firstAt: null };
    const failed = logs.findEventSince(sinceMs, "reply.failed");
    if (failed) {
      await wait(300); // 等兜底消息落地
      return { messages: client.privateMessagesSince(sinceMs), status: "reply_failed", firstAt: null };
    }
    await wait(pollMs);
  }
  return { messages: client.privateMessagesSince(sinceMs), status: "timeout", firstAt: null };
}

/**
 * 首条回复后继续收集，直到「安静」一段时间（静音窗口）。
 * - 语音链路会先录后发（最慢约 20s 延迟），所以 voice 模式静音窗口更长；
 * - 照片/贴纸在文字之后最多约 5s 到达。
 */
export async function collectReplyBubbles(
  client: MockOneBotClient,
  sinceMs: number,
  firstSeen: CollectedMessage[],
  quietMs: number,
  maxCollectMs: number,
): Promise<CollectedMessage[]> {
  let messages = [...firstSeen];
  if (messages.length === 0) return messages;
  let lastAt = messages[messages.length - 1].at;
  const collectDeadline = Date.now() + maxCollectMs;
  while (Date.now() < lastAt + quietMs && Date.now() < collectDeadline) {
    await wait(150);
    const fresh = client.privateMessagesSince(sinceMs);
    if (fresh.length !== messages.length) {
      messages = fresh;
      lastAt = messages[messages.length - 1].at;
    }
  }
  return client.privateMessagesSince(sinceMs);
}

// ── 用户模拟器 / 评审（真实 DeepSeek 调用）─────

export interface DeepSeekCallResult {
  content: string;
  usage: UsageCost;
}

function usageToCost(
  response: OpenAI.Chat.Completions.ChatCompletion,
  model: string,
): UsageCost {
  const usage = response.usage as
    | (OpenAI.CompletionUsage & { prompt_cache_hit_tokens?: number })
    | undefined;
  const promptTokens = usage?.prompt_tokens ?? 0;
  const completionTokens = usage?.completion_tokens ?? 0;
  return {
    calls: 1,
    promptTokens,
    completionTokens,
    costCny: computeCostCny({ model, promptTokens, completionTokens }),
  };
}

async function callDeepSeekNonStreaming(
  client: OpenAI,
  messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[],
  options: { temperature: number; maxTokens: number; timeoutMs?: number },
  model = FLASH_MODEL,
): Promise<DeepSeekCallResult> {
  const timeoutMs = options.timeoutMs ?? 20_000;
  const params = withThinking({
    model,
    messages,
    temperature: options.temperature,
    max_tokens: options.maxTokens,
  });
  // 所有真实 LLM 调用都必须有显式超时：收尾阶段曾因评审请求无超时而挂住整个进程
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await client.chat.completions.create(params, {
      signal: controller.signal,
      timeout: timeoutMs,
      maxRetries: 0,
    });
    const content = response.choices[0]?.message?.content?.trim() ?? "";
    return { content, usage: usageToCost(response, model) };
  } finally {
    clearTimeout(timer);
  }
}

function addUsage(a: UsageCost, b: UsageCost): UsageCost {
  return {
    calls: a.calls + b.calls,
    promptTokens: a.promptTokens + b.promptTokens,
    completionTokens: a.completionTokens + b.completionTokens,
    costCny: round(a.costCny + b.costCny, 6),
  };
}

const EMPTY_USAGE: UsageCost = { calls: 0, promptTokens: 0, completionTokens: 0, costCny: 0 };

export interface SimulatorState {
  client: OpenAI;
  usage: UsageCost;
  failures: number;
}

export function createSimulator(apiKey: string, baseUrl?: string): SimulatorState {
  return {
    client: new OpenAI({ apiKey, baseURL: baseUrl ?? DEFAULT_DEEPSEEK_BASE_URL }),
    usage: { ...EMPTY_USAGE },
    failures: 0,
  };
}

/** 调真实模型生成一轮用户消息（失败时用兜底文本，不中断长跑）。 */
export async function simulateUserMessages(
  state: SimulatorState,
  beat: ScenarioBeat,
  context: SimulatorContext,
): Promise<string[]> {
  if (beat.fixedText) return [beat.fixedText];
  try {
    const result = await callDeepSeekNonStreaming(
      state.client,
      buildUserSimulatorMessages(beat, context),
      { temperature: 1.0, maxTokens: 200, timeoutMs: 20_000 },
    );
    state.usage = addUsage(state.usage, result.usage);
    return parseUserSimulatorOutput(result.content, beat.fallbackText);
  } catch (err) {
    state.failures += 1;
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`[longrun] 用户模拟器调用失败，用兜底文本: ${maskSensitive(message)}\n`);
    return [beat.fallbackText ?? "嗯，我在呢。"];
  }
}

/** 调真实模型做一次 LLM 评审（失败返回 null，不中断报告生成）。 */
export async function runLlmReview(
  state: SimulatorState,
  transcript: TranscriptTurn[],
): Promise<{ review: LlmReview | null; usage: UsageCost; error: string | null }> {
  try {
    const result = await callDeepSeekNonStreaming(
      state.client,
      buildReviewerMessages(transcript),
      { temperature: 0.2, maxTokens: 700, timeoutMs: 20_000 },
    );
    state.usage = addUsage(state.usage, result.usage);
    const review = parseReviewerOutput(result.content);
    return {
      review,
      usage: result.usage,
      error: review ? null : "评审输出不是合法 JSON",
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { review: null, usage: { ...EMPTY_USAGE }, error: maskSensitive(message) };
  }
}

// ── 自动观察（启发式）───────────────────────────

export function buildAutoObservations(metrics: LongrunMetrics, result: Pick<LongrunResult, "probes" | "fabrication" | "bridgeErrors">): string[] {
  const observations: string[] = [];
  if (metrics.repliedTurns === 0) {
    observations.push("❌ 整轮没有任何回复，先检查 bridge/DeepSeek 链路，不要看人格指标。");
    return observations;
  }
  if (metrics.noReplyTurns > 0) {
    const reasons = Object.entries(metrics.noReplyReasons)
      .map(([key, value]) => `${key}=${value}`)
      .join("，");
    observations.push(`no_reply ${metrics.noReplyTurns} 轮（${reasons}）——门控延迟/沉默属产品设计，记录为正常现象，但需确认不是 bridge 异常。`);
  }
  const failedProbes = metrics ? result.probes.filter((probe) => !probe.passed) : [];
  if (failedProbes.length > 0) {
    observations.push(`记忆探针未通过 ${failedProbes.length} 个：${failedProbes.map((probe) => probe.key).join("、")}（看第 4 节证据）。`);
  }
  if (result.fabrication?.flagged) {
    observations.push(`编造检测命中启发式标记：${result.fabrication.markers.join("、")}（仅启发式，需人工判断是否真的编造）。`);
  }
  if (metrics.redlines.bracketActions > 0) {
    observations.push(`出现 ${metrics.redlines.bracketActions} 处括号动作描写（产品红线），见第 5 节样例。`);
  }
  if (metrics.redlines.aiPhrases > 0) {
    observations.push(`出现 ${metrics.redlines.aiPhrases} 处「作为 AI/语言模型」措辞（产品红线）。`);
  }
  if (metrics.media.image === 0 && metrics.media.record === 0 && metrics.media.face === 0) {
    observations.push("本轮没有出现任何多媒体（照片/贴纸/表情/语音）——检查发图概率/语音开关或链路。");
  }
  if (metrics.latency.p95 > 15_000) {
    observations.push(`首条回复 p95 延迟 ${formatSeconds(metrics.latency.p95)}，偏慢（门控 typingDelay + 模型 TTFB + 流式发送）。`);
  }
  if (metrics.repetition.duplicatePairs > 0) {
    observations.push(`相邻回复疑似复读 ${metrics.repetition.duplicatePairs} 对（平均相似度 ${metrics.repetition.avgScore}）。`);
  }
  if (result.bridgeErrors.count > 0) {
    observations.push(`bridge 有 ${result.bridgeErrors.count} 条 error 日志（见第 2 节备注/运行备注）。`);
  }
  if (observations.length === 0) observations.push("自动规则未发现明显异常；真人感问题见人工观察。");
  return observations;
}

// ── 报告辅助：把 turn 转成 transcript ───────────

export function buildTranscript(turns: LongrunTurn[]): TranscriptTurn[] {
  return turns.map((turn) => ({
    index: turn.index,
    tag: turn.tag,
    user: turn.sentTexts,
    her: turn.outbound.map((message) => message.text).filter((text) => text.length > 0).join("\n"),
    media: turn.outbound.flatMap((message) => describeMedia(message.segments)),
  }));
}

export function collectBridgeErrorSummary(handle: BridgeProcessHandle): {
  count: number;
  events: Array<{ event: string; message: string }>;
  outputTail: string;
} {
  handle.logs.flush();
  const events = handle.logs.errorEvents().slice(-10).map((event) => ({
    event: event.event,
    message: maskSensitive(String(event.fields.error ?? event.fields.detail ?? event.fields.reason ?? "")),
  }));
  return {
    count: handle.logs.errorCount,
    events,
    outputTail: maskSensitive(handle.logs.tailLines(40)),
  };
}

/** 写报告文件（自动保留上一版的 MANUAL 段落；失败不抛给主流程外的调用方）。 */
function writeLongrunReportFile(result: LongrunResult, reportPath: string): void {
  let existing: string | null = null;
  try {
    existing = fs.existsSync(reportPath) ? fs.readFileSync(reportPath, "utf8") : null;
  } catch {
    existing = null;
  }
  fs.mkdirSync(path.dirname(reportPath), { recursive: true });
  fs.writeFileSync(reportPath, renderReport(result, existing), "utf8");
}

// ── 长跑主流程 ──────────────────────────────────

export interface RunLongrunOptions extends LongrunCliOptions {
  repoRoot?: string;
}

interface SetupResult {
  ok: boolean;
  detail: string;
  turns: number;
}

async function runSetupTurns(
  client: MockOneBotClient,
  logs: BridgeLogCollector,
  options: Pick<LongrunCliOptions, "replyTimeoutMs">,
): Promise<SetupResult> {
  let completed = 0;
  for (const step of SETUP_STEPS) {
    const sent = client.sendPrivateMessage(step.text);
    const watched = await waitForFirstReply({
      client,
      logs,
      sinceMs: sent.at,
      timeoutMs: Math.min(60_000, options.replyTimeoutMs),
    });
    const text = watched.messages.map((message) => message.text).join(" ");
    const matched = step.expectAny.some((keyword) => text.includes(keyword));
    if (watched.status !== "reply" || !matched) {
      return {
        ok: false,
        detail: `${step.id} 未通过（status=${watched.status}，收到 ${watched.messages.length} 条，期望包含 ${step.expectAny.join("/")}）`,
        turns: completed,
      };
    }
    completed += 1;
  }
  return {
    ok: true,
    detail: SETUP_STEPS.map((step) => step.description).join("；"),
    turns: completed,
  };
}

interface RunBeatOutcome {
  turn: LongrunTurn;
  beat: ScenarioBeat;
  note?: string;
}

async function runBeat(
  index: number,
  beat: ScenarioBeat,
  client: MockOneBotClient,
  logs: BridgeLogCollector,
  simulator: SimulatorState,
  options: RunLongrunOptions,
  recent: Array<{ user: string[]; her: string }>,
  facts: string[],
  quietMs: number,
  maxCollectMs: number,
): Promise<RunBeatOutcome> {
  const sentTexts = await simulateUserMessages(simulator, beat, { recent, facts });
  const sentAt = Date.now();
  let firstSentAt: number | null = null;
  for (let i = 0; i < sentTexts.length; i++) {
    if (i > 0) await wait(1200 + Math.random() * 1200);
    const sent = client.sendPrivateMessage(sentTexts[i]);
    if (firstSentAt === null) firstSentAt = sent.at;
  }
  const since = firstSentAt ?? sentAt;

  const watched = await waitForFirstReply({
    client,
    logs,
    sinceMs: since,
    timeoutMs: options.replyTimeoutMs,
  });

  let outbound: CollectedMessage[] = watched.messages;
  if (watched.status === "reply" && watched.messages.length > 0) {
    outbound = await collectReplyBubbles(client, since, watched.messages, quietMs, maxCollectMs);
  }

  const firstReplyAt = watched.status === "reply" && watched.messages.length > 0 ? watched.messages[0].at : null;
  const turn: LongrunTurn = {
    index,
    beatId: beat.id,
    tag: beat.tag,
    intent: beat.intent,
    sentTexts,
    sentAt: since,
    firstReplyAt,
    latencyMs: firstReplyAt !== null ? firstReplyAt - since : null,
    outbound,
    status: outbound.length > 0 ? "reply" : "no_reply",
  };
  if (turn.status === "no_reply") {
    turn.noReplyReason =
      watched.status === "deferred"
        ? "deferred"
        : watched.status === "reply_failed"
          ? "reply_failed"
          : "timeout";
  } else if (watched.status === "reply_failed") {
    turn.error = "bridge 记录 reply.failed（已收到兜底消息）";
  }
  return { turn, beat };
}

function delayWithJitter(baseMs: number): number {
  return Math.round(baseMs + Math.random() * baseMs * 0.5);
}

/** 真实运行一次长跑并生成报告；返回结构化结果（入口脚本负责打印/退出码）。 */
export async function runLongrun(partial: RunLongrunOptions): Promise<LongrunResult> {
  const repoRoot = path.resolve(partial.repoRoot ?? REPO_ROOT);
  const options: LongrunCliOptions = {
    turns: partial.turns,
    scenario: partial.scenario,
    gapMs: partial.gapMs,
    out: partial.out,
    keep: partial.keep,
    budgetCny: partial.budgetCny,
    replyTimeoutMs: partial.replyTimeoutMs,
    voice: partial.voice,
    photoProbability: partial.photoProbability,
    review: partial.review,
    tag: partial.tag,
  };
  const beats = getScenario(options.scenario).slice(0, options.turns);
  const deepseek = readRepoDeepSeekEnv(repoRoot);
  const startedAt = new Date();
  const startMs = Date.now();
  const notes: string[] = [];

  const workspace = await prepareWorkspace(repoRoot, {
    voice: options.voice,
    photoProbability: options.photoProbability,
    turns: beats.length,
  });
  const simulator = createSimulator(deepseek.apiKey, deepseek.baseUrl);
  const bridge = spawnBridgeProcess(repoRoot, workspace, deepseek);
  let client: MockOneBotClient | null = null;
  let reportWritten = "";
  const reportPath = path.resolve(repoRoot, options.out);

  try {
    process.stdout.write(
      `[longrun] 临时工作区: ${maskHomePath(workspace.workDir)}（KAREN_DATA_DIR=${maskHomePath(workspace.dataDir)}）\n`,
    );
    process.stdout.write(`[longrun] 等待 bridge 监听 127.0.0.1:${workspace.wsPort}…\n`);
    await waitForPort(workspace.wsPort, 60_000, bridge);
    client = await MockOneBotClient.connect(workspace.wsPort, MOCK_WS_TOKEN);
    process.stdout.write(`[longrun] bridge 已连接（mock NapCat），开始 18+ 门准备…\n`);

    const setup = await runSetupTurns(client, bridge.logs, options);
    if (!setup.ok) {
      throw new Error(`18+ 门准备失败：${setup.detail}`);
    }
    process.stdout.write(`[longrun] 18+ 门通过，开始 ${beats.length} 轮场景（gap≈${options.gapMs}ms，语音=${options.voice ? "开" : "关"}）\n`);

    const turns: LongrunTurn[] = [];
    const recent: Array<{ user: string[]; her: string }> = [];
    const facts: string[] = [];
    // 语音是「先录后发」（文字气泡后约 3-8s 到）；照片/贴图在文字后约 5s 内到齐。
    // 静音窗口覆盖语音到达，避免把一轮拆成两轮。
    const quietMs = options.voice ? 14_000 : 9_000;
    const maxCollectMs = options.voice ? 55_000 : 35_000;
    let budgetExceeded = false;

    for (let index = 0; index < beats.length; index++) {
      const beat = beats[index];
      const outcome = await runBeat(
        index + 1,
        beat,
        client,
        bridge.logs,
        simulator,
        options,
        recent,
        facts,
        quietMs,
        maxCollectMs,
      );
      const { turn } = outcome;
      turns.push(turn);

      if (beat.tag === "fact" && beat.fixedText) facts.push(beat.fixedText);
      recent.push({
        user: turn.sentTexts,
        her: turn.outbound.map((message) => message.text).filter((text) => text.length > 0).join(" / "),
      });
      while (recent.length > 5) recent.shift();

      const mediaLabels = turn.outbound.flatMap((message) => describeMedia(message.segments));
      process.stdout.write(
        `[turn ${String(turn.index).padStart(2, "0")}/${beats.length}] ${beat.tag.padEnd(7)} ` +
          `${turn.status === "reply" ? `延迟=${formatSeconds(turn.latencyMs ?? 0)} 气泡=${turn.outbound.length}` : `no_reply(${turn.noReplyReason ?? "timeout"})`}` +
          `${mediaLabels.length > 0 ? ` 媒体=${mediaLabels.join("+")}` : ""}\n`,
      );

      // 成本护栏：每轮查一次 /cost，触顶提前停（避免长跑超预算）
      const costSnapshot = await fetchBridgeCost(workspace.healthPort);
      if (costSnapshot && costSnapshot.total.cost_cny >= options.budgetCny) {
        budgetExceeded = true;
        notes.push(
          `成本触顶提前停止：第 ${turn.index}/${beats.length} 轮后 bridge 成本 ${formatCny(costSnapshot.total.cost_cny)} ≥ 上限 ${formatCny(options.budgetCny)}`,
        );
        process.stdout.write(`[longrun] ⚠️ 成本触顶（${formatCny(costSnapshot.total.cost_cny)}），提前结束\n`);
        break;
      }
      if (index < beats.length - 1) {
        await wait(delayWithJitter(options.gapMs));
      }
    }

    const bridgeCost = await fetchBridgeCost(workspace.healthPort);
    const health = await fetchBridgeHealth(workspace.healthPort);
    const transcript = buildTranscript(turns);
    const metrics = computeMetrics(turns);
    const runtimeState = collectRuntimeState(workspace.dataDir);
    const probes = evaluateProbes(turns, beats);
    const fabrication = detectFabrication(turns, beats);
    const bridgeErrors = collectBridgeErrorSummary(bridge);

    if (simulator.failures > 0) notes.push(`用户模拟器失败 ${simulator.failures} 次（已用兜底文本继续）`);
    const baseTotalCny = round(
      (bridgeCost?.total.cost_cny ?? 0) + simulator.usage.costCny,
      4,
    );
    const result: LongrunResult = {
      ok: setup.ok && metrics.repliedTurns > 0,
      tag: options.tag,
      startedAt: startedAt.toISOString(),
      finishedAt: new Date().toISOString(),
      durationMs: Date.now() - startMs,
      scenario: options.scenario,
      turnsPlanned: options.turns,
      turnsRun: turns.length,
      budgetCny: options.budgetCny,
      budgetExceeded,
      voiceEnabled: options.voice,
      photoProbability: options.photoProbability,
      isolation: {
        workDir: workspace.workDir,
        dataDir: workspace.dataDir,
        wsUrl: `ws://127.0.0.1:${workspace.wsPort}${WS_PATH}`,
        healthUrl: `http://127.0.0.1:${workspace.healthPort}`,
        kept: options.keep,
        repoDataDir: path.join(repoRoot, "data"),
      },
      setup,
      turns,
      metrics,
      runtimeState,
      probes,
      fabrication,
      cost: {
        bridge: bridgeCost,
        simulator: simulator.usage,
        reviewer: { ...EMPTY_USAGE },
        totalCny: baseTotalCny,
      },
      bridgeErrors,
      review: null,
      reviewError: null,
      autoObservations: buildAutoObservations(metrics, {
        probes,
        fabrication,
        bridgeErrors,
      }),
      transcript,
      health,
      notes,
    };

    // 先落一版报告：即使 LLM 评审/收尾异常，本轮真实数据也不会丢。
    writeLongrunReportFile(result, reportPath);
    reportWritten = reportPath;
    process.stdout.write(`[longrun] 报告（初版，评审前）已写入: ${maskHomePath(reportPath)}\n`);

    // LLM 评审有 20s 超时；失败只记录，不阻塞报告
    if (options.review && transcript.length > 0) {
      process.stdout.write("[longrun] 调用真实 DeepSeek 做 LLM 评审…\n");
      const reviewResult = await runLlmReview(simulator, transcript);
      result.review = reviewResult.review;
      result.reviewError = reviewResult.error;
      result.cost.reviewer = reviewResult.usage;
    }
    result.cost.totalCny = round(
      (bridgeCost?.total.cost_cny ?? 0) +
        simulator.usage.costCny +
        result.cost.reviewer.costCny,
      4,
    );
    result.autoObservations = buildAutoObservations(result.metrics, {
      probes: result.probes,
      fabrication: result.fabrication,
      bridgeErrors: result.bridgeErrors,
    });
    result.finishedAt = new Date().toISOString();
    result.durationMs = Date.now() - startMs;
    writeLongrunReportFile(result, reportPath);

    return result;
  } catch (err) {
    bridge.logs.flush();
    const tail = maskSensitive(bridge.logs.tailLines(50));
    const wsInfo = client?.closedReason ? `\nWS close: ${client.closedReason}` : "";
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(
      `${message}${wsInfo}\n--- bridge 输出（脱敏尾部）---\n${tail}\n（临时目录${options.keep ? "保留: " + maskHomePath(workspace.workDir) : "已删除"}）`,
    );
  } finally {
    try {
      await client?.closeAsync(2000);
    } catch {
      // ignore
    }
    await bridge.stop();
    if (!options.keep) {
      try {
        fs.rmSync(workspace.workDir, { recursive: true, force: true });
      } catch {
        // ignore
      }
    } else {
      process.stdout.write(`[longrun] 已保留临时工作区: ${maskHomePath(workspace.workDir)}\n`);
    }
    if (reportWritten) {
      process.stdout.write(`[longrun] 报告已写入: ${maskHomePath(reportWritten)}\n`);
    }
  }
}

/**
 * 根据 report 路径的人类可读标签（index 兜底；供入口脚本打印）。
 */
export function describeRunSummary(result: LongrunResult): string {
  const m = result.metrics;
  const media = `照片 ${m.media.imagePhoto} / 贴纸 ${m.media.imageSticker} / 表情 ${m.media.face} / 语音 ${m.media.record}`;
  return [
    `回合 ${result.turnsRun}（有回复 ${m.repliedTurns}，no_reply ${m.noReplyTurns}）`,
    `p50 ${formatSeconds(m.latency.p50)} / p95 ${formatSeconds(m.latency.p95)}`,
    `多气泡率 ${formatPct(m.bubbles.multiBubbleRate)}`,
    `多媒体：${media}`,
    `记忆探针 ${result.probes.filter((probe) => probe.passed).length}/${result.probes.length}`,
    `成本 ${formatCny(result.cost.totalCny)}`,
    result.review
      ? `评审 真人感${result.review.realism}/5 连贯${result.review.coherence}/5 主动${result.review.initiative}/5 多媒体${result.review.multimedia}/5 记忆${result.review.memory}/5`
      : "评审 —",
  ].join("；");
}

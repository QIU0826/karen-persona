/**
 * Prompt 预算离线审计（只读；不联网、不调用任何 LLM）。
 *
 * 目的：给「系统提示词到底有多长、钱/延迟花在哪」一个可复现的数字口径。
 *
 * 做什么：
 * 1. 离线构造 5 个典型状态（初识低亲密度 / 关系稳定 / 有 T1+T2 记忆 / 危机轮 / 主动消息轮），
 *    真实调用 `buildPrompt()` + `buildChatMessages()`（以及 orchestrator 会追加的上下文块
 *    对应的导出 formatter），按段落统计字符数与「粗估 tokens」；
 * 2. 以 `{readonly:true, fileMustExist:true}` 打开 `data/memory.sqlite`，只读查询 `llm_usage`
 *    表，统计真实调用的 prompt_tokens 分位、按用途/按天/按小时、大 prompt 占比、缓存命中。
 *
 * 不做：任何 INSERT/UPDATE/ALTER、不写 data/、不读 .env、不调用外部 API。
 *
 * 确定性：
 * - 场景、消息、记忆、事实、T1 快照全部用固定 fixture；
 * - 依赖 Math.random 的措辞选择（RAG 引导语 / 热点文案）用固定种子 LCG 替换，跑多次结果一致；
 * - 时间类输入固定为场景标签（不取当前系统时间）。
 *
 * 用法（必须在仓库根目录执行，原因：loadPersona / Qwen 配置 / data 路径都相对 cwd）：
 *   .runtime/node22/bin/node node_modules/tsx/dist/cli.mjs scripts/prompt-budget.ts
 *
 * token 估算口径：CJK 字符（汉字/CJK 标点）≈1 token，其余字符（ASCII/空白/emoji）≈0.3 token。
 * 这只是粗估，不是 tokenizer 真实值；文档里必须标注「估算」。
 */
import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";

import { loadPersona, type Persona } from "../src/persona/loader.js";
import {
  buildPrompt,
  type CorrectionOverlay,
  type InnerState,
} from "../src/persona/prompt-builder.js";
import {
  buildChatMessages,
  type ChatMessage,
  type ConversationSession,
} from "../src/data/history.js";
import { buildRagContext, type RetrievedMemory } from "../src/data/retriever.js";
import { buildT1ArcContext } from "../src/data/t1-injection.js";
import {
  buildStyleContext,
  type StyleReference,
} from "../src/evolution/style-reference.js";
import { formatUserFacts, type UserFact } from "../src/data/user-facts.js";
import {
  getTrendingTopics,
  matchTrendingTopics,
  buildTrendingContext,
  resetTrendingCache,
} from "../src/world/trending-fetcher.js";
import { buildMomentTag, type TimeContext } from "../src/world/time-awareness.js";
import {
  buildAvoidRepeatNote,
  extractRecentReplies,
} from "../src/persona/anti-repetition.js";
import {
  detectMediaRequest,
  buildMediaRequestNote,
} from "../src/impulse/media-request.js";
import { crisisSafetyNote, detectCrisis } from "../src/safety/crisis.js";
import type { AppConfig } from "../src/data/store.js";

// ── 0. 运行环境与确定性 ──────────────────────────

const REPO_ROOT = process.cwd();

function assertRepoRoot(): void {
  const markers = ["package.json", "personas/xiaoya/persona.json", "src/pipeline/orchestrator.ts"];
  const missing = markers.filter((m) => !fs.existsSync(path.resolve(REPO_ROOT, m)));
  if (missing.length > 0) {
    console.error(
      `[错误] 请在仓库根目录运行本脚本（缺少 ${missing.join(", ")}）。\n` +
        `  cd karen-persona && .runtime/node22/bin/node node_modules/tsx/dist/cli.mjs scripts/prompt-budget.ts`,
    );
    process.exit(1);
  }
}

/** 固定种子线性同余 RNG：替换 Math.random，保证措辞选择可复现。 */
const ORIGINAL_RANDOM = Math.random;
let rngState = 20261020;
function deterministicRandom(): number {
  rngState = (Math.imul(rngState, 1664525) + 1013904223) >>> 0;
  return rngState / 4294967296;
}

function installDeterministicRandom(): void {
  Math.random = deterministicRandom;
}
function restoreRandom(): void {
  Math.random = ORIGINAL_RANDOM;
}

// ── 1. token 粗估与 markdown 工具 ────────────────

/** CJK 汉字 / CJK 标点 = 1 token，其余 = 0.3 token（粗估，非 tokenizer 真值）。 */
function isCjkCodePoint(code: number): boolean {
  return (
    (code >= 0x3400 && code <= 0x4dbf) || // CJK 扩展 A
    (code >= 0x4e00 && code <= 0x9fff) || // CJK 基本区
    (code >= 0xf900 && code <= 0xfaff) || // CJK 兼容表意
    (code >= 0x3000 && code <= 0x303f) || // CJK 标点/全角符号
    (code >= 0xff00 && code <= 0xffef) // 全角字符
  );
}

export function estimateTokens(text: string): number {
  if (!text) return 0;
  let cjk = 0;
  let other = 0;
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0;
    if (isCjkCodePoint(code)) cjk += 1;
    else other += 1;
  }
  return Math.round(cjk + other * 0.3);
}

function fmtInt(value: number): string {
  return Number.isFinite(value) ? String(Math.round(value)) : "—";
}

function fmtPct(value: number): string {
  return Number.isFinite(value) ? `${(value * 100).toFixed(1)}%` : "—";
}

function markdownTable(headers: string[], rows: string[][]): string {
  const lines = [
    `| ${headers.join(" | ")} |`,
    `| ${headers.map(() => "---").join(" | ")} |`,
    ...rows.map((row) => `| ${row.join(" | ")} |`),
  ];
  return lines.join("\n");
}

// ── 2. 固定 fixture ──────────────────────────────

const PERSONA_ID = "xiaoya";
const YOUR_NAME = "阿泽";

function makeConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    persona: PERSONA_ID,
    her_name: "小雅",
    your_name: YOUR_NAME,
    location: "上海",
    tags: ["嘴硬心软"],
    message_frequency_limit: 10,
    log_level: "info",
    one_bot_ws_host: "127.0.0.1",
    one_bot_ws_port: 18080,
    one_bot_ws_path: "/onebot/v11/ws",
    allowed_users: [],
    quiet_hours_start: 23,
    quiet_hours_end: 7,
    health_port: 18081,
    web_port: 18082,
    ai_disclosure: false,
    ...overrides,
  };
}

const CONFIG: AppConfig = makeConfig();

const USER_LINES = [
  "今天加班到九点，累死了",
  "你店今天忙吗",
  "我跟你说个事，我可能要被调去别的组了",
  "晚上吃了碗面，随便对付一下",
  "你上次说的那家店叫什么来着",
  "周末你有空吗，想出去走走",
  "最近老是睡不好，脑子停不下来",
  "我养的那只橘猫今天又把杯子打碎了",
  "你那边下雨了吗",
  "帮我看看这个方案还有啥问题，我改了三版了",
  "今天地铁上碰到一个特别像我大学同学的人",
  "突然有点想吃你上次提的那家甜品",
];

const ASSISTANT_LINES = [
  "嗯呐，刚收拾完",
  "还行吧，下午人少点",
  "真的假的，你别吓我",
  "那你早点睡啊",
  "我跟你说，我今天也遇到个离谱的",
  "……算了，不说了",
  "好滴，等我看看",
  "你先别想那么多",
  "笑死，它是不是胖了",
  "我这边也阴了一天",
  "刚给自己冲了杯手冲，缓过来了",
  "你又来了，每次都这么说",
];

interface HistoryOptions {
  total: number;
  seedOffset?: number;
  /** 最后一条用户消息替换为指定文本（危机轮等场景用） */
  lastUserLine?: string;
}

/** 构造一段确定性的模拟会话（user/assistant 交替，含少量长句与多行气泡）。 */
function makeHistory(options: HistoryOptions): ChatMessage[] {
  const { total, seedOffset = 0, lastUserLine } = options;
  const now = Date.now();
  const messages: ChatMessage[] = [];
  for (let i = 0; i < total; i += 1) {
    const role: "user" | "assistant" = i % 2 === 0 ? "user" : "assistant";
    const pool = role === "user" ? USER_LINES : ASSISTANT_LINES;
    let content = pool[(i + seedOffset) % pool.length];

    // 让「旧消息摘要」的 40 字截断真实发生：偶尔塞入长句
    if (role === "user" && i % 9 === 2) {
      content += "，本来想早点弄完的，结果一直拖到现在，感觉最近状态不太对";
    }
    // 她的回复偶尔是多行气泡（影响会话体积与反重复提示）
    if (role === "assistant" && i % 7 === 5) {
      content += "\n先去忙了，晚点再跟你说";
    }
    messages.push({
      role,
      content,
      timestamp: now - (total - i) * 60_000,
    });
  }
  if (lastUserLine) {
    const lastUserIndex = [...messages].reverse().findIndex((m) => m.role === "user");
    if (lastUserIndex >= 0) {
      messages[messages.length - 1 - lastUserIndex] = {
        role: "user",
        content: lastUserLine,
        timestamp: now,
      };
    }
  }
  return messages;
}

function makeSession(messages: ChatMessage[]): ConversationSession {
  const now = Date.now();
  return {
    personaId: PERSONA_ID,
    startedAt: now - messages.length * 60_000,
    lastActiveAt: now,
    messages,
    t3: { currentTopic: "工作与日常闲聊", emotionVector: 0.1, activeThreads: ["工作压力"] },
  };
}

// ── T1 / T2 / 事实 / 风格参考 fixture ─────────────

function makeT1Snapshots(closenessStart: number, emotionStart: number): Array<{
  content: string;
  emotionVector: number;
  closeness: number;
  guilt: number;
  summary: string;
  created_at?: string;
}> {
  const count = 8;
  const snapshots = [] as Array<{
    content: string;
    emotionVector: number;
    closeness: number;
    guilt: number;
    summary: string;
    created_at?: string;
  }>;
  for (let i = 0; i < count; i += 1) {
    snapshots.push({
      content: "",
      emotionVector: Number((emotionStart + i * 0.06).toFixed(2)),
      closeness: Number((closenessStart + i * 0.07).toFixed(2)),
      guilt: Number(Math.max(0, 0.08 - i * 0.01).toFixed(2)),
      summary: "",
      created_at: `2026-10-${String(12 + i).padStart(2, "0")} 20:00:00`,
    });
  }
  return snapshots;
}

const RAG_STABLE: RetrievedMemory[] = [
  {
    id: 1,
    content: "你上周说项目要上线，连续加了三天班，压力挺大",
    relevance: 0.86,
    strength: 0.92,
    confidence: "high",
    createdAt: Date.now() - 3 * 86_400_000,
    timeLabel: "3天前",
  },
  {
    id: 2,
    content: "你养了一只橘猫叫团子，最近在给它换粮",
    relevance: 0.78,
    strength: 0.88,
    confidence: "high",
    createdAt: Date.now() - 7 * 86_400_000,
    timeLabel: "上周",
  },
  {
    id: 3,
    content: "你提过想换工作，但还没想好方向",
    relevance: 0.62,
    strength: 0.7,
    confidence: "medium",
    createdAt: Date.now() - 10 * 86_400_000,
    timeLabel: "上周",
  },
  {
    id: 4,
    content: "你不喜欢人多的地方，周末更愿意待在家里",
    relevance: 0.58,
    strength: 0.66,
    confidence: "medium",
    createdAt: Date.now() - 20 * 86_400_000,
    timeLabel: "半个月前",
  },
  {
    id: 5,
    content: "你妈妈偶尔会催你找对象，这事让你挺烦",
    relevance: 0.54,
    strength: 0.6,
    confidence: "medium",
    createdAt: Date.now() - 25 * 86_400_000,
    timeLabel: "",
  },
];

const RAG_MEMORY: RetrievedMemory[] = [
  {
    id: 11,
    content: "你说过你以前在成都读过书，学校旁边有一条小吃街，你常去一家抄手店",
    relevance: 0.88,
    strength: 0.9,
    confidence: "high",
    createdAt: Date.now() - 30 * 86_400_000,
    timeLabel: "一个月前",
  },
  {
    id: 12,
    content: "你上次提到你妈妈身体不太好，你有点担心，但又不方便请假回去看她",
    relevance: 0.82,
    strength: 0.86,
    confidence: "high",
    createdAt: Date.now() - 5 * 86_400_000,
    timeLabel: "5天前",
  },
  {
    id: 13,
    content: "你说你不喜欢现在的工作节奏，想找一个能准时下班的岗位",
    relevance: 0.7,
    strength: 0.75,
    confidence: "medium",
    createdAt: Date.now() - 12 * 86_400_000,
    timeLabel: "上周",
  },
  {
    id: 14,
    content: "你提过你大学时组过乐队，弹贝斯，后来因为毕业解散了",
    relevance: 0.66,
    strength: 0.7,
    confidence: "medium",
    createdAt: Date.now() - 60 * 86_400_000,
    timeLabel: "两个月前",
  },
  {
    id: 15,
    content: "你说你最近在存钱，想换一台电脑，预算大概八千",
    relevance: 0.6,
    strength: 0.64,
    confidence: "medium",
    createdAt: Date.now() - 8 * 86_400_000,
    timeLabel: "上周",
  },
  {
    id: 16,
    content: "你上次说周末去爬山了，回来腿疼了两天，但是挺开心的",
    relevance: 0.56,
    strength: 0.6,
    confidence: "medium",
    createdAt: Date.now() - 4 * 86_400_000,
    timeLabel: "4天前",
  },
];

function makeUserFacts(count: number): UserFact[] {
  const all: UserFact[] = [
    { ownerId: "qq:10001", key: "name", value: "阿泽", category: "profile", updatedAt: Date.now() - 60 * 86_400_000 },
    { ownerId: "qq:10001", key: "city", value: "杭州", category: "profile", updatedAt: Date.now() - 60 * 86_400_000 },
    { ownerId: "qq:10001", key: "job", value: "在一家 SaaS 公司做产品设计", category: "work", updatedAt: Date.now() - 40 * 86_400_000 },
    { ownerId: "qq:10001", key: "project", value: "最近在赶 v2.3 版本上线，连续加班", category: "work", updatedAt: Date.now() - 3 * 86_400_000 },
    { ownerId: "qq:10001", key: "pet", value: "养了一只橘猫叫团子", category: "pet", updatedAt: Date.now() - 30 * 86_400_000 },
    { ownerId: "qq:10001", key: "coffee", value: "喝咖啡不加糖", category: "preference", updatedAt: Date.now() - 20 * 86_400_000 },
    { ownerId: "qq:10001", key: "food", value: "不吃香菜", category: "preference", updatedAt: Date.now() - 20 * 86_400_000 },
    { ownerId: "qq:10001", key: "plan", value: "下个月去成都出差三天", category: "plan", updatedAt: Date.now() - 2 * 86_400_000 },
    { ownerId: "qq:10001", key: "hobby", value: "周末喜欢在家打游戏", category: "preference", updatedAt: Date.now() - 15 * 86_400_000 },
    { ownerId: "qq:10001", key: "sleep", value: "最近老是睡不好", category: "other", updatedAt: Date.now() - 86_400_000 },
  ];
  return all.slice(0, count);
}

const STYLE_REFS: StyleReference[] = [
  {
    content: "今天咖啡机又闹脾气，差点跟它吵架",
    source: "internal_monologue",
    affinity: "high",
    daysAgo: 1,
  },
  {
    content: "刚给一个客人做错了单，有点烦，但没表现出来",
    source: "chat",
    affinity: "high",
    daysAgo: 3,
  },
];

const CORRECTIONS: CorrectionOverlay[] = [
  {
    target: "rules.no_questions",
    label: "太冷淡",
    adjustment: "可以稍微主动一点，多问一句也行",
    applied_at: Date.now() - 2 * 3_600_000,
    half_life_ms: 4.5 * 3_600_000,
  },
];

// 与 orchestrator.ts processProactive() 的 proactiveInject 同构（固定文案，便于离线统计）
const PROACTIVE_PICK_DESCRIPTION = "外面下起了雨，你突然想起他早上说过今天没带伞";
const PROACTIVE_INJECT = [
  "",
  "## 此刻的冲动",
  PROACTIVE_PICK_DESCRIPTION,
  '自然地发一条消息，从你当下的生活出发。不要用"最近咋样"这种泛泛的开场——你是因为具体的事情才想到他的。',
].join("\n");

// ── 3. 典型场景定义 ──────────────────────────────

type ScenarioPath = "chat" | "proactive";

interface ScenarioSpec {
  id: string;
  title: string;
  summary: string;
  path: ScenarioPath;
  messageCount: number;
  seedOffset: number;
  lastUserLine?: string;
  state: InnerState;
  userText: string;
  herViewOfYou?: string;
  corrections?: CorrectionOverlay[];
  timeCtx: TimeContext;
  weather: { condition: string; temp: number };
  rag?: RetrievedMemory[];
  t1?: boolean;
  styleRefs?: StyleReference[];
  facts?: number;
  trending?: boolean;
  crisis?: boolean;
  mediaRequest?: boolean;
  proactiveInject?: string;
}

function makeTimeCtx(label: string): TimeContext {
  return {
    label,
    awareness: "",
    period: "afternoon",
    isRestDay: false,
  };
}

const SCENARIOS: ScenarioSpec[] = [
  {
    id: "S1",
    title: "初识低亲密度",
    summary: "刚加好友、只有几句话历史；无 T1/T2、无用户事实",
    path: "chat",
    messageCount: 6,
    seedOffset: 0,
    state: { exposure: 0.18, guilt: 0, emotion: 0.05, hour: 21, mode: "distant", closeness: 1.5 },
    userText: "在吗？今天好累",
    timeCtx: makeTimeCtx("周二21:40 店里刚打烊"),
    weather: { condition: "阴", temp: 18 },
  },
  {
    id: "S2",
    title: "关系稳定",
    summary: "40 条历史（触发旧消息摘要）+ T2 5 条 + 用户事实 10 条 + T1 8 条 + 风格参考 2 条 + 热点/纠正/媒体请求",
    path: "chat",
    messageCount: 40,
    seedOffset: 3,
    state: { exposure: 0.72, guilt: 0.05, emotion: 0.25, hour: 15, mode: "close", closeness: 7.2 },
    userText: "发张你今天拍的照片看看",
    herViewOfYou: "一个愿意听她讲咖啡店琐事的人，最近在赶项目，压力有点大。",
    corrections: CORRECTIONS,
    timeCtx: makeTimeCtx("周二15:30 工作中"),
    weather: { condition: "晴", temp: 23 },
    rag: RAG_STABLE,
    t1: true,
    styleRefs: STYLE_REFS,
    facts: 10,
    trending: true,
    mediaRequest: true,
  },
  {
    id: "S3",
    title: "有 T1 快照 + T2 记忆",
    summary: "24 条历史 + T2 6 条（较长记忆）+ 用户事实 4 条 + T1 8 条；无风格参考/热点",
    path: "chat",
    messageCount: 24,
    seedOffset: 6,
    state: { exposure: 0.45, guilt: 0.1, emotion: -0.1, hour: 22, mode: "neutral", closeness: 4.5 },
    userText: "你还记得我之前说过的那个项目吗？",
    timeCtx: makeTimeCtx("周一22:10 在家"),
    weather: { condition: "小雨", temp: 20 },
    rag: RAG_MEMORY,
    t1: true,
    facts: 4,
  },
  {
    id: "S4",
    title: "危机轮",
    summary: "31 条历史 + 危机安全提示 + T2 3 条 + 用户事实 8 条 + T1 8 条",
    path: "chat",
    messageCount: 31,
    seedOffset: 9,
    lastUserLine: "我真的撑不下去了，感觉活着没意思",
    state: { exposure: 0.6, guilt: 0.2, emotion: -0.7, hour: 1, mode: "neutral", closeness: 6 },
    userText: "我真的撑不下去了，感觉活着没意思",
    herViewOfYou: "一个最近一直在硬撑的人，她想多问一句但怕打扰。",
    timeCtx: makeTimeCtx("周三01:10 深夜"),
    weather: { condition: "阴", temp: 16 },
    rag: RAG_STABLE.slice(0, 3),
    t1: true,
    facts: 8,
    crisis: true,
  },
  {
    id: "S5",
    title: "主动消息轮",
    summary: "20 条历史 + 主动冲动注入 + T1 8 条；无 RAG/事实/风格参考/时间标签（与 processProactive 一致）",
    path: "proactive",
    messageCount: 20,
    seedOffset: 2,
    state: { exposure: 0.65, guilt: 0, emotion: 0.3, hour: 16, mode: "close", closeness: 7 },
    userText: PROACTIVE_PICK_DESCRIPTION,
    herViewOfYou: "最近常来店里、不太爱说话但会认真听她说话的人。",
    timeCtx: makeTimeCtx("周二16:40 咖啡馆"),
    weather: { condition: "雨", temp: 21 },
    t1: true,
    proactiveInject: PROACTIVE_INJECT,
  },
];

// ── 4. Prompt 组装与分段 ─────────────────────────

interface Segment {
  name: string;
  text: string;
  kind: "prompt-static" | "prompt-dynamic" | "appended" | "history";
}

interface AssembledScenario {
  spec: ScenarioSpec;
  promptSegments: Segment[]; // buildPrompt 内部的静态/动态段
  appendedSegments: Segment[]; // orchestrator 追加的上下文块
  olderSummary: string; // buildChatMessages 追加的旧消息摘要
  ragSegment: Segment | null; // chat.ts 在 system message 末尾追加的 RAG 块
  systemMessage: string; // 最终发给模型的第 0 条（含摘要 + RAG）
  recentMessages: ChatMessage[];
  recentChars: { user: number; assistant: number };
}

const PROMPT_STATIC_MARKERS: Array<{ marker: string; name: string }> = [
  { marker: "## 你是谁", name: "你是谁（身份）" },
  { marker: "## 你说话的方式", name: "你说话的方式" },
  { marker: "## 你的生活", name: "你的生活" },
  { marker: "## 补充信息", name: "补充信息" },
  { marker: "## 个性标签", name: "个性标签" },
  { marker: "## 你在和谁聊天", name: "你在和谁聊天（含 howWeMet/对方画像）" },
  { marker: "## 重要提示", name: "重要提示（行为规则）" },
];

const PROMPT_DYNAMIC_MARKERS: Array<{ marker: string; name: string }> = [
  { marker: "## 当前状态下的行为指南", name: "当前状态下的行为指南（行为脚本）" },
  { marker: "## 你的原则", name: "你的原则（L1 规则）" },
  { marker: "## 你和对方的关系", name: "你和对方的关系（含 herView）" },
  { marker: "## 对方给过你的反馈", name: "对方给过的反馈（纠正层）" },
];

function splitByMarkers(
  text: string,
  markers: Array<{ marker: string; name: string }>,
  defaultName: string,
  kind: Segment["kind"],
): Segment[] {
  const hits = markers
    .map((entry) => ({ ...entry, index: text.indexOf(entry.marker) }))
    .filter((entry) => entry.index >= 0)
    .sort((a, b) => a.index - b.index);

  const segments: Segment[] = [];
  if (hits.length === 0) {
    return [{ name: defaultName, text, kind }];
  }
  if (hits[0].index > 0) {
    segments.push({ name: defaultName, text: text.slice(0, hits[0].index), kind });
  }
  for (let i = 0; i < hits.length; i += 1) {
    const start = hits[i].index;
    const end = i + 1 < hits.length ? hits[i + 1].index : text.length;
    segments.push({ name: hits[i].name, text: text.slice(start, end), kind });
  }
  return segments;
}

/** 把 buildPrompt() 的产出按真实段落切开（不重排、不重算，只按 index 切）。 */
function splitBuildPrompt(prompt: string): Segment[] {
  const dynamicHeading = "## 当前状态下的行为指南";
  const dynamicIndex = prompt.indexOf(dynamicHeading);
  if (dynamicIndex < 0) {
    return [{ name: "buildPrompt 全文（未找到动态段标记）", text: prompt, kind: "prompt-static" }];
  }
  // buildPrompt = stat.full + "\n" + dynamic，dynamic 以 "[状态标签]\n\n## 当前状态..." 开头。
  // 用状态标签定位动态段起点（静态段里不会出现这种独立成行的 "[" 标签）。
  const labelMatch = /\n(\[[^\]\n]{1,40}\])\n\n## 当前状态下的行为指南/.exec(prompt);
  const dynamicStart = labelMatch
    ? labelMatch.index + 1
    : prompt.lastIndexOf("\n", dynamicIndex) + 1;
  const staticPart = prompt.slice(0, dynamicStart);
  const dynamicPart = prompt.slice(dynamicStart);

  const staticSegments = splitByMarkers(staticPart, PROMPT_STATIC_MARKERS, "开头与铁律", "prompt-static");
  const dynamicSegments = splitByMarkers(dynamicPart, PROMPT_DYNAMIC_MARKERS, "内心状态标签（动态开头）", "prompt-dynamic");
  return [...staticSegments, ...dynamicSegments];
}

function buildScenario(spec: ScenarioSpec, persona: Persona, config: AppConfig): AssembledScenario {
  const messages = makeHistory({
    total: spec.messageCount,
    seedOffset: spec.seedOffset,
    lastUserLine: spec.lastUserLine,
  });
  const session = makeSession(messages);

  const systemPrompt = buildPrompt({
    persona,
    config,
    rules: persona.chainRules ?? [],
    scripts: persona.behavioralScripts ?? [],
    state: spec.state,
    impulseIntensity: spec.path === "proactive" ? 0.55 : 0.35,
    corrections: spec.corrections ?? [],
    tags: config.tags,
    userText: spec.userText,
    herViewOfYou: spec.herViewOfYou,
  });
  const promptSegments = splitBuildPrompt(systemPrompt);

  const appended: Segment[] = [];
  const add = (name: string, text: string): void => {
    if (text) appended.push({ name, text, kind: "appended" });
  };

  if (spec.path === "proactive") {
    // 与 processProactive 的 fullSystem 拼接顺序一致
    add("此刻的冲动（主动消息注入）", spec.proactiveInject ?? "");
    if (spec.t1) add("T1 最近状态弧", buildT1ArcContext(makeT1Snapshots(6.4, -0.1)));
    const avoid = buildAvoidRepeatNote(extractRecentReplies(session.messages));
    add("避免重复自己", avoid);
  } else {
    // 与 processMessage / processMessageStream 的 fullSystem 拼接顺序一致
    if (spec.styleRefs?.length) {
      add("动态风格参考", buildStyleContext(spec.styleRefs));
    }
    if (spec.trending) {
      resetTrendingCache();
      const topics = getTrendingTopics();
      const careerKeywords = (persona.identity.lifeStory.career ?? "").split(/[,，、\s]+/).filter(Boolean);
      const matched = matchTrendingTopics(topics, careerKeywords, []);
      add("网络热点", buildTrendingContext(matched));
    }
    if (spec.crisis) {
      const level = detectCrisis(spec.userText);
      if (!level) throw new Error(`[内部错误] 场景 ${spec.id} 标记为危机轮，但 detectCrisis() 未识别`);
      add("危机安全提示", crisisSafetyNote());
    }
    if (spec.t1) add("T1 最近状态弧", buildT1ArcContext(makeT1Snapshots(6.4, -0.1)));
    if (spec.facts) add("用户事实", formatUserFacts(makeUserFacts(spec.facts)));
    const avoid = buildAvoidRepeatNote(extractRecentReplies(session.messages));
    add("避免重复自己", avoid);
    if (spec.mediaRequest) {
      add("媒体请求内部提示", buildMediaRequestNote(detectMediaRequest(spec.userText)));
    }
    add("时间/天气标签", `\n${buildMomentTag(spec.timeCtx, spec.weather)}`);
  }

  const fullSystem = systemPrompt + appended.map((segment) => segment.text).join("");
  const chatMessages = buildChatMessages(session, fullSystem);
  if (!chatMessages[0].content.startsWith(fullSystem)) {
    throw new Error(`[内部错误] 场景 ${spec.id} 的 system message 不是 fullSystem 前缀，分段会失真`);
  }
  const olderSummary = chatMessages[0].content.slice(fullSystem.length);

  // chat.ts 的 buildFinalMessages()：把 RAG 以 "\n" 追加在 system message 末尾（旧消息摘要之后）。
  const ragText =
    spec.path === "chat" && spec.rag?.length ? `\n${buildRagContext(spec.rag)}` : "";
  const ragSegment: Segment | null = ragText
    ? { name: "记忆检索（RAG，chat 层追加）", text: ragText, kind: "appended" }
    : null;
  const systemMessage = chatMessages[0].content + ragText;

  // 自检：所有分段拼起来必须等于最终 system message（防止切分/拼接失真）
  const reconstructed =
    [...promptSegments, ...appended].map((segment) => segment.text).join("") +
    olderSummary +
    (ragSegment?.text ?? "");
  if (reconstructed !== systemMessage) {
    throw new Error(
      `[内部错误] 场景 ${spec.id} 分段重建不一致：reconstructed=${reconstructed.length} system=${systemMessage.length}`,
    );
  }
  const recentMessages = chatMessages.slice(1);

  let recentCharsUser = 0;
  let recentCharsAssistant = 0;
  for (const message of recentMessages) {
    if (message.role === "user") recentCharsUser += message.content.length;
    else recentCharsAssistant += message.content.length;
  }

  return {
    spec,
    promptSegments,
    appendedSegments: appended,
    olderSummary,
    ragSegment,
    systemMessage,
    recentMessages,
    recentChars: { user: recentCharsUser, assistant: recentCharsAssistant },
  };
}

// ── 5. llm_usage 只读统计 ────────────────────────

interface UsageRow {
  created_at: number;
  model: string;
  kind: string;
  prompt_tokens: number;
  completion_tokens: number;
  cached_tokens: number;
  latency_ms: number;
  cost_cny: number;
}

const DB_PATH = path.resolve(REPO_ROOT, "data/memory.sqlite");

function loadUsageRows(): { rows: UsageRow[] | null; note: string } {
  if (!fs.existsSync(DB_PATH)) {
    return { rows: null, note: "未找到 data/memory.sqlite（本机无可用样本）" };
  }
  let db: Database.Database | null = null;
  try {
    db = new Database(DB_PATH, { readonly: true, fileMustExist: true });
    const table = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'llm_usage'")
      .get() as { name?: string } | undefined;
    if (!table?.name) {
      return { rows: null, note: "data/memory.sqlite 中没有 llm_usage 表（本机无可用样本）" };
    }
    const rawRows = db
      .prepare(
        `SELECT created_at, model, kind, prompt_tokens, completion_tokens,
                cached_tokens, latency_ms, cost_cny
         FROM llm_usage
         ORDER BY created_at ASC`,
      )
      .all() as UsageRow[];
    const rows = rawRows.filter(
      (row) =>
        Number.isFinite(row.prompt_tokens) &&
        Number.isFinite(row.created_at) &&
        row.prompt_tokens >= 0,
    );
    if (rows.length === 0) {
      return { rows: null, note: "llm_usage 表为空（本机无可用样本）" };
    }
    return { rows, note: `只读查询 data/memory.sqlite（${rows.length} 条样本）` };
  } catch (err) {
    return {
      rows: null,
      note: `llm_usage 读取失败（本机无可用样本）：${err instanceof Error ? err.message : String(err)}`,
    };
  } finally {
    db?.close();
  }
}

function normalizeTimestamp(value: number): number {
  // created_at 兼容秒/毫秒两种历史写法
  return value < 1_000_000_000_000 ? value * 1000 : value;
}

function beijingDate(ts: number): string {
  const d = new Date(ts + 8 * 3_600_000);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(
    d.getUTCDate(),
  ).padStart(2, "0")}`;
}

function beijingHour(ts: number): number {
  return new Date(ts + 8 * 3_600_000).getUTCHours();
}

function beijingDateTime(ts: number): string {
  const d = new Date(ts + 8 * 3_600_000);
  return `${beijingDate(ts)} ${String(d.getUTCHours()).padStart(2, "0")}:${String(
    d.getUTCMinutes(),
  ).padStart(2, "0")}`;
}

/** 最近秩分位（nearest-rank），避免样本少时的插值误导。 */
function percentile(sortedValues: number[], p: number): number {
  if (sortedValues.length === 0) return NaN;
  const rank = Math.ceil((p / 100) * sortedValues.length);
  const index = Math.min(sortedValues.length - 1, Math.max(0, rank - 1));
  return sortedValues[index];
}

function distribution(values: number[]): {
  n: number;
  mean: number;
  p50: number;
  p90: number;
  p95: number;
  p99: number;
  max: number;
} {
  const sorted = [...values].sort((a, b) => a - b);
  const sum = sorted.reduce((acc, value) => acc + value, 0);
  return {
    n: sorted.length,
    mean: sorted.length > 0 ? sum / sorted.length : NaN,
    p50: percentile(sorted, 50),
    p90: percentile(sorted, 90),
    p95: percentile(sorted, 95),
    p99: percentile(sorted, 99),
    max: sorted.length > 0 ? sorted[sorted.length - 1] : NaN,
  };
}

// ── 6. 输出：llm_usage ──────────────────────────

function printUsageSection(): { rows: UsageRow[] | null } {
  const { rows, note } = loadUsageRows();
  console.log("## 一、llm_usage 实测（真实调用记录，只读）\n");
  if (!rows) {
    console.log(`- ${note}`);
    console.log("- 结论：本机无可用样本，不能给出真实 prompt_tokens 分位/趋势数字。\n");
    return { rows: null };
  }

  const normalized = rows.map((row) => ({ ...row, created_at: normalizeTimestamp(row.created_at) }));
  const promptValues = normalized.map((row) => row.prompt_tokens);
  const completionValues = normalized.map((row) => row.completion_tokens);
  const dialogueRows = normalized.filter((row) => row.kind === "chat" || row.kind === "chatStream");
  const dialoguePromptValues = dialogueRows.map((row) => row.prompt_tokens);
  const dist = distribution(promptValues);
  const dialogueDist = distribution(dialoguePromptValues);
  const completionDist = distribution(completionValues);

  const dates = [...new Set(normalized.map((row) => beijingDate(row.created_at)))].sort();
  const kinds = [...new Set(normalized.map((row) => row.kind))].sort();
  const models = [...new Set(normalized.map((row) => row.model))].sort();
  const totalCost = normalized.reduce((acc, row) => acc + (row.cost_cny || 0), 0);

  console.log(
    `- 样本：**${normalized.length} 次调用**，时间范围 ${beijingDateTime(
      normalized[0].created_at,
    )} → ${beijingDateTime(normalized[normalized.length - 1].created_at)}（北京时间）`,
  );
  console.log(
    `- 覆盖：${dates.length} 个自然日；模型 ${models.join(" / ")}；用途 ${kinds.length} 种；总成本 ¥${totalCost.toFixed(4)}`,
  );
  console.log(`- ${note}\n`);

  // 6.1 prompt_tokens 分位
  console.log("### 1.1 prompt_tokens 分位（全部样本 / 仅对话轮）\n");
  console.log(
    markdownTable(
      ["口径", "样本数", "mean", "p50", "p90", "p95", "p99", "max"],
      [
        [
          "全部 LLM 调用",
          fmtInt(dist.n),
          fmtInt(dist.mean),
          fmtInt(dist.p50),
          fmtInt(dist.p90),
          fmtInt(dist.p95),
          fmtInt(dist.p99),
          fmtInt(dist.max),
        ],
        [
          "仅对话轮（chat + chatStream）",
          fmtInt(dialogueDist.n),
          fmtInt(dialogueDist.mean),
          fmtInt(dialogueDist.p50),
          fmtInt(dialogueDist.p90),
          fmtInt(dialogueDist.p95),
          fmtInt(dialogueDist.p99),
          fmtInt(dialogueDist.max),
        ],
      ],
    ),
  );
  console.log("");

  console.log("### 1.2 completion_tokens 分位（全部样本）\n");
  console.log(
    markdownTable(
      ["样本数", "mean", "p50", "p95", "max"],
      [[fmtInt(completionDist.n), fmtInt(completionDist.mean), fmtInt(completionDist.p50), fmtInt(completionDist.p95), fmtInt(completionDist.max)]],
    ),
  );
  console.log("");

  // 6.2 按用途
  console.log("### 1.3 按用途（kind）拆分\n");
  const byKind = new Map<string, Array<{ prompt: number; completion: number; cost: number }>>();
  for (const row of normalized) {
    const bucket = byKind.get(row.kind) ?? [];
    bucket.push({ prompt: row.prompt_tokens, completion: row.completion_tokens, cost: row.cost_cny || 0 });
    byKind.set(row.kind, bucket);
  }
  const kindRows = [...byKind.entries()]
    .sort((a, b) => b[1].length - a[1].length)
    .map(([kind, bucket]) => {
      const promptDist = distribution(bucket.map((entry) => entry.prompt));
      const completionAvg = bucket.reduce((acc, entry) => acc + entry.completion, 0) / bucket.length;
      const cost = bucket.reduce((acc, entry) => acc + entry.cost, 0);
      return [
        kind,
        fmtInt(bucket.length),
        fmtInt(promptDist.p50),
        fmtInt(promptDist.max),
        fmtInt(completionAvg),
        `¥${cost.toFixed(4)}`,
      ];
    });
  console.log(
    markdownTable(["kind", "次数", "prompt p50", "prompt max", "completion 均值", "成本合计"], kindRows),
  );
  console.log("");

  // 6.3 按天 / 按小时
  console.log("### 1.4 按天趋势（北京时间）\n");
  const byDay = new Map<string, number[]>();
  for (const row of normalized) {
    const date = beijingDate(row.created_at);
    byDay.set(date, [...(byDay.get(date) ?? []), row.prompt_tokens]);
  }
  const dayRows = [...byDay.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([date, values]) => {
      const dayHash = normalized.filter((row) => beijingDate(row.created_at) === date);
      const cacheRatio =
        dayHash.reduce((acc, row) => acc + (row.cached_tokens || 0), 0) /
        Math.max(1, dayHash.reduce((acc, row) => acc + row.prompt_tokens, 0));
      return [
        date,
        fmtInt(values.length),
        fmtInt(percentile([...values].sort((a, b) => a - b), 50)),
        fmtInt(percentile([...values].sort((a, b) => a - b), 95)),
        fmtInt(Math.max(...values)),
        fmtPct(cacheRatio),
      ];
    });
  console.log(markdownTable(["日期", "次数", "prompt p50", "prompt p95", "prompt max", "缓存命中率"], dayRows));
  if (dates.length < 2) {
    console.log(`\n> 注意：样本只覆盖 ${dates.length} 个自然日，**按天趋势不具备对比意义**。`);
  }
  console.log("");

  console.log("### 1.5 按小时分布（北京时间）\n");
  const byHour = new Map<number, number[]>();
  for (const row of normalized) {
    const hour = beijingHour(row.created_at);
    byHour.set(hour, [...(byHour.get(hour) ?? []), row.prompt_tokens]);
  }
  const hourRows = [...byHour.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([hour, values]) => {
      const sorted = [...values].sort((a, b) => a - b);
      return [
        `${String(hour).padStart(2, "0")}:00–${String(hour).padStart(2, "0")}:59`,
        fmtInt(values.length),
        fmtInt(percentile(sorted, 50)),
        fmtInt(Math.max(...values)),
      ];
    });
  console.log(markdownTable(["小时（北京时间）", "次数", "prompt p50", "prompt max"], hourRows));
  console.log("");

  // 6.4 大 prompt 占比
  console.log("### 1.6 大 prompt 占比\n");
  const thresholds = [1000, 1500, 2000, 2500, 3000, 4000];
  const bigRows = thresholds.map((threshold) => {
    const allCount = promptValues.filter((value) => value >= threshold).length;
    const dialogueCount = dialoguePromptValues.filter((value) => value >= threshold).length;
    return [
      `≥ ${fmtInt(threshold)} tokens`,
      `${allCount}（${fmtPct(allCount / promptValues.length)}）`,
      `${dialogueCount}（${fmtPct(dialogueCount / Math.max(1, dialoguePromptValues.length))}）`,
    ];
  });
  console.log(markdownTable(["阈值", "全部样本", "仅对话轮"], bigRows));
  console.log("");

  // 6.5 缓存与成本
  console.log("### 1.7 缓存命中与成本\n");
  const cachedSum = normalized.reduce((acc, row) => acc + (row.cached_tokens || 0), 0);
  const promptSum = normalized.reduce((acc, row) => acc + row.prompt_tokens, 0);
  const cachedRowCount = normalized.filter((row) => (row.cached_tokens || 0) > 0).length;
  const latencyValues = normalized.map((row) => row.latency_ms || 0);
  const latencyDist = distribution(latencyValues);
  console.log(
    markdownTable(
      ["指标", "数值"],
      [
        ["缓存命中 token / prompt token", `${fmtInt(cachedSum)} / ${fmtInt(promptSum)} = ${fmtPct(cachedSum / Math.max(1, promptSum))}`],
        ["有缓存命中的调用数", `${cachedRowCount} / ${normalized.length}（${fmtPct(cachedRowCount / normalized.length)}）`],
        ["平均成本 / 次", `¥${(totalCost / normalized.length).toFixed(5)}`],
        ["成本合计", `¥${totalCost.toFixed(4)}`],
        ["延迟 p50 / p95 / max（ms）", `${fmtInt(latencyDist.p50)} / ${fmtInt(latencyDist.p95)} / ${fmtInt(latencyDist.max)}`],
      ],
    ),
  );
  console.log("");

  // 6.6 top 5
  console.log("### 1.8 单次 prompt 最大的 5 次调用\n");
  const topRows = [...normalized]
    .sort((a, b) => b.prompt_tokens - a.prompt_tokens)
    .slice(0, 5)
    .map((row) => [
      beijingDateTime(row.created_at),
      row.kind,
      row.model,
      fmtInt(row.prompt_tokens),
      fmtInt(row.cached_tokens || 0),
      fmtInt(row.completion_tokens),
      `¥${(row.cost_cny || 0).toFixed(5)}`,
    ]);
  console.log(
    markdownTable(["时间（北京）", "kind", "模型", "prompt", "cached", "completion", "成本"], topRows),
  );
  console.log("");

  return { rows: normalized };
}

// ── 7. 输出：系统提示词分段 ─────────────────────

function summarizeScenario(assembled: AssembledScenario): {
  systemChars: number;
  systemTokens: number;
  staticChars: number;
  staticTokens: number;
  dynamicChars: number;
  dynamicTokens: number;
  appendedChars: number;
  appendedTokens: number;
  olderSummaryChars: number;
  recentChars: number;
  recentTokens: number;
  totalTokens: number;
} {
  const promptSegments = assembled.promptSegments;
  const staticSegments = promptSegments.filter((segment) => segment.kind === "prompt-static");
  const dynamicSegments = promptSegments.filter((segment) => segment.kind === "prompt-dynamic");
  const staticChars = staticSegments.reduce((acc, segment) => acc + segment.text.length, 0);
  const staticTokens = staticSegments.reduce((acc, segment) => acc + estimateTokens(segment.text), 0);
  const dynamicChars = dynamicSegments.reduce((acc, segment) => acc + segment.text.length, 0);
  const dynamicTokens = dynamicSegments.reduce((acc, segment) => acc + estimateTokens(segment.text), 0);
  const systemChars = assembled.systemMessage.length;
  const systemTokens = estimateTokens(assembled.systemMessage);
  // 注入/摘要 = 系统提示词 - buildPrompt 自身的静态/动态段（含 orchestrator 注入、旧摘要、RAG）
  const appendedChars = systemChars - staticChars - dynamicChars;
  const appendedTokens = systemTokens - staticTokens - dynamicTokens;
  const olderSummaryChars = assembled.olderSummary.length;
  const recentChars = assembled.recentChars.user + assembled.recentChars.assistant;
  const recentTokens = assembled.recentMessages.reduce(
    (acc, message) => acc + estimateTokens(message.content),
    0,
  );
  return {
    systemChars,
    systemTokens,
    staticChars,
    staticTokens,
    dynamicChars,
    dynamicTokens,
    appendedChars,
    appendedTokens,
    olderSummaryChars,
    recentChars,
    recentTokens,
    totalTokens: systemTokens + recentTokens,
  };
}

function printScenarioSection(): {
  assembled: AssembledScenario[];
  summaries: ReturnType<typeof summarizeScenario>[];
} {
  console.log("## 二、系统提示词分段（离线构造场景，字符数为真实字符串长度）\n");
  console.log("### 2.1 场景定义\n");
  const scenarioRows = SCENARIOS.map((spec) => [
    spec.id,
    spec.title,
    `${spec.messageCount} 条`,
    `亲密度 ${spec.state.closeness} / 情绪 ${spec.state.emotion} / ${spec.state.mode}`,
    spec.summary,
  ]);
  console.log(markdownTable(["ID", "场景", "历史消息", "运行时状态", "注入块"], scenarioRows));
  console.log("");

  const assembled: AssembledScenario[] = [];
  const summaries: ReturnType<typeof summarizeScenario>[] = [];
  for (const spec of SCENARIOS) {
    const result = buildScenario(spec, persona!, CONFIG);
    assembled.push(result);
    summaries.push(summarizeScenario(result));
  }

  console.log("### 2.2 场景总览（整轮 prompt 规模）\n");
  const overviewRows = assembled.map((item, index) => {
    const summary = summaries[index];
    const messageCount = item.recentMessages.length;
    const userCount = item.recentMessages.filter((message) => message.role === "user").length;
    return [
      item.spec.id,
      item.spec.title,
      `${item.recentMessages.length}（用户 ${userCount} / 她 ${messageCount - userCount}）`,
      fmtInt(summary.systemChars),
      `${fmtInt(summary.staticChars)}（${fmtPct(summary.staticChars / summary.systemChars)}）`,
      fmtInt(summary.appendedChars),
      `${fmtInt(summary.systemTokens)}（静态 ${fmtInt(summary.staticTokens)}）`,
      fmtInt(summary.recentChars),
      `${fmtInt(summary.totalTokens)}（静态 ${fmtPct(summary.staticTokens / summary.totalTokens)}）`,
    ];
  });
  console.log(
    markdownTable(
      [
        "ID",
        "场景",
        "最近消息",
        "系统提示词字符",
        "其中静态块",
        "注入/摘要字符",
        "系统估算 tokens",
        "最近消息字符",
        "整轮估算 tokens",
      ],
      overviewRows,
    ),
  );
  console.log("");

  // 分段矩阵（按场景列展开，便于比较；顺序固定，便于跨版本对比）
  console.log("### 2.3 分段矩阵（字符数；同一段落跨场景对比）\n");
  const APPENDED_ORDER = [
    "动态风格参考",
    "网络热点",
    "危机安全提示",
    "T1 最近状态弧",
    "用户事实",
    "避免重复自己",
    "媒体请求内部提示",
    "此刻的冲动（主动消息注入）",
    "时间/天气标签",
  ];
  const segmentOrder: string[] = [];
  for (const item of assembled) {
    for (const segment of item.promptSegments) {
      if (!segmentOrder.includes(segment.name)) segmentOrder.push(segment.name);
    }
  }
  for (const name of APPENDED_ORDER) {
    if (!segmentOrder.includes(name)) segmentOrder.push(name);
  }
  segmentOrder.push("旧消息摘要（buildChatMessages）");
  segmentOrder.push("记忆检索（RAG，chat 层追加）");

  const lookupSegment = (item: AssembledScenario, name: string): string => {
    const found = [...item.promptSegments, ...item.appendedSegments].find(
      (segment) => segment.name === name,
    );
    if (found) return found.text;
    if (name === "旧消息摘要（buildChatMessages）") return item.olderSummary;
    if (name === "记忆检索（RAG，chat 层追加）") return item.ragSegment?.text ?? "";
    return "";
  };

  const segmentRows = segmentOrder.map((name) => {
    const cells = assembled.map((item) => {
      const text = lookupSegment(item, name);
      return text.length > 0 ? fmtInt(text.length) : "—";
    });
    return [name, ...cells];
  });
  segmentRows.push([
    "**系统提示词合计**",
    ...summaries.map((summary) => `**${fmtInt(summary.systemChars)}**`),
  ]);
  segmentRows.push([
    "最近对话（15 条上限）",
    ...assembled.map((item) => fmtInt(item.recentChars.user + item.recentChars.assistant)),
  ]);
  console.log(
    markdownTable(
      ["段落", "S1 初识", "S2 稳定", "S3 记忆", "S4 危机", "S5 主动"],
      segmentRows,
    ),
  );
  console.log("");

  // S2 细表（典型场景：字符、估算 tokens、占系统提示词比例）
  const typical = assembled[1];
  const typicalSummary = summaries[1];
  console.log(
    `### 2.4 典型场景 S2「关系稳定」细表（占比基数为系统提示词 ${fmtInt(
      typicalSummary.systemChars,
    )} 字符）\n`,
  );
  const detailRows = [...typical.promptSegments, ...typical.appendedSegments]
    .filter((segment) => segment.text.length > 0)
    .map((segment) => [
      segment.name,
      fmtInt(segment.text.length),
      fmtInt(estimateTokens(segment.text)),
      fmtPct(segment.text.length / typicalSummary.systemChars),
    ]);
  if (typical.olderSummary.length > 0) {
    detailRows.push([
      "旧消息摘要（buildChatMessages）",
      fmtInt(typical.olderSummary.length),
      fmtInt(estimateTokens(typical.olderSummary)),
      fmtPct(typical.olderSummary.length / typicalSummary.systemChars),
    ]);
  }
  if (typical.ragSegment && typical.ragSegment.text.length > 0) {
    detailRows.push([
      typical.ragSegment.name,
      fmtInt(typical.ragSegment.text.length),
      fmtInt(estimateTokens(typical.ragSegment.text)),
      fmtPct(typical.ragSegment.text.length / typicalSummary.systemChars),
    ]);
  }
  detailRows.push([
    "**合计（系统提示词）**",
    `**${fmtInt(typicalSummary.systemChars)}**`,
    `**${fmtInt(typicalSummary.systemTokens)}**`,
    "100.0%",
  ]);
  console.log(markdownTable(["段落", "字符数", "估算 tokens", "占系统提示词"], detailRows));
  console.log("");
  console.log(
    `> S2 最近对话 ${typical.recentMessages.length} 条：用户侧 ${fmtInt(
      typical.recentChars.user,
    )} 字符 / 她 ${fmtInt(typical.recentChars.assistant)} 字符，估算 ${fmtInt(
      typicalSummary.recentTokens,
    )} tokens；整轮（系统+对话）估算 ${fmtInt(typicalSummary.totalTokens)} tokens。`,
  );
  console.log("");

  // 2.5 约束重复度（同一约束在 S2 系统提示词里被重复表达多少次）
  console.log("### 2.5 约束重复度（S2 系统提示词内，按关键词计数）\n");
  const constraintKeywords: Array<{ keyword: string; meaning: string }> = [
    { keyword: "括号", meaning: "禁止括号描述动作（铁律 / 重要提示 / 原则 三处）" },
    { keyword: "编造", meaning: "禁止编造往事 / 相识场景" },
    { keyword: "套话", meaning: "禁止套话与自我分析开头" },
    { keyword: "问句", meaning: "不以问句结尾" },
    { keyword: "AI", meaning: "不暴露 AI 身份" },
  ];
  const typicalSystem = typical.systemMessage;
  const constraintRows = constraintKeywords.map(({ keyword, meaning }) => {
    const count = typicalSystem.split(keyword).length - 1;
    return [keyword, fmtInt(count), meaning];
  });
  console.log(markdownTable(["关键词", "出现次数", "对应约束"], constraintRows));
  console.log(
    "\n> 注：关键词计数包含被提及/解释的次数，只用于说明「同一约束散落在多个段落」；不是精确的重复字符数。\n",
  );

  return { assembled, summaries };
}

// ── 8. 交叉验证 ─────────────────────────────────

function printCrossCheck(
  usageRows: UsageRow[] | null,
  assembled: AssembledScenario[],
  summaries: ReturnType<typeof summarizeScenario>[],
): void {
  console.log("## 三、估算 vs 实测（交叉验证）\n");
  if (!usageRows) {
    console.log("> 本机无 llm_usage 样本，无法交叉验证。\n");
    return;
  }
  const dialogueRows = usageRows.filter((row) => row.kind === "chat" || row.kind === "chatStream");
  const dialogueDist = distribution(dialogueRows.map((row) => row.prompt_tokens));
  const streamRows = usageRows.filter((row) => row.kind === "chatStream");
  const streamDist = distribution(streamRows.map((row) => row.prompt_tokens));
  const typicalIndex = 1; // S2
  const typical = assembled[typicalIndex];
  const typicalSummary = summaries[typicalIndex];
  const deltaP50 = (typicalSummary.totalTokens - streamDist.p50) / streamDist.p50;
  const deltaP95 = (typicalSummary.totalTokens - streamDist.p95) / streamDist.p95;
  console.log(
    markdownTable(
      ["口径", "估算 tokens", "实测参考", "偏差"],
      [
        [
          "S2 关系稳定 整轮（系统 + 最近 15 条）",
          fmtInt(typicalSummary.totalTokens),
          `chatStream p50 = ${fmtInt(streamDist.p50)}`,
          `${deltaP50 >= 0 ? "+" : ""}${fmtPct(deltaP50)}`,
        ],
        [
          "S2 关系稳定 整轮",
          fmtInt(typicalSummary.totalTokens),
          `chatStream p95 = ${fmtInt(streamDist.p95)}`,
          `${deltaP95 >= 0 ? "+" : ""}${fmtPct(deltaP95)}`,
        ],
        [
          "S2 关系稳定 系统提示词部分",
          fmtInt(typicalSummary.systemTokens),
          `chatStream p50 = ${fmtInt(streamDist.p50)}`,
          `${(typicalSummary.systemTokens - streamDist.p50) / streamDist.p50 >= 0 ? "+" : ""}${fmtPct(
            (typicalSummary.systemTokens - streamDist.p50) / streamDist.p50,
          )}`,
        ],
        [
          "S2 关系稳定 整轮",
          fmtInt(typicalSummary.totalTokens),
          `全部对话轮（chat+chatStream）p50 = ${fmtInt(dialogueDist.p50)}`,
          `${(typicalSummary.totalTokens - dialogueDist.p50) / dialogueDist.p50 >= 0 ? "+" : ""}${fmtPct(
            (typicalSummary.totalTokens - dialogueDist.p50) / dialogueDist.p50,
          )}`,
        ],
      ],
    ),
  );
  console.log("");

  // 静态块 vs 实测缓存命中：验证「静态前缀确实被缓存覆盖」的量级
  const cachedDist = distribution(streamRows.map((row) => row.cached_tokens || 0));
  const staticTokens = summaries[typicalIndex].staticTokens;
  console.log(
    markdownTable(
      ["指标", "估算 / 实测", "说明"],
      [
        [
          "S2 静态块估算 tokens",
          fmtInt(staticTokens),
          "buildPrompt 内不随轮次变化的人设+铁律+行为规则段",
        ],
        [
          "chatStream 单次 cached_tokens 中位",
          fmtInt(cachedDist.p50),
          "实测缓存命中（DeepSeek prompt cache）",
        ],
        [
          "chatStream 单次 cached_tokens p95 / max",
          `${fmtInt(cachedDist.p95)} / ${fmtInt(cachedDist.max)}`,
          "缓存命中上限受前缀长度影响",
        ],
      ],
    ),
  );
  console.log(
    "\n> 量级判断：实测单次缓存命中中位数 ≈ 静态块估算 token 的 " +
      `${fmtPct(cachedDist.p50 / Math.max(1, staticTokens))}，说明静态块基本落在缓存前缀里；` +
      "但它仍计入上下文长度与 TTFT，且动态注入/历史越长，prefix 之后要重算的部分越多。\n",
  );

  console.log(
    "\n> 说明：估算按 CJK≈1 / ASCII≈0.3 粗算（对中文偏保守/偏高），未计入 chat 模板、消息 role 包装与供应商计费差异；\n" +
      "> 实测样本包含不同历史长度与不同注入组合，与 S2 不是同一 prompt 的严格对照。偏差用于判断量级；\n" +
      "> 成本/延迟结论应优先使用实测 p50/p95，估算只用于「段落之间谁更大」的相对比较。\n",
  );
}

// ── 9. 主流程 ───────────────────────────────────

let persona: Persona | null = null;

async function main(): Promise<void> {
  assertRepoRoot();
  installDeterministicRandom();
  try {
    persona = await loadPersona(PERSONA_ID);
    console.log("# Prompt 预算离线审计（实测 + 估算）\n");
    console.log(
      `- 日期：脚本运行于 ${beijingDate(Date.now())}（北京时间）；版本：karen-persona v0.3.3\n` +
        `- 人设：${PERSONA_ID}（${persona.name}）；配置：your_name=${YOUR_NAME}、location=${CONFIG.location}、tags=${JSON.stringify(
          CONFIG.tags,
        )}\n` +
        `- 口径：字符数为 JS 字符串长度；token 为粗估（CJK≈1、ASCII≈0.3，标注「估算」）；llm_usage 为只读查询\n` +
        `- 复现：\`.runtime/node22/bin/node node_modules/tsx/dist/cli.mjs scripts/prompt-budget.ts\`（仓库根目录）\n`,
    );
    const { rows } = printUsageSection();
    const { assembled, summaries } = printScenarioSection();
    printCrossCheck(rows, assembled, summaries);
    console.log("## 四、复现说明\n");
    console.log(
      "- 本脚本只读：不写 data/、不联网、不调用 LLM；llm_usage 以 `readonly: true` 打开。\n" +
        "- 场景 fixture 与种子 RNG 固定，重复运行结果一致（除 `data/memory.sqlite` 本身新增记录）。\n" +
        "- 如脚本在非仓库根目录运行会直接报错退出，避免读到错误路径的数据。\n",
    );
  } finally {
    restoreRandom();
  }
}

main().catch((err) => {
  restoreRandom();
  console.error("[prompt-budget] 运行失败：", err instanceof Error ? err.stack : err);
  process.exit(1);
});

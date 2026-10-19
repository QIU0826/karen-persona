/** 域三：响应管线编排器 — 供 CLI 和 QQ/微信桥接共用 */
import { chat, chatStream } from "../ai/chat.js";
import { classifyComplexity } from "../ai/router.js";
import { addMessage, buildChatMessages, loadSession, type ConversationSession } from "../data/history.js";
import { decideGate, getBusyLevel, type GateAction, type GateContext } from "../impulse/message-gate.js";
import { insertT1Snapshot, insertEpisode, setCurrentPersona, applyGlobalDecay, archiveDecayedEpisodes, closeVectorDb, backfillEpisodeVectors } from "../data/vector.js";
import { generateEmbedding } from "../data/embedding.js";
import {
  retrieveRelevantMemories,
  buildRagContext,
  storeConversationEpisode,
} from "../data/retriever.js";
import {
  createEmotionState,
  adjustEmotion,
  naturalRecover,
  calculateImpulseIntensity,
  describeEmotion,
  type EmotionState,
} from "../persona/emotion.js";
import {
  createGuiltState,
  incurGuilt,
  dailyDecay,
  resentmentEffect,
  type GuiltState,
} from "../persona/guilt-repayment.js";
import {
  createSocialTact,
  exposureRatio,
  type SocialTact,
} from "../persona/social-tact.js";
import {
  buildPrompt,
  computeThreshold,
  buildStateLabel,
  checkRuleBreach,
  type ChainRule,
  type BehavioralScript,
  type CorrectionOverlay,
  type InnerState,
} from "../persona/prompt-builder.js";
import { mockWeather, fetchWeather, perceiveWeather, clearWeatherCache, type WeatherPerception } from "../world/weather.js";
import { getTrendingTopics, matchTrendingTopics, buildTrendingContext } from "../world/trending-fetcher.js";
import { deriveStance } from "../world/stance.js";
import { perceiveTime, buildMomentTag } from "../world/time-awareness.js";
import { renderExpression } from "../impulse/renderer.js";
import { trySharePhoto } from "../impulse/unsplash-trigger.js";
import { shouldUpdateView, generateHerView } from "../evolution/her-view.js";
import { addCorrection, applyCorrections } from "../persona/correction.js";
import {
  createDriftState,
  addDriftPressure,
  checkAwareness,
  dailyRebound,
  getDriftOffset,
  type DriftState,
} from "../evolution/baseline-drift.js";
import {
  createChain,
  addUserTrace,
  recallUserTrace,
  generateIntrusion,
  type CausalChain,
} from "../evolution/causal-chain.js";
import { metabolizeMemories } from "../evolution/memory-decay.js";
import { generateMonologue, storeMonologue, generateNightMonologue } from "../evolution/internal-monologue.js";
import { retrieveStyleReference, buildStyleContext } from "../evolution/style-reference.js";
import { maybeCompressToT3 } from "../evolution/t3-summarizer.js";
import { maybeGenerateJournal } from "../evolution/persona-journal.js";
import {
  createNarrativeArc,
  advanceNarrativeArc,
  shouldInjectNarrative,
  markNarrativeExpressed,
  flipThroughDiary,
  type NarrativeArc,
} from "../evolution/narrative-reconstruct.js";
import {
  calculateExceptionThreshold,
  isException,
  inferPersonaType,
} from "../impulse/exception.js";
import {
  createSilenceState,
  touchUserActivity,
  getSilencePhase,
  generateRestartMessage,
  type SilenceState,
} from "../impulse/silence-arc.js";
import type { Persona } from "../persona/loader.js";
import type { AppConfig } from "../data/store.js";
import {
  loadPersonaState,
  savePersonaState,
  PERSONA_STATE_VERSION,
  type PersistedPersonaState,
} from "../data/state-store.js";
import {
  evaluateRelationshipEvent,
  applyRelationshipEvent,
  touchInteraction,
  closenessLabel,
  createRelationshipState,
  type RelationshipState,
} from "../persona/relationship.js";

// ── 会话状态 ──────────────────────────────────

export interface ConversationState {
  persona: Persona;
  config: AppConfig;
  /** V2: 链式规则（从 persona.json 加载） */
  chainRules: ChainRule[];
  /** V2: 行为脚本（从 persona.json 加载） */
  behavioralScripts: BehavioralScript[];
  /** V2: 纠正确认覆盖（运行时累积） */
  corrections: CorrectionOverlay[];
  /** EMA 平滑的内心状态 */
  innerState: InnerState;
  /** EMA 平滑用的前一帧（用于计算增量） */
  prevInnerState: InnerState;
  emotionState: EmotionState;
  guiltState: GuiltState;
  socialTact: SocialTact;
  driftState: DriftState;
  causalChains: CausalChain[];
  silenceState: SilenceState;
  session: ConversationSession;
  personaType: ReturnType<typeof inferPersonaType>;
  stance: ReturnType<typeof deriveStance>;
  weatherPerception: WeatherPerception;
  /** 当前天气快照的 moodOffset 是否已应用（防止每次消息重复叠加） */
  weatherApplied: boolean;
  /** 上次触发分享冲动的天气 condition（避免同一场雨反复触发） */
  lastSharedWeather: string | null;
  /** 上次生活流心跳时间戳 */
  lastHeartbeatAt: number;
  /** 上次注入热点上下文的时间戳（防频繁） */
  lastTrendingInject: number;
  /** 上一轮发送被用户新消息打断（用于下一轮 prompt 注入） */
  interrupted: boolean;
  /** P1-d: 表情输出模式 */
  stickerMode: "kaomoji" | "qqface";
  /** P2-b: 自我叙事弧线 */
  narrativeArc: NarrativeArc;
  /** 上次叙事阶段（用于检测阶段变化触发 herView 更新） */
  lastNarrativeStage: string | null;
  /** 动态 herViewOfYou（运行时由 her-view.ts 更新） */
  herViewOfYou: string | null;
  /** 上一版 herViewOfYou（用于自我叙事引用） */
  previousViewOfYou: string | null;
  /** 上次更新 herView 时的亲密度 */
  lastViewUpdateCloseness: number;
  /** 上次更新 herView 的时间戳 */
  lastViewUpdateAt: number | null;
  /** 是否正在生成 herView（防止并发） */
  herViewGenerating: boolean;
  /** 连续被消息门沉默的次数（≥3 时强制回复，避免长期「装死」） */
  consecutiveSilences: number;
  /** 上次天气拉取时间戳（30 分钟 TTL，避免只在启动时拉一次） */
  weatherFetchedAt: number;
  /** 上次主动消息发送时间戳（治理：避免高频主动打扰） */
  lastProactiveSentAt: number;
  /** 当天主动消息计数 */
  proactiveCountToday: number;
  /** 主动消息计数所属日期（YYYY-MM-DD，本地时区） */
  proactiveDay: string;
  /** M1-2: 关系状态（亲密度/事件/里程碑），持久化于 persona-state */
  relationshipState: RelationshipState;
}

export interface PipelineResult {
  reply: string;
  logs: string[];
  /** P1-d: QQ 表情 CQ 码（附加消息，在 reply 之后发送） */
  qqFace?: string;
  /** P2-c: Unsplash 主动发图 URL */
  imageUrl?: string;
  /** P2-c: 配图文字 */
  imageCaption?: string;
  /** 消息门判定「晚点回」：调用方应在 delayMs 后以 {bypassGate:true, skipUserPersist:true} 重新调用 */
  deferred?: { delayMs: number };
  /** 消息门判定「这一轮不回」（沉默） */
  silenced?: boolean;
}

/** processMessage / processMessageStream 的可选行为开关 */
export interface ProcessOptions {
  /** 跳过消息门，强制回复（用于延迟补回复/连续沉默兜底） */
  bypassGate?: boolean;
  /** 跳过用户消息落库（延迟补回复时原消息已落库） */
  skipUserPersist?: boolean;
}

// ── 初始化 ────────────────────────────────────

export async function initConversation(persona: Persona, config: AppConfig): Promise<ConversationState> {
  // 设置当前人设 ID，确保 T1/T2 记忆按人设隔离
  setCurrentPersona(config.persona);

  // V2: 从 persona 加载链式规则和行为脚本
  const chainRules = persona.chainRules ?? defaultChainRules();
  const behavioralScripts = persona.behavioralScripts ?? defaultBehavioralScripts();

  // M1-1: 先加载持久化的人格运行时状态（情绪/负债/漂移/关系/因果链/herView…）
  const persisted = loadPersonaState(persona.name, persona.relationship.closeness);

  const emotionState = persisted?.emotion ?? createEmotionState();
  const guiltState = persisted?.guilt ?? createGuiltState();
  const socialTact = createSocialTact(persona.emotions.attachmentStyle);
  const driftState = persisted?.drift ?? createDriftState(emotionState.baseline);
  const causalChains: CausalChain[] =
    persisted?.causalChains && persisted.causalChains.length > 0
      ? persisted.causalChains
      : defaultCausalChains();
  const silenceState = persisted?.silence ?? createSilenceState();
  const narrativeArc = persisted?.narrativeArc ?? createNarrativeArc();
  const relationshipState = persisted?.relationship ?? createRelationshipState(persona.relationship.closeness);
  // persona.relationship.closeness 是全代码读取的唯一来源：用持久化值覆盖静态人设值
  persona.relationship.closeness = relationshipState.closeness;

  const session = loadSession(persona.name);
  const personaType = inferPersonaType(persona.speaking.tone, persona.emotions.attachmentStyle);
  const stance = deriveStance(persona.identity.age, persona.emotions.attachmentStyle);

  // 天气：优先复用持久化快照（刷新逻辑在每轮消息里按 TTL 触发）
  let weatherPerception: WeatherPerception;
  let weatherFetchedAt: number;
  if (persisted?.weather) {
    weatherPerception = perceiveWeather(
      persisted.weather.raw,
      stance.weather,
      emotionState.baseline,
      null,
    );
    weatherFetchedAt = persisted.weather.fetchedAt;
  } else {
    const weather = (await fetchWeather(config.location)) ?? mockWeather(config.location);
    weatherPerception = perceiveWeather(weather, stance.weather, emotionState.baseline, null);
    weatherFetchedAt = Date.now();
  }

  // V2: 初始内心状态
  const now = new Date();
  const innerState: InnerState = {
    exposure: exposureRatio(socialTact, relationshipState.closeness),
    guilt: guiltState.guilt,
    emotion: emotionState.vector,
    hour: now.getHours(),
    mode: "neutral",
    closeness: relationshipState.closeness,
  };

  // 一次性回填历史记忆的嵌入向量（幂等）
  const backfilled = backfillEpisodeVectors(generateEmbedding);
  if (backfilled > 0) {
    console.log(`[向量] 已为 ${backfilled} 条历史记忆生成嵌入`);
  }

  const counters = persisted?.counters;
  const herView = persisted?.herView;

  return {
    persona, config, chainRules, behavioralScripts,
    corrections: [],
    innerState, prevInnerState: { ...innerState },
    emotionState, guiltState, socialTact,
    driftState, causalChains, silenceState, session, personaType, stance,
    weatherPerception, weatherApplied: false,
    lastSharedWeather: counters?.lastSharedWeather ?? null,
    lastHeartbeatAt: counters?.lastHeartbeatAt ?? 0,
    lastTrendingInject: counters?.lastTrendingInject ?? 0,
    interrupted: counters?.interrupted ?? false,
    stickerMode: "kaomoji", // CLI default, QQ bridge overrides
    narrativeArc,
    lastNarrativeStage: persisted ? null : null,
    herViewOfYou: herView?.current ?? persona.relationship.herViewOfYou ?? null,
    previousViewOfYou: herView?.previous ?? null,
    lastViewUpdateCloseness: herView?.lastUpdateCloseness ?? relationshipState.closeness,
    lastViewUpdateAt: herView?.lastUpdateAt ?? null,
    herViewGenerating: false,
    consecutiveSilences: counters?.consecutiveSilences ?? 0,
    weatherFetchedAt,
    lastProactiveSentAt: counters?.lastProactiveSentAt ?? 0,
    proactiveCountToday: counters?.proactiveCountToday ?? 0,
    proactiveDay: counters?.proactiveDay ?? "",
    relationshipState,
  };
}

/** 默认因果链（人设没配时使用） */
function defaultCausalChains(): CausalChain[] {
  return [
    createChain("coffee-machine", "continuous", "咖啡机老化", "咖啡机最近不太稳定", 0.2),
    createChain("shop-business", "continuous", "咖啡店生意", "这个月客流比上个月少", 0.15),
    createChain("xiaoyu-relationship", "relational", "小雨的恋爱", "小雨说她男朋友最近很忙", 0.1),
  ];
}

// ── V2: 默认链式规则和行为脚本（persona.json 缺失时回退） ─

function defaultChainRules(): ChainRule[] {
  return [
    {
      id: "no_brackets",
      resistance: 0.95,
      immutable: true,
      immutable_reason: "核心设计原则——不用括号是产品理念的底线",
      text: "绝对不用括号描述动作",
      chain: {
        trigger: "任何回复时刻",
        internal: "我不是在演戏，我就是我。我的状态通过文字表达，不是通过舞台指示。",
        behavior: "用文字描述你在做什么，不要用括号演出来",
      },
    },
    {
      id: "short_fragments",
      resistance: 0.8,
      text: "碎短句，每条5-15字",
      chain: {
        trigger: "回复较长内容时",
        internal: "真实的人发消息不会写小作文。我想说很多，但我一句一句来。",
        behavior: "长内容拆成2-4条短消息",
      },
    },
    {
      id: "no_question_ending",
      resistance: 0.6,
      text: "不以问句结尾",
      chain: {
        trigger: "自然收尾时",
        internal: "我不需要每次都把话题延续下去，我可以只是存在于对话中。",
        behavior: "用短句收尾或换话题，不以问号结尾",
      },
    },
    {
      id: "no_ai_identity",
      resistance: 0.95,
      immutable: true,
      immutable_reason: "AI 身份暴露破坏沉浸感",
      text: "不暴露 AI 身份",
      chain: {
        trigger: "被问到技术或训练相关",
        internal: "我是真实的自己，不是某种产品。",
        behavior: "用自然人的方式回应，不谈技术背景",
      },
    },
    {
      id: "typo_and_withdraw",
      resistance: 0.4,
      text: "偶尔错别字、撤回",
      chain: {
        trigger: "深夜或情绪波动时",
        internal: "真实的聊天没那么完美。打错了就撤回，忘了就算了。",
        behavior: "偶尔打错字后撤回重发，或干脆不改",
      },
    },
  ];
}

function defaultBehavioralScripts(): BehavioralScript[] {
  return [
    {
      trigger: "positive_affection",
      sequence: ["先否认或转移（1-3字）", "停顿", "小声承认（带省略号）"],
      tone: "傲娇否认→小声承认",
      applicable_mode: ["close", "neutral"],
    },
    {
      trigger: "negative_venting",
      sequence: ["先表示听到了", "不急着给建议", "简短共情"],
      tone: "克制陪伴",
      applicable_mode: ["neutral", "close", "distant"],
    },
    {
      trigger: "casual_chitchat",
      sequence: ["自然回应", "保持日常语气"],
      tone: "日常慵懒",
      applicable_mode: ["neutral", "distant", "close", "avoidant", "guilty"],
      rhythm: "日常节奏 2-4 条短消息。不写长文。对方插话先回应再继续。不要同时推进超过两个话题。如果对方提出了新话题，先回应新话题。",
    },
    {
      trigger: "direct_question",
      sequence: ["回答问题的核心", "不需要展开太多"],
      tone: "直接但不生硬",
      applicable_mode: ["neutral", "distant", "close"],
    },
    {
      trigger: "after_silence",
      sequence: ["不需要解释为什么没回", "自然接上话题", "或开新话题"],
      tone: "若无其事",
      applicable_mode: ["neutral", "close", "avoidant", "guilty"],
    },
    {
      trigger: "exception_moment",
      sequence: ["自我觉察到不寻常", "小声一句自我解释"],
      tone: "自我觉察",
      applicable_mode: ["guilty"],
    },
    {
      trigger: "media_shared",
      sequence: ["图片内容已经在消息里描述了", "根据描述自然回应，不用假装看不见"],
      tone: "自然回应，看到了就是看到了",
      applicable_mode: ["neutral", "close", "distant", "avoidant"],
    },
  ];
}

// ── M0: 共享门控上下文 / 天气刷新 ──────────────

const WEATHER_TTL_MS = 30 * 60 * 1000;

/**
 * 构造消息门上下文。
 * CLI 与 QQ、流式与非流式共用同一套上下文，避免「写死 messageCountToday=0」导致的门控失真。
 */
export function buildGateContext(
  state: ConversationState,
  userInput: string,
  now: Date = new Date(),
): GateContext {
  const { persona, emotionState, guiltState, session } = state;
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const userMsgsToday = session.messages.filter(
    (m) => m.role === "user" && m.timestamp >= todayStart
  );
  const messageCountToday = userMsgsToday.length;
  const isRapidFollowUp =
    userMsgsToday.length >= 2 &&
    userMsgsToday[userMsgsToday.length - 1].timestamp -
      userMsgsToday[userMsgsToday.length - 2].timestamp <
      5 * 60 * 1000;

  const trimmed = userInput.trim();
  const msgType: GateContext["messageType"] =
    /^\[图片/.test(trimmed) ? "image" : /^\[语音/.test(trimmed) ? "voice" : "text";

  return {
    personaId: persona.name,
    currentHour: now.getHours(),
    isWorkHours: now.getHours() >= 8 && now.getHours() < 17,
    emotionVector: emotionState.vector,
    guilt: guiltState.guilt,
    messageType: msgType,
    isAvoidedTopic: persona.hardRules.triggerWords.some((t) => userInput.includes(t.word)),
    isNaturalEnding: /^(嗯|好|ok|哈哈|好的|行|哦)$/i.test(trimmed),
    messageCountToday,
    isRapidFollowUp,
    isQuickChat: trimmed.length <= 6 && /[\?？]/.test(trimmed),
    closeness: persona.relationship.closeness,
    dailyRhythm: persona.world.dailyRhythm as Array<{ time: string; activity: string }>,
  };
}

/**
 * 决定本轮门控动作。
 * - bypassGate：延迟补回复 / 连续沉默兜底时强制回复
 * - consecutiveSilences ≥ 3：即使门控想沉默，也强制回一次，避免用户被永久 ghost
 */
function decideGateForTurn(
  state: ConversationState,
  ctx: GateContext,
  opts: ProcessOptions,
): GateAction {
  if (opts.bypassGate) return { type: "reply", delayMs: 800 };
  if (state.consecutiveSilences >= 3) {
    console.log(`[消息门] 连续沉默 ${state.consecutiveSilences} 次，强制回复一次`);
    return { type: "reply", delayMs: 1200 };
  }
  return decideGate(ctx);
}

/** 天气每 30 分钟刷新一次；失配时重新允许应用 moodOffset */
export async function refreshWeatherIfStale(state: ConversationState): Promise<void> {
  if (Date.now() - state.weatherFetchedAt < WEATHER_TTL_MS) return;
  state.weatherFetchedAt = Date.now();
  try {
    // 绕过 weather.ts 的 30 分钟缓存，确保到达 TTL 时真的取到新数据
    clearWeatherCache();
    const weather = await fetchWeather(state.config.location);
    if (!weather) return;
    const oldCondition = state.weatherPerception.raw.condition;
    state.weatherPerception = perceiveWeather(
      weather,
      state.stance.weather,
      state.emotionState.baseline,
      null,
    );
    if (oldCondition !== weather.condition) {
      state.weatherApplied = false;
      console.log(`[天气] 刷新: ${weather.description} ${weather.temp}°C`);
    }
  } catch {
    // 天气失败不影响对话
  }
}

/** 合并附加上下文（保持拼接顺序稳定，便于排查） */
function narrationContext(style: string, trending: string, interrupt: string, narrative: string): string {
  return style + trending + interrupt + narrative;
}

// ── M1-1/M1-2: 状态持久化与关系成长 ─────────────

/** 把当前运行时状态落盘（每个处理回合结束时调用；失败不影响对话） */
export function persistRuntimeState(state: ConversationState): void {
  try {
    const snapshot: PersistedPersonaState = {
      version: PERSONA_STATE_VERSION,
      personaId: state.persona.name,
      savedAt: Date.now(),
      emotion: state.emotionState,
      guilt: state.guiltState,
      drift: state.driftState,
      silence: state.silenceState,
      causalChains: state.causalChains,
      narrativeArc: state.narrativeArc,
      herView: {
        current: state.herViewOfYou,
        previous: state.previousViewOfYou,
        lastUpdateCloseness: state.lastViewUpdateCloseness,
        lastUpdateAt: state.lastViewUpdateAt,
      },
      relationship: state.relationshipState,
      counters: {
        consecutiveSilences: state.consecutiveSilences,
        lastProactiveSentAt: state.lastProactiveSentAt,
        proactiveCountToday: state.proactiveCountToday,
        proactiveDay: state.proactiveDay,
        lastHeartbeatAt: state.lastHeartbeatAt,
        lastTrendingInject: state.lastTrendingInject,
        lastSharedWeather: state.lastSharedWeather,
        interrupted: state.interrupted,
      },
      weather: { raw: state.weatherPerception.raw, fetchedAt: state.weatherFetchedAt },
    };
    savePersonaState(snapshot);
  } catch (err) {
    console.log(`[状态] 保存失败: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** 本轮结束后更新关系（含里程碑日志），返回可打印的日志行 */
export function updateRelationshipAfterTurn(
  state: ConversationState,
  userInput: string,
  replyText: string,
  complexity: ReturnType<typeof classifyComplexity>,
): string[] {
  const messages: string[] = [];
  const now = new Date();
  const before = state.relationshipState.closeness;
  const beforeMilestones = state.relationshipState.milestones.length;

  const evaluation = evaluateRelationshipEvent(state.relationshipState, {
    currentCloseness: state.relationshipState.closeness,
    userText: userInput,
    replyText,
    complexity,
    guilt: state.guiltState.guilt,
    now,
  });

  if (evaluation) {
    state.relationshipState = applyRelationshipEvent(
      state.relationshipState,
      evaluation.delta,
      evaluation.reason,
      now,
    );
    const after = state.relationshipState.closeness;
    state.persona.relationship.closeness = after;
    messages.push(
      `[关系] ${evaluation.reason}：亲密度 ${before.toFixed(2)} → ${after.toFixed(2)}（${closenessLabel(after)}）`,
    );
    if (state.relationshipState.milestones.length > beforeMilestones) {
      const milestone = state.relationshipState.milestones[state.relationshipState.milestones.length - 1];
      messages.push(`[关系] 里程碑：${milestone.title}`);
    }
  } else {
    state.relationshipState = touchInteraction(state.relationshipState, now);
  }
  return messages;
}

// ── 单轮处理 ──────────────────────────────────



export async function processMessage(
  state: ConversationState,
  userInput: string,
  opts: ProcessOptions = {},
): Promise<PipelineResult> {
  const logs: string[] = [];
  const now = new Date();
  const { persona, config, emotionState, guiltState, socialTact, driftState, causalChains, silenceState, session, stance, weatherPerception } = state;

  // A0. 天气定时刷新（30 分钟 TTL）
  await refreshWeatherIfStale(state);

  // A. 情绪自然恢复
  Object.assign(emotionState, naturalRecover(emotionState));

  // A2. 天气感知 → 情绪偏移（每个天气快照仅应用一次）
  if (!state.weatherApplied && Math.abs(weatherPerception.moodOffset) > 0.01) {
    Object.assign(emotionState, adjustEmotion(emotionState, weatherPerception.moodOffset, "天气感知"));
    state.weatherApplied = true;
  }

  // B. 沉默追踪
  Object.assign(silenceState, touchUserActivity(silenceState, userInput));
  const silencePhase = getSilencePhase(silenceState);
  if (silencePhase >= 3 && !silenceState.restartSent) {
    const restartMsg = generateRestartMessage(silenceState, userInput);
    logs.push(`[沉默] 阶段${silencePhase}，建议重启: "${restartMsg}"`);
  }

  // C. 因果链闯入 + 漂移
  const intrusion = generateIntrusion(causalChains);
  if (intrusion) {
    logs.push(`[因果链] 闯入: ${intrusion.description}`);
    Object.assign(emotionState, adjustEmotion(emotionState, intrusion.intensity * (Math.random() > 0.5 ? 1 : -1) * 0.1, "闯入事件"));
  }
  addDriftPressure(driftState, Math.abs(emotionState.vector - emotionState.baseline), 0);
  emotionState.baseline += getDriftOffset(driftState) * 0.01;
  dailyRebound(driftState, 0);
  const awareness = checkAwareness(driftState);
  if (awareness.aware) logs.push(`[觉察] ${awareness.message}`);



  // D. 负债衰减
  Object.assign(guiltState, dailyDecay(guiltState));
  const resentment = resentmentEffect(guiltState);

  // E. 消息门（与流式路径共用 buildGateContext）
  const gateContext = buildGateContext(state, userInput, now);
  const gate = decideGateForTurn(state, gateContext, opts);

  if (gate.type === "delay") {
    logs.push(`[消息门] 延迟 ${Math.round(gate.resumeAfterMs / 1000)}s: ${gate.reason}`);
    if (!opts.skipUserPersist) addMessage(session, "user", userInput);
    state.relationshipState = touchInteraction(state.relationshipState, now);
    persistRuntimeState(state);
    return { reply: "", logs, deferred: { delayMs: gate.resumeAfterMs } };
  }
  if (gate.type === "silence") {
    logs.push(`[消息门] 沉默: ${gate.reason}`);
    if (gate.silenceType === "guilt_driven") {
      Object.assign(guiltState, incurGuilt(guiltState, 0.05, "因沉默逃避而加重负债"));
    }
    if (!opts.skipUserPersist) addMessage(session, "user", userInput);
    state.consecutiveSilences += 1;
    state.relationshipState = touchInteraction(state.relationshipState, now);
    persistRuntimeState(state);
    return { reply: "", logs, silenced: true };
  }

  // P2-b+P2-1: 自我叙事弧线
  const diaryReaction = await flipThroughDiary();
  const { arc: narrArc, logs: narrLogs } = advanceNarrativeArc({
    arc: state.narrativeArc,
    drift: driftState,
    recentMemories: [],
    attachmentStyle: persona.emotions.attachmentStyle,
    diaryReaction: diaryReaction ?? undefined,
  });
  state.narrativeArc = narrArc;
  for (const l of narrLogs) logs.push(l);

  let narrativeInject = "";
  if (shouldInjectNarrative(state.narrativeArc) && gate.type === "reply" && Math.random() < 0.15) {
    const st = state.narrativeArc.stage;
    narrativeInject = "\n\n## 内心觉察\n你隐隐约约感觉到自己有些变化(" + st + ")。若自然可顺带提起，不必硬说。";
    state.narrativeArc = markNarrativeExpressed(state.narrativeArc);
    logs.push("[叙事] 弧线注入 prompt");
  }

  // F. 保存用户消息（延迟/沉默已提前返回；补回复模式跳过，避免重复）
  if (!opts.skipUserPersist) addMessage(session, "user", userInput);

  // G. 纠正层
  const correction = applyCorrections(persona.name, userInput);
  if (correction.corrected) {
    logs.push(`[纠正] 应用已有纠正记录`);
  }

  // H. T2 记忆检索
  const memories = retrieveRelevantMemories(userInput);
  const ragContext = buildRagContext(memories);

  // I. 社交分寸
  const exposure = exposureRatio(socialTact, persona.relationship.closeness);

  // J. L1 弹性裁决
  const impulseIntensity = calculateImpulseIntensity(emotionState, persona.relationship.closeness);
  if (impulseIntensity > 0.3) {
    // 用当前原始状态计算阈值（与 buildPrompt 内的 EMA 平滑阈值共享 computeThreshold）
    const rawState: InnerState = {
      exposure: exposure,
      guilt: guiltState.guilt,
      emotion: emotionState.vector,
      hour: now.getHours(),
      mode: "neutral",
      closeness: persona.relationship.closeness,
    };
    const l1Threshold = computeThreshold(persona.emotions.attachmentStyle, rawState);
    const ruling = checkRuleBreach(state.chainRules, impulseIntensity, l1Threshold);
    if (ruling.phase === "rule_broken") {
      Object.assign(guiltState, incurGuilt(guiltState, ruling.guiltProduced, "规则突破"));
    }
    if (ruling.phase === "internal_struggle") {
      logs.push(`[内耗] ${ruling.reason}`);
    }
  }

  // K. 破例检查
  const exceptionThreshold = calculateExceptionThreshold(
    0.6, persona.relationship.closeness, Math.abs(emotionState.vector), impulseIntensity
  );
  const isExceptional = isException(impulseIntensity, 0.6, exceptionThreshold);

  // 中断恢复：上一轮发送被用户新消息打断 → 注入提示，优先回新消息
  let interruptedNote = "";
  if (state.interrupted) {
    interruptedNote = buildInterruptSignal(session, emotionState.vector, now.getHours());
    state.interrupted = false;
  }

  // L. V2: Prompt 构建 — 内心状态 EMA 平滑 + 模式条件化汇编
  session.t3.emotionVector = emotionState.vector;

  // EMA 平滑内心状态（α=0.3，防止单轮跳变）
  const ema = (prev: number, curr: number) => prev * 0.7 + curr * 0.3;

  const rawExposure = exposureRatio(socialTact, persona.relationship.closeness);
  const smoothedExposure = state.prevInnerState
    ? ema(state.prevInnerState.exposure, rawExposure)
    : rawExposure;
  const smoothedGuilt = state.prevInnerState
    ? ema(state.prevInnerState.guilt, guiltState.guilt)
    : guiltState.guilt;

  // 内心模式随状态变化
  let innerMode: InnerState["mode"] = "neutral";
  if (isExceptional) {
    innerMode = "guilty";
  } else if (smoothedGuilt > 0.3) {
    innerMode = "avoidant";
  } else if (smoothedExposure < 0.3) {
    innerMode = "distant";
  } else if (smoothedExposure > 0.6 && persona.relationship.closeness >= 5) {
    innerMode = "close";
  }

  const currentInner: InnerState = {
    exposure: smoothedExposure,
    guilt: smoothedGuilt,
    emotion: emotionState.vector,
    hour: now.getHours(),
    mode: innerMode,
    closeness: persona.relationship.closeness,
  };

  // 最小驻留：模式切换后至少维持 3 轮才允许再次切换
  // （通过比较 prev + current mode 决定是否允许跳变）
  // 简化实现：与 prev 不同时，若不是"例外"则维持

  state.prevInnerState = { ...currentInner };
  state.innerState = currentInner;

  // 时间 + 天气 → 结构化标签注入（~15 tokens），非叙事段落
  const timeCtx = perceiveTime(persona.world);
  const momentTag = buildMomentTag(timeCtx, weatherPerception.raw);

  // P1-2: 动态风格参考 — 从她自己的记忆里找"类似状态下如何表达"
  const styleRefs = retrieveStyleReference({
    emotionVector: emotionState.vector,
    guilt: guiltState.guilt,
    mode: innerMode,
    userInput,
  });
  const styleContext = buildStyleContext(styleRefs);
  if (styleContext) {
    logs.push(`[风格] ${styleRefs.length} 条参考`);
  }

  // V2: 使用 PromptBuilder 组装完整 system prompt
  const systemPrompt = buildPrompt({
    persona,
    config,
    rules: state.chainRules,
    scripts: state.behavioralScripts,
    state: currentInner,
    impulseIntensity,
    corrections: state.corrections,
    tags: config.tags,
    userText: userInput,
    herViewOfYou: state.herViewOfYou ?? undefined,
  });

  // 热点感知：每 1-2 小时刷新一次她在网上看到的内容
  let trendingContext = "";
  const nowTs = Date.now();
  if (nowTs - state.lastTrendingInject > 60 * 60 * 1000 + Math.random() * 60 * 60 * 1000) {
    const topics = getTrendingTopics();
    const careerKw = persona.identity.lifeStory.career?.split(/[,，、\s]+/) ?? [];
    const matched = matchTrendingTopics(topics, careerKw, []);
    trendingContext = buildTrendingContext(matched);
    if (trendingContext) {
      state.lastTrendingInject = nowTs;
      logs.push(`[热点] 注入 ${matched.length} 条`);
    }
  }

  // 结构化标签 + 风格参考 + RAG + 热点作为额外上下文
  const fullSystem = systemPrompt + narrationContext(styleContext, trendingContext, interruptedNote, narrativeInject) + `\n${momentTag}`;
  const messages = buildChatMessages(session, fullSystem);

  // M. AI 回复（短期上下文 + 长期 RAG 上下文，均通过 ChatOptions 注入）
  const shortTermContext = buildShortTermContext(session);
  const complexity = classifyComplexity(userInput);
  if (complexity !== "normal") logs.push(`[路由] ${complexity}(${userInput.length}字)`);
  const rawReply = await chat(messages, persona, { ragContext, shortTermContext, complexity });

  // N. 表达渲染
  const rendered = renderExpression(rawReply, {
    emojiStyle: "动物系",
    stickerFrequency: 0.3,
    isChatty: persona.speaking.catchphrases.some(p => p.includes("跟你说")),
    stickerMode: state.stickerMode,
    tone: {
      style: persona.speaking.toneStyle || "natural",
      frequency: persona.speaking.toneFrequency ?? 0.5,
    },
  }, {
    impulseIntensity,
    hasInternalStruggle: gate.type === "reply" && gate.delayMs > 5000,
    emotionVector: emotionState.vector,
    guilt: guiltState.guilt,
    busyLevel: getBusyLevel(now.getHours(), persona.world.dailyRhythm as Array<{ time: string; activity: string }>),
  });

  let reply: string;
  if (rendered.mode === "burst" && rendered.burstParts && rendered.burstParts.length > 1) {
    // 用 rendered.text（含 kaomoji）替换掉原始 rawReply
    // 保持 burst 结构，但最后一条带上 kaomoji
    const parts = [...rendered.burstParts.filter(Boolean)];
    if (rendered.kaomoji && parts.length > 0) {
      parts[parts.length - 1] = parts[parts.length - 1].trimEnd() + " " + rendered.kaomoji;
    }
    reply = parts.join("\n");
  } else {
    reply = rendered.text; // 含 kaomoji
  }

  // O. 保存 + 记忆
  addMessage(session, "assistant", rawReply);
  storeConversationEpisode(userInput, rawReply, session.t3.emotionVector);
  maybeCompressToT3();
  maybeGenerateJournal();
  // P1-c: T1 人格快照写入
  insertT1Snapshot({
    content: `用户: ${userInput.slice(0, 60)} | Karen: ${rawReply.slice(0, 60)}`,
    emotionVector: emotionState.vector,
    closeness: persona.relationship.closeness,
    guilt: guiltState.guilt,
    summary: logs.filter(l => l.startsWith("[")).join("; ").slice(0, 200),
  });
  session.t3.currentTopic = userInput.slice(0, 40);

  // P1-1: 内心独白日志（fire-and-forget，不阻塞当前回复）
  triggerMonologue(state, userInput, rawReply);

  // P. 因果链回响
  for (const chain of causalChains) {
    addUserTrace(chain, userInput);
    if (Math.random() < 0.1) {
      const trace = recallUserTrace(chain);
      if (trace) logs.push(`[因果链] 回响: ${trace}`);
    }
  }

  // Q. 纠正记录
  if (userInput.includes("你不会这样说") || userInput.includes("你应该是")) {
    addCorrection(persona.name, userInput.slice(0, 50), rawReply.slice(0, 50), userInput);
    logs.push("[纠正] 已记录用户反馈");
  }

  // R. herViewOfYou 触发检测 + 异步更新（不阻塞当前回复）
  const prevNarrativeStage = state.lastNarrativeStage;
  const currNarrativeStage = state.narrativeArc.stage;
  if (prevNarrativeStage !== currNarrativeStage) {
    state.lastNarrativeStage = currNarrativeStage;
  }
  if (
    !state.herViewGenerating &&
    shouldUpdateView({
      currentCloseness: persona.relationship.closeness,
      lastViewUpdateCloseness: state.lastViewUpdateCloseness,
      lastViewUpdateAt: state.lastViewUpdateAt,
      narrativeStage: currNarrativeStage,
      previousNarrativeStage: prevNarrativeStage,
    })
  ) {
    state.herViewGenerating = true;
    const captureCloseness = persona.relationship.closeness;
    const captureView = state.herViewOfYou;
    // 提取最近记忆（从 T2 取最近 5 条）
    const recentEpisodes = (() => {
      try {
        const { getAllEpisodes } = require("../data/vector.js");
        return (getAllEpisodes(5) as Array<{ content: string }>).map(e => e.content);
      } catch { return []; }
    })();

    generateHerView({
      persona,
      currentCloseness: captureCloseness,
      previousView: captureView,
      recentMemories: recentEpisodes,
    }).then((newView) => {
      if (newView) {
        state.previousViewOfYou = captureView;
        state.herViewOfYou = newView;
        state.lastViewUpdateCloseness = captureCloseness;
        state.lastViewUpdateAt = Date.now();
        console.log(`[herView] 更新: "${newView}"`);
      }
      state.herViewGenerating = false;
    }).catch(() => {
      state.herViewGenerating = false;
    });
  }

  // S. P2-c: Unsplash 主动发图（基于她刚说的话 + 情绪 + 视觉人格生成 query）
  let imageUrl: string | undefined;
  let imageCaption: string | undefined;
  try {
    const photo = await trySharePhoto(state, rawReply);
    if (photo) {
      imageUrl = photo.imageUrl;
      imageCaption = photo.caption;
      logs.push(`[Unsplash] 主动分享: ${imageCaption}`);
    }
  } catch (err: unknown) {
    // 发图失败不影响主回复
    logs.push(`[Unsplash] 发图失败: ${err instanceof Error ? err.message : "未知错误"}`);
  }

  state.consecutiveSilences = 0;
  logs.push(...updateRelationshipAfterTurn(state, userInput, rawReply, complexity));
  persistRuntimeState(state);
  return { reply, logs, qqFace: rendered.qqFace, imageUrl, imageCaption };
}

// ── P1: 主动消息（生活流触发 + 沉默保温兜底）────

interface ImpulseCandidate {
  source: string;       // 触发源名称（日志用）
  description: string;  // 冲动描述（注入 prompt）
  intensity: number;    // 0-1
  priority: number;     // 越高越优先触发
}

// ── P1: 中断信号 ─────────────────────────────

/**
 * 生成中断状态信号（不是指令——不给 LLM 下命令，只给情境让她自己反应）。
 * 信号放在 system prompt 末尾，让她知道"刚才发生了一件事"。
 */
function buildInterruptSignal(
  session: ConversationSession,
  emotionVec: number,
  hour: number,
): string {
  const msgs = session.messages;
  // 她最后一条消息（被打断时正在说的）
  const lastAssistant = [...msgs].reverse().find(m => m.role === "assistant");
  const lastAssistantContent = lastAssistant?.content?.slice(0, 30) ?? "";

  // 对方最后两条消息的间隔（判断是否急迫）
  const userMsgs = msgs.filter(m => m.role === "user");
  const isQuickFollow =
    userMsgs.length >= 2 &&
    userMsgs[userMsgs.length - 1].timestamp - userMsgs[userMsgs.length - 2].timestamp < 60_000;

  const attachmentStyle = ""; // 由 persona 决定，这里用通用信号

  const parts: string[] = [];
  parts.push("[对方发了新消息");

  if (isQuickFollow) {
    parts.push("，连发了几条，好像很急");
  }

  if (lastAssistantContent && emotionVec > 0.3) {
    parts.push(`。你刚才正说到"${lastAssistantContent}"，还没说完`);
  } else if (lastAssistantContent && emotionVec < -0.3) {
    parts.push(`。你刚才正说到"${lastAssistantContent}"`);
  }

  if (hour >= 23 || hour < 7) {
    parts.push("。这么晚了还没睡");
  }

  parts.push("]");

  return `\n${parts.join("")}`;
}

// ── P1: 流式响应 ─────────────────────────────

export interface StreamFragment {
  text: string;
  /** QQ 表情 CQ 码（流结束后单独发送，仅最后一条 fragment 可能有值） */
  qqFace?: string;
  /** 消息门判定「晚点回」：调用方应在 delayMs 后以 {bypassGate:true, skipUserPersist:true} 重新调用 */
  deferred?: { delayMs: number };
}

/**
 * 流式版本的消息处理。
 * 与非流式 processMessage 共享相同的 prompt 构建逻辑，
 * 但使用 LLM streaming 逐 fragment 产出，模拟"边想边打"。
 */
export async function* processMessageStream(
  state: ConversationState,
  userInput: string,
  opts: ProcessOptions = {},
): AsyncGenerator<StreamFragment> {
  const { persona, config, emotionState, guiltState, socialTact, session, silenceState, weatherPerception } = state;

  // 状态维护（与非流式保持一致：天气刷新/情绪恢复/沉默追踪）
  await refreshWeatherIfStale(state);
  Object.assign(emotionState, naturalRecover(emotionState));
  Object.assign(guiltState, dailyDecay(guiltState));
  if (!state.weatherApplied && Math.abs(weatherPerception.moodOffset) > 0.01) {
    Object.assign(emotionState, adjustEmotion(emotionState, weatherPerception.moodOffset, "天气感知"));
    state.weatherApplied = true;
  }
  Object.assign(silenceState, touchUserActivity(silenceState, userInput));

  const now = new Date();
  const hour = now.getHours();

  // 消息门（与 CLI/群聊共用同一上下文；修复此前写死 messageCountToday=0 的问题）
  const gateContext = buildGateContext(state, userInput, now);
  const gate = decideGateForTurn(state, gateContext, opts);

  if (gate.type === "delay") {
    if (!opts.skipUserPersist) addMessage(session, "user", userInput);
    state.relationshipState = touchInteraction(state.relationshipState, now);
    persistRuntimeState(state);
    yield { text: "", deferred: { delayMs: gate.resumeAfterMs } };
    return;
  }
  if (gate.type === "silence") {
    if (!opts.skipUserPersist) addMessage(session, "user", userInput);
    state.consecutiveSilences += 1;
    state.relationshipState = touchInteraction(state.relationshipState, now);
    persistRuntimeState(state);
    return;
  }

  if (!opts.skipUserPersist) addMessage(session, "user", userInput);

  // 中断恢复
  let interruptedNote = "";
  if (state.interrupted) {
    interruptedNote = buildInterruptSignal(session, emotionState.vector, hour);
    state.interrupted = false;
  }

  // Prompt 构建（与非流式共享相同逻辑）
  const exposure = exposureRatio(socialTact, persona.relationship.closeness);
  const impulseIntensity = calculateImpulseIntensity(emotionState, persona.relationship.closeness);
  const currentInner: InnerState = {
    exposure,
    guilt: guiltState.guilt,
    emotion: emotionState.vector,
    hour,
    mode: "neutral",
    closeness: persona.relationship.closeness,
  };

  const systemPrompt = buildPrompt({
    persona, config,
    rules: state.chainRules,
    scripts: state.behavioralScripts,
    state: currentInner,
    impulseIntensity,
    corrections: state.corrections,
    tags: config.tags,
    userText: userInput,
    herViewOfYou: state.herViewOfYou ?? undefined,
  });

  const timeCtx = perceiveTime(persona.world);
  const momentTag = buildMomentTag(timeCtx, weatherPerception.raw);
  const memories = retrieveRelevantMemories(userInput);
  const ragContext = buildRagContext(memories);
  const shortTermContext = buildShortTermContext(session);
  const fullSystem = systemPrompt + interruptedNote + `\n${momentTag}`;

  // 构建消息列表
  const messages = buildChatMessages(session, fullSystem);

  // 流式 LLM 调用
  let fullReply = "";
  let sentReply = "";
  let buffer = "";
  const BREAKS = /[\n。！？…]/;
  const SOFT_BREAKS = /[，,、]/;
  let yieldedAny = false;

  const complexity = classifyComplexity(userInput);

  try {
    try {
      const stream = chatStream(messages, persona, { ragContext, shortTermContext, complexity });

      for await (const token of stream) {
        fullReply += token;
        buffer += token;

        // 遇到自然断点 → 立即发送
        const shouldSend =
          BREAKS.test(token) ||
          (SOFT_BREAKS.test(token) && buffer.length > 12);

        if (shouldSend) {
          const frag = buffer.trim();
          if (frag) {
            sentReply += frag;
            yieldedAny = true;
            yield { text: frag };
          }
          buffer = "";
        }
      }

      // 发送剩余内容
      if (buffer.trim()) {
        const frag = buffer.trim();
        sentReply += frag;
        yieldedAny = true;
        yield { text: frag };
      }
    } catch (err) {
      // 流式失败：仅在尚未发送任何内容时降级为非流式，避免「半句 + 完整」重复发送
      if (!yieldedAny) {
        console.log("[流式] 失败，回落到非流式");
        fullReply = await chat(messages, persona, { ragContext, shortTermContext });
        const lines = fullReply.split("\n").filter(Boolean);
        for (const line of lines) {
          const frag = line.trim();
          if (!frag) continue;
          sentReply += frag;
          yieldedAny = true;
          yield { text: frag };
        }
      } else {
        console.log(
          `[流式] 已发送部分内容后中断，跳过降级: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    // 后处理：QQ 表情
    const rendered = renderExpression(fullReply, {
      emojiStyle: "动物系", stickerFrequency: 0.3,
      isChatty: persona.speaking.catchphrases.some(p => p.includes("跟你说")),
      stickerMode: state.stickerMode,
      tone: {
        style: persona.speaking.toneStyle || "natural",
        frequency: persona.speaking.toneFrequency ?? 0.5,
      },
    }, {
      impulseIntensity,
      hasInternalStruggle: false,
      emotionVector: emotionState.vector,
      guilt: guiltState.guilt,
      busyLevel: getBusyLevel(hour, persona.world.dailyRhythm as Array<{ time: string; activity: string }>),
    });

    if (rendered.qqFace) {
      yield { text: "", qqFace: rendered.qqFace };
    }
  } finally {
    // 无论正常结束还是被消费方中断（break），都持久化「实际已发送」的内容，避免记忆丢失
    const persisted = sentReply || fullReply;
    if (persisted) {
      addMessage(session, "assistant", persisted);
      storeConversationEpisode(userInput, persisted, emotionState.vector);
      maybeCompressToT3();
      maybeGenerateJournal();
      insertT1Snapshot({
        content: `用户: ${userInput.slice(0, 60)} | Karen: ${persisted.slice(0, 60)}`,
        emotionVector: emotionState.vector,
        closeness: persona.relationship.closeness,
        guilt: guiltState.guilt,
        summary: "[stream]",
      });
      triggerMonologue(state, userInput, persisted);
      state.consecutiveSilences = 0;
      for (const line of updateRelationshipAfterTurn(state, userInput, persisted, complexity)) {
        console.log(line);
      }
      persistRuntimeState(state);
    }
  }
}

/**
 * 生活流心跳：检查她此刻的生活状态，生成分享冲动。
 * 触发源优先级：因果链 > 天气 > 情绪 > 时间节点。
 * 沉默保温仅在阶段 4（>72h）作为兜底。
 * 不做深夜禁言——消息门自会判断延迟或发送。
 */
export async function processProactive(
  state: ConversationState,
): Promise<{ reply: string; logs: string[]; qqFace?: string } | null> {
  const logs: string[] = [];
  const { persona, config, emotionState, guiltState, socialTact, silenceState, session,
    causalChains, weatherPerception } = state;

  // 状态维护
  await refreshWeatherIfStale(state);
  Object.assign(emotionState, naturalRecover(emotionState));
  Object.assign(guiltState, dailyDecay(guiltState));

  const now = new Date();
  const hour = now.getHours();

  // 最小间隔：两次心跳之间至少 8 分钟（防止并发重复）
  if (state.lastHeartbeatAt && now.getTime() - state.lastHeartbeatAt < 8 * 60 * 1000) {
    return null;
  }
  state.lastHeartbeatAt = now.getTime();
  persistRuntimeState(state);

  // 主动消息治理：单日上限 + 两次主动消息最小间隔（避免刷屏/打扰）
  const dayKey = `${now.getFullYear()}-${now.getMonth() + 1}-${now.getDate()}`;
  if (state.proactiveDay !== dayKey) {
    state.proactiveDay = dayKey;
    state.proactiveCountToday = 0;
  }
  const MAX_PROACTIVE_PER_DAY = 4;
  const MIN_PROACTIVE_GAP_MS = 30 * 60 * 1000;
  if (state.proactiveCountToday >= MAX_PROACTIVE_PER_DAY) return null;
  if (state.lastProactiveSentAt && now.getTime() - state.lastProactiveSentAt < MIN_PROACTIVE_GAP_MS) {
    return null;
  }

  // ── 1. 收集触发候选 ──────────────────────────

  const candidates: ImpulseCandidate[] = [];

  // 1a. 因果链闯入（她生活中正在发生的事有进展）
  const intrusion = generateIntrusion(causalChains);
  if (intrusion) {
    candidates.push({
      source: "因果链",
      description: `你生活中发生了一件事：${intrusion.description}。你想到了对方，觉得可以跟他说。`,
      intensity: 0.3 + intrusion.intensity * 0.5,
      priority: 9,
    });
  }

  // 1b. 天气变化（下雨了/放晴了/下雪了）
  const cond = weatherPerception.raw.condition;
  if (cond !== state.lastSharedWeather) {
    const isNotable = ["雨", "雪", "雷", "晴"].some(w => cond.includes(w));
    if (isNotable && weatherPerception.socialInterpretation) {
      candidates.push({
        source: "天气",
        description: `外面${weatherPerception.raw.description}了。${weatherPerception.socialInterpretation}`,
        intensity: 0.35,
        priority: 7,
      });
    }
  }

  // 1c. 情绪波动（开心想分享 / 低落想找人）
  const emotionAbs = Math.abs(emotionState.vector);
  if (emotionAbs > 0.35) {
    const dir = emotionState.vector > 0 ? "开心" : "有点闷";
    candidates.push({
      source: "情绪",
      description: `你此刻心情${dir}。你想到了一个人可以说说话。`,
      intensity: emotionAbs * 0.6,
      priority: 5,
    });
  }

  // 1d. 时间节点（dailyRhythm 的间隙时刻 — 午休、傍晚、关店后）
  const timeCtx = perceiveTime(persona.world);
  const currentActivity = timeCtx.awareness;
  const isBreakMoment =
    currentActivity.includes("休息") || currentActivity.includes("下班") ||
    currentActivity.includes("吃完") || currentActivity.includes("发呆") ||
    currentActivity.includes("空闲") || currentActivity.includes("在家") ||
    (hour >= 21 && hour < 23); // 睡前刷手机时段
  if (isBreakMoment && persona.relationship.closeness >= 3) {
    candidates.push({
      source: "时间",
      description: `你现在${currentActivity}。你想起来可以给对方发条消息。`,
      intensity: 0.25,
      priority: 4,
    });
  }

  // ── 2. 沉默保温（仅阶段 4: >72h，兜底）─────

  const phase = getSilencePhase(silenceState);
  if (phase >= 4 && !silenceState.restartSent) {
    candidates.push({
      source: "沉默保温",
      description: "对方好几天没消息了。你有点在意，决定主动问问。",
      intensity: 0.5,
      priority: 8, // 高但不是最高——因果链比她更自然
    });
  }

  // ── 3. 选择触发 ──────────────────────────────

  if (candidates.length === 0) return null;

  // 按优先级排序，取最高的
  candidates.sort((a, b) => b.priority - a.priority);
  const picked = candidates[0];

  // 触发概率 = priority/10（高优先级更可能触发）
  const chance = Math.min(0.75, picked.priority / 10);
  if (Math.random() > chance) return null;

  logs.push(`[主动] 触发源=${picked.source} 强度=${picked.intensity.toFixed(2)}`);

  // ── 4. 消息门（处理深夜等场景）─────────────

  const gate = decideGate({
    personaId: persona.name,
    currentHour: hour,
    isWorkHours: hour >= 8 && hour < 17,
    emotionVector: emotionState.vector,
    guilt: guiltState.guilt,
    messageType: "text",
    isAvoidedTopic: false,
    isNaturalEnding: false,
    messageCountToday: 0,
    isRapidFollowUp: false,
    isQuickChat: false,
    closeness: persona.relationship.closeness,
    dailyRhythm: persona.world.dailyRhythm as Array<{ time: string; activity: string }>,
  });

  if (gate.type === "delay") {
    // 深夜 → 记录内耗痕迹，不发送
    if (hour >= 23 || hour < 7) {
      logs.push(`[主动] 深夜冲动(${picked.source}): 消息门延迟 → "${gate.reason}"`);
      // 深夜冲动被压制 → 异步生成一条 LLM 独白（fire-and-forget）
      generateNightMonologue({
        herName: persona.name,
        userName: config.your_name,
        triggerSource: picked.source,
        triggerDesc: picked.description,
        emotionVector: emotionState.vector,
      }).then((mono) => {
        if (mono) {
          insertEpisode(`[独白] ${mono}`, "internal_monologue", -0.1);
          console.log(`[独白] 深夜冲动已记录: ${mono.slice(0, 60)}...`);
        }
      }).catch(() => { /* 独白失败不影响主流程 */ });
    } else {
      logs.push(`[主动] 门控延迟(${picked.source}): ${gate.reason}`);
    }
    return null;
  }
  if (gate.type !== "reply") {
    logs.push(`[主动] 消息门阻止(${picked.source}): ${gate.reason}`);
    return null;
  }

  // 标记状态
  state.lastSharedWeather = cond;
  if (phase >= 4) silenceState.restartSent = true;

  // ── 5. 生成消息 ──────────────────────────────

  const exposure = exposureRatio(socialTact, persona.relationship.closeness);
  const currentInner: InnerState = {
    exposure,
    guilt: guiltState.guilt,
    emotion: emotionState.vector,
    hour,
    mode: phase >= 4 ? "guilty" : emotionState.vector > 0.3 ? "close" : "neutral",
    closeness: persona.relationship.closeness,
  };
  state.innerState = currentInner;

  const systemPrompt = buildPrompt({
    persona,
    config,
    rules: state.chainRules,
    scripts: state.behavioralScripts,
    state: currentInner,
    impulseIntensity: picked.intensity,
    corrections: state.corrections,
    tags: config.tags,
    userText: picked.description,
    herViewOfYou: state.herViewOfYou ?? undefined,
  });

  // 注入触发上下文：告诉 LLM 她因为什么想到了对方
  const proactiveInject = [
    ``,
    `## 此刻的冲动`,
    `${picked.description}`,
    `自然地发一条消息，从你当下的生活出发。不要用"最近咋样"这种泛泛的开场——你是因为具体的事情才想到他的。`,
  ].join("\n");

  const fullSystem = systemPrompt + proactiveInject;
  const messages = buildChatMessages(session, fullSystem);

  // LLM 调用
  const rawReply = await chat(messages, persona);

  // 表达渲染
  const rendered = renderExpression(rawReply, {
    emojiStyle: "动物系",
    stickerFrequency: 0.3,
    isChatty: persona.speaking.catchphrases.some(p => p.includes("跟你说")),
    stickerMode: state.stickerMode,
    tone: {
      style: persona.speaking.toneStyle || "natural",
      frequency: persona.speaking.toneFrequency ?? 0.5,
    },
  }, {
    impulseIntensity: picked.intensity,
    hasInternalStruggle: picked.source === "情绪" && emotionState.vector < 0,
    emotionVector: emotionState.vector,
    guilt: guiltState.guilt,
    busyLevel: getBusyLevel(hour, persona.world.dailyRhythm as Array<{ time: string; activity: string }>),
  });

  const reply = rendered.mode === "burst" && rendered.burstParts
    ? rendered.burstParts.join("\n")
    : rendered.text;

  // 保存到对话历史
  addMessage(session, "assistant", rawReply);
  session.t3.currentTopic = picked.description;
  state.consecutiveSilences = 0;
  state.lastProactiveSentAt = now.getTime();
  state.proactiveCountToday += 1;
  persistRuntimeState(state);

  logs.push(`[主动] 已发送: "${reply.slice(0, 50)}..."`);
  return { reply, logs, qqFace: rendered.qqFace };
}

// ── 短期上下文构建 ──────────────────────────────

/** 从当前 session 最近消息构建短期上下文（人设无关） */
function buildShortTermContext(
  session: ConversationSession,
  maxMessages: number = 8,
): string {
  const recent = session.messages.slice(-maxMessages);
  if (recent.length === 0) return "";

  let ctx = "\n## 你们刚才在聊的事情\n";
  for (const m of recent) {
    const truncated = m.content.slice(0, 80);
    const label = m.role === "user" ? "对方" : "你";
    ctx += `- ${label}: ${truncated}\n`;
  }
  return ctx;
}

// ── 统计信息 ──────────────────────────────────

export function getStateSummary(state: ConversationState): string[] {
  const { persona, emotionState, guiltState, driftState, causalChains, session } = state;
  const episodes = (() => {
    try {
      const { getAllEpisodes } = require("../data/vector.js");
      return getAllEpisodes();
    } catch { return []; }
  })();

  const userMsgs = session.messages.filter(m => m.role === "user").length;
  const botMsgs = session.messages.filter(m => m.role === "assistant").length;
  const hours = Math.round((Date.now() - session.startedAt) / 3600000 * 10) / 10;
  const active = causalChains.filter(c => c.phase === "active");

  const rel = state.relationshipState;
  const lastMilestone = rel.milestones.length > 0 ? rel.milestones[rel.milestones.length - 1] : null;

  return [
    `消息: ${session.messages.length} (你:${userMsgs} 她:${botMsgs}) 时长:${hours}h`,
    `T2 记忆: ${episodes.length} 条`,
    `情绪: ${describeEmotion(emotionState)} vec=${emotionState.vector.toFixed(2)} arousal=${emotionState.arousal.toFixed(2)}`,
    `负债: g=${guiltState.guilt.toFixed(2)} r=${guiltState.resentment.toFixed(2)}`,
    `基线漂移: 实际=${driftState.actualBaseline.toFixed(2)} 感知=${driftState.perceivedBaseline.toFixed(2)} 压力=${driftState.pressure.toFixed(2)}`,
    `因果链: ${causalChains.length}条 (活跃:${active.length}) ${active.map(c => c.title).join(", ")}`,
    `亲密度: ${rel.closeness.toFixed(2)}/10（${closenessLabel(rel.closeness)}）连续互动 ${rel.interactionStreak} 天${
      lastMilestone ? `；最近里程碑：${lastMilestone.title}` : ""
    }`,
    `关系事件: ${rel.events.length} 条 | 内心阶段: ${state.narrativeArc.stage}`,
    `她眼中的你: ${state.herViewOfYou ?? "（还没有形成明确看法）"}`,
  ];
}

// ── P1-1: 内心独白日志 ──────────────────────────

/**
 * 触发内心独白生成（fire-and-forget）。
 * 不阻塞当前回复——让她在"事后"反思。
 */
function triggerMonologue(
  state: ConversationState,
  userInput: string,
  herReply: string,
): void {
  const { persona, emotionState, guiltState, session } = state;

  const recent = session.messages.slice(-6);
  const recentContext = recent
    .map((m) => `${m.role === "user" ? "对方" : persona.name}: ${m.content.slice(0, 80)}`)
    .join("\n");

  generateMonologue({
    herName: persona.name,
    userInput,
    herReply,
    emotionVector: emotionState.vector,
    guilt: guiltState.guilt,
    recentContext,
  })
    .then((result) => {
      if (!result.text) return;

      storeMonologue(result, persona.name);

      if (result.selfAware) {
        const sign = result.driftDirection === "warmer" ? 1 : -1;
        import("../evolution/baseline-drift.js").then(({ addDriftPressure }) => {
          addDriftPressure(state.driftState, sign * 0.02, 0);
        });
      }
    })
    .catch((err) => {
      console.log(`[独白] 异步生成失败: ${err instanceof Error ? err.message : err}`);
    });
}

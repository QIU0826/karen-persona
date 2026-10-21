/** 域三：响应管线编排器 — 供 CLI 和 QQ/微信桥接共用 */
import { chat, chatStream } from "../ai/chat.js";
import { classifyComplexity } from "../ai/router.js";
import { addMessage, buildChatMessages, loadSession, type ConversationSession } from "../data/history.js";
import { decideGate, getBusyLevel, type GateAction, type GateContext } from "../impulse/message-gate.js";
import {
  insertT1Snapshot,
  insertEpisode,
  setCurrentPersona,
  backfillEpisodeVectors,
  getVectorDb,
} from "../data/vector.js";
import {
  addAnchor,
  inferAnchorKind,
  listAnchors,
  formatWeeklyInjection,
  listRecentDigests,
  listRecentRollups,
  scoreSalience,
  summarizeAnchor,
  touchAnchors,
} from "../data/memory-v2.js";
import { buildMemoryContext } from "./memory-context.js";
import { computeDueJobs, localDayKey, runDailyDigest, runWeeklyRollup, shiftDayKey } from "../schedule/jobs.js";
import { runAnchorRefine } from "../schedule/anchor-refine.js";
import { refineAnchorsWithLLM } from "../schedule/anchor-llm.js";
import { deserializePlan, generateDailyPlanWithLLM, serializePlan } from "../schedule/initiative-llm.js";
import {
  buildDailyPlanPrompt,
  buildLifeSignals,
  calibratedDailyCap,
  markInitiativeUsed,
  parseDailyPlan,
  pickDueInitiative,
  type DailyInitiativePlan,
} from "../impulse/initiative-plan.js";
import { buildInitiativeReplyHint } from "../impulse/initiative-reply.js";
import {
  getInitiativePlan,
  markInitiativeReplied,
  initiativeSentCount,
  recentInitiativeReplyCount,
  recordInitiativeSent,
  saveInitiativePlan,
} from "../data/memory-v2.js";
import { buildGetToKnowNote, pickGetToKnowAsk } from "../persona/get-to-know.js";
import {
  applyReflectionSignal,
  buildReflectionInjection,
  buildReflectionStatement,
  createReflectionState,
  looksLikeUserPointingOut,
  REFLECTION_PHASE_LABELS,
  shouldApplyChange,
  type ReflectionSignalKind,
  type ReflectionState,
} from "../evolution/reflection.js";
import {
  applyDimEvent,
  behaviorNote,
  createRelationshipDims,
  derivePhase,
  describeDims,
  PHASE_LABELS,
  type DimEventKind,
} from "../persona/relationship-dims.js";
import { listAskedTopics, markTopicAsked } from "../data/memory-v2.js";
import { summarizeDayWithLLM } from "../schedule/digest-llm.js";
import { generateEmbedding } from "../data/embedding.js";
import { buildRagContext, storeConversationEpisode } from "../data/retriever.js";
import { retrieveWithLlmBoost } from "../data/retrieval-boost.js";
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
  checkRuleBreach,
  type ChainRule,
  type BehavioralScript,
  type CorrectionOverlay,
  type InnerState,
} from "../persona/prompt-builder.js";
import {
  buildAvoidRepeatNote,
  DEFAULT_LONG_RANGE_REPLY_COUNT,
  detectRepetition,
  extractRecentReplies,
  findExactRepeatInHistory,
} from "../persona/anti-repetition.js";
import { mockWeather, fetchWeather, perceiveWeather, clearWeatherCache, type WeatherPerception } from "../world/weather.js";
import { getTrendingTopics, matchTrendingTopics, buildTrendingContext } from "../world/trending-fetcher.js";
import { deriveStance } from "../world/stance.js";
import { perceiveTime, buildMomentTag } from "../world/time-awareness.js";
import { renderExpression } from "../impulse/renderer.js";
import { trySharePhoto } from "../impulse/unsplash-trigger.js";
import {
  buildMediaRequestNote,
  detectMediaRequest,
  detectPhotoSceneTags,
} from "../impulse/media-request.js";
import {
  hasMeetingGrounding,
  isAskingHowWeMet,
  pickMeetingFallback,
  stripFabricatedMeeting,
} from "../persona/meeting-guard.js";
import { decideTalkMove, isTroubleTalk, type TalkMove } from "../persona/talk-moves.js";
import {
  ALL_CHANNELS_OFF,
  CHANNEL_LABEL,
  DEFAULT_PROACTIVE_CHANNELS,
  buildChannelNote,
  decideProactive,
  formatProactiveDecision,
  type ProactiveChannel,
  type ProactiveChannels,
  type ProactiveDecision,
} from "../impulse/proactive-plan.js";
import { resolveOwnerScope, OWNER_CLI } from "../data/owner.js";
import {
  extractUserFactsAsync,
  getUserFactsContext,
  buildFactConflictNote,
  getFactsNeedingConfirmation,
  listUserFacts,
  markFactsChallenged,
} from "../data/user-facts.js";
import { getT1ArcContext } from "../data/t1-injection.js";
import { previewText } from "../obs/safe-text.js";
import { stripMemoryDeflection } from "../persona/reply-guard.js";
import {
  detectCrisis,
  crisisSafetyNote,
  crisisResourcesText,
  type CrisisLevel,
} from "../safety/crisis.js";
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
import { checkBoundary, isApology } from "../persona/boundary.js";

// ── 会话状态 ──────────────────────────────────

/** 最近一次消息门裁决（/why 用；只含动作与原因，不含消息正文） */
export interface GateRecord {
  action: "reply" | "delay" | "silence";
  reason: string;
  at: number;
  /** 延迟回复时预计多久后补回（毫秒） */
  remainingMs?: number;
}

/** 记录本轮消息门裁决，供 /why 解释（不落消息正文） */
function recordGateDecision(
  state: ConversationState,
  gate: GateAction,
  opts: ProcessOptions,
  crisis: CrisisLevel | null = null,
): void {
  let action: GateRecord["action"] = gate.type;
  let reason: string;
  if (crisis) {
    reason = "安全优先：检测到危机信号，强制回复并附加求助资源";
  } else if (opts.bypassGate) {
    reason = "强制回复（延迟补发/连续沉默兜底）";
  } else if (state.consecutiveSilences >= 3) {
    reason = "连续沉默兜底：强制回复一次，避免一直不出现";
  } else if (gate.type === "reply") {
    reason = "正常回复";
  } else {
    reason = gate.reason;
  }
  state.lastGate = {
    action,
    reason,
    at: Date.now(),
    ...(gate.type === "delay" ? { remainingMs: gate.resumeAfterMs } : {}),
  };
}

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
  /** v0.8：反思循环（觉察→否认→承认→整合） */
  reflectionState: ReflectionState;
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
  /** M1-gov: 最近一次消息门裁决（供 /why 解释；持久化） */
  lastGate: GateRecord | null;
  /** M1-gov: 主动消息是否暂停（/pause），持久化 */
  proactivePaused: boolean;
  /** 多用户隔离：owner（qq:<id> / cli:local） */
  owner: string;
  /** 多用户隔离：会话/状态文件后缀（"" = 历史/主用户） */
  storageKey: string;
  /** 多用户隔离：T2/T1 记忆使用的 persona_id（隔离用户带 @slug） */
  storagePersona: string;
}

export interface PipelineResult {
  reply: string;
  logs: string[];
  /** P1-d: QQ 表情 CQ 码（附加消息，在 reply 之后发送） */
  qqFace?: string;
  /** P2-c: 主动发图 URL（Unsplash）或本地图库路径 */
  imageUrl?: string;
  /** P2-c: 本地兜底图片绝对路径（无 Unsplash Key 时） */
  imageFile?: string;
  /** P2-c: 配图文字 */
  imageCaption?: string;
  /** 消息门判定「晚点回」：调用方应在 delayMs 后以 {bypassGate:true, skipUserPersist:true} 重新调用 */
  deferred?: { delayMs: number };
  /** 消息门判定「这一轮不回」（沉默） */
  silenced?: boolean;
  /** 合规：检测到危机信号时附带的专业求助资源（由程序追加，不依赖模型生成） */
  safetyMessage?: string;
}

/** processMessage / processMessageStream 的可选行为开关 */
export interface ProcessOptions {
  /** 跳过消息门，强制回复（用于延迟补回复/连续沉默兜底） */
  bypassGate?: boolean;
  /** 跳过用户消息落库（延迟补回复时原消息已落库） */
  skipUserPersist?: boolean;
  /** 跳过主动发图（群聊默认不发生活照：省一次图片决策/资源读写） */
  skipPhoto?: boolean;
}

// ── 初始化 ────────────────────────────────────

export async function initConversation(
  persona: Persona,
  config: AppConfig,
  owner: string = OWNER_CLI,
): Promise<ConversationState> {
  // 多用户隔离：owner 决定会话/状态文件后缀与 T2/T1 的 persona_id
  const scope = resolveOwnerScope(config.persona, owner, config.allowed_users);

  // 设置当前人设 ID（隔离用户用带 owner 后缀的存储 id），确保 T1/T2 记忆按人+用户隔离
  setCurrentPersona(scope.storagePersona);

  // V2: 从 persona 加载链式规则和行为脚本
  const chainRules = persona.chainRules ?? defaultChainRules();
  const behavioralScripts = persona.behavioralScripts ?? defaultBehavioralScripts();

  // M1-1: 先加载持久化的人格运行时状态（情绪/负债/漂移/关系/因果链/herView…）
  const persisted = loadPersonaState(
    persona.name,
    persona.relationship.closeness,
    scope.storageKey,
  );

  const emotionState = persisted?.emotion ?? createEmotionState();
  const guiltState = persisted?.guilt ?? createGuiltState();
  const socialTact = createSocialTact(persona.emotions.attachmentStyle);
  const driftState = persisted?.drift ?? createDriftState(emotionState.baseline);
  const reflectionState = persisted?.reflection ?? createReflectionState();
  const causalChains: CausalChain[] =
    persisted?.causalChains && persisted.causalChains.length > 0
      ? persisted.causalChains
      : defaultCausalChains();
  const silenceState = persisted?.silence ?? createSilenceState();
  const narrativeArc = persisted?.narrativeArc ?? createNarrativeArc();
  const relationshipState = persisted?.relationship ?? createRelationshipState(persona.relationship.closeness);
  // persona.relationship.closeness 是全代码读取的唯一来源：用持久化值覆盖静态人设值
  persona.relationship.closeness = relationshipState.closeness;

  const session = loadSession(persona.name, scope.storageKey);
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
    driftState, reflectionState, causalChains, silenceState, session, personaType, stance,
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
    lastGate: persisted?.lastGate ?? null,
    proactivePaused: persisted?.proactivePaused ?? false,
    owner: scope.owner,
    storageKey: scope.storageKey,
    storagePersona: scope.storagePersona,
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
  const trimmed = userInput.trim();
  // 门控在写入本轮用户消息之前调用（CLI/QQ、流式/非流式一致）。
  // 判断「连续快速跟进」时要把当前这条也算进去，否则刚回完一句紧跟着的第二句
  // 会被当成普通消息去掷工作延迟（2026-10-20 真机复现：18s 内连发仍被延迟 31 分钟）。
  const lastSessionMsg = session.messages[session.messages.length - 1];
  const currentAlreadySaved =
    lastSessionMsg?.role === "user" &&
    lastSessionMsg.content === trimmed &&
    now.getTime() - lastSessionMsg.timestamp < 2_000;
  const userTimestamps = userMsgsToday.map((m) => m.timestamp);
  if (!currentAlreadySaved) userTimestamps.push(now.getTime());
  const isRapidFollowUp =
    userTimestamps.length >= 2 &&
    userTimestamps[userTimestamps.length - 1] - userTimestamps[userTimestamps.length - 2] <
      5 * 60 * 1000;
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
    quietHours: {
      start: state.config.quiet_hours_start,
      end: state.config.quiet_hours_end,
    },
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
  crisis: CrisisLevel | null = null,
): GateAction {
  // 安全优先：危机信号必须触达，不能被门控延迟/沉默
  if (crisis) return { type: "reply", delayMs: 600 };
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

/**
 * 跨轮反重复注入块：读最近几条她自己发过的话，提醒模型换开头/换句式。
 * - 默认 `openers` 模式（只给开头片段，避免模型照抄整句）；
 * - `KAREN_NO_ANTI_REPEAT=1` 关闭（评测 A/B 用，正常使用不要设置）；
 * - `KAREN_REPEAT_NOTE_MODE=full` 回放整句（仅评测对照用）。
 */
function buildAvoidRepeatInjection(recentReplies: string[]): string {
  if (process.env.KAREN_NO_ANTI_REPEAT === "1") return "";
  const mode = process.env.KAREN_REPEAT_NOTE_MODE === "full" ? "full" : "openers";
  return buildAvoidRepeatNote(recentReplies, mode);
}

/**
 * 检测本轮回复是否在复述最近几轮，命中时记一行日志（不额外调模型、不改回复）。
 * 非流式路径写进 /why 可看的 logs；流式路径由调用方 console 输出。
 */
function noteRepetitionIfAny(
  reply: string,
  recentReplies: string[],
  push: (line: string) => void,
): void {
  if (recentReplies.length === 0) return;
  const repetition = detectRepetition(reply, recentReplies);
  if (repetition.duplicate) {
    push(`[重复] 与最近回复相似 ${repetition.score.toFixed(2)}(${repetition.kind})`);
  }
  // v0.8.12：全历史逐字重复（真机第 8 轮 vs 第 38 轮那种）——任何"最近 N 轮"窗口都抓不到
  const exact = findExactRepeatInHistory(reply, recentReplies);
  if (exact.repeated) {
    push(`[重复] 与 ${exact.turnAgo} 轮前逐字重复`);
  }
}

/** 他在问"当下"（现在啥样/这会儿拍的/马上看看）→ 照片必须是今天的（v0.8.11） */
function asksForPresentMoment(userText: string): boolean {
  return /(现在|此刻|这会儿|这时候|马上|刚刚|此时此刻)/.test(userText ?? "");
}

/** 未化解的冲突：给她的下一条回复一个「还没缓过来」的处境，而不是当没事发生 */
function buildConflictNote(state: ConversationState): string {
  const last = state.relationshipState.lastConflictAt;
  if (!last) return "";
  const hours = (Date.now() - last) / (60 * 60 * 1000);
  if (hours > 24) return "";
  return (
    "\n## 你心里的疙瘩\n" +
    "刚才对方的话让你不太舒服，这事还没过去。你可以保持距离、把话题岔开，" +
    "或者在对方真诚道歉时稍微松动一点；不要假装什么都没发生。\n"
  );
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
      reflection: state.reflectionState,
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
      lastGate: state.lastGate,
      proactivePaused: state.proactivePaused,
      storageKey: state.storageKey,
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

  const boundary = checkBoundary(userInput);
  const evaluation = evaluateRelationshipEvent(state.relationshipState, {
    currentCloseness: state.relationshipState.closeness,
    userText: userInput,
    replyText,
    complexity,
    guilt: state.guiltState.guilt,
    isBoundaryViolation: boundary.violation,
    isApology: isApology(userInput),
    now,
  });

  if (evaluation) {
    state.relationshipState = applyRelationshipEvent(
      state.relationshipState,
      evaluation.delta,
      evaluation.reason,
      now,
      { conflict: evaluation.conflict, repair: evaluation.repair },
    );
    const after = state.relationshipState.closeness;
    state.persona.relationship.closeness = after;
    messages.push(
      `[关系] ${evaluation.reason}：亲密度 ${before.toFixed(2)} → ${after.toFixed(2)}（${closenessLabel(after)}）`,
    );
    // v0.8：五维关系随事件演化（冲突顶张力、道歉修复、深聊加信任/亲密）
    try {
      const dims = state.relationshipState.dims ?? createRelationshipDims(before);
      const dimEvent: DimEventKind | null = evaluation.conflict
        ? "conflict"
        : evaluation.repair
          ? "apology"
          : evaluation.delta >= 0.1
            ? "deep_talk"
            : evaluation.delta > 0
              ? "care"
              : null;
      if (dimEvent) {
        const next = applyDimEvent(dims, dimEvent, {
          now: now.getTime(),
          intensity: Math.min(2, 0.6 + Math.abs(evaluation.delta) * 6),
        });
        state.relationshipState.dims = next;
        messages.push(`[关系] 五维：${describeDims(next)}`);
      }
    } catch {
      // 五维失败不影响主流程
    }

    if (state.relationshipState.milestones.length > beforeMilestones) {
      const milestone = state.relationshipState.milestones[state.relationshipState.milestones.length - 1];
      messages.push(`[关系] 里程碑：${milestone.title}`);
    }
  } else {
    state.relationshipState = touchInteraction(state.relationshipState, now);
  }

  // v0.8：反思循环（觉察→否认→承认→整合；承认后才真的改）
  const phaseBefore = state.reflectionState.phase;
  feedReflectionSignal(state, userInput);
  if (state.reflectionState.phase !== phaseBefore) {
    messages.push(`[反思] ${REFLECTION_PHASE_LABELS[state.reflectionState.phase]}`);
    const statement = buildReflectionStatement(state.reflectionState);
    if (statement) console.log(`  [反思] 她心里：${previewText(statement, 30)}`);
  }
  applyReflectionChange(state);

  return messages;
}

// ── 单轮处理 ──────────────────────────────────



// ── 她主动了解你（v0.5）─────────────────────

/** 每个 owner 的轮次计数与上次主动提问的轮次（进程内即可，重启最多少问一轮） */
const getToKnowState = new Map<string, { turn: number; lastAskedTurn: number | null }>();

/**
 * 认识初期主动问一句（"你是做什么的"）。
 *
 * 为什么：真实会话里用户从不主动说自己的事，事实层会一直是空的。
 * 只在亲密度 <5、该主题没问过、且距上次提问 ≥4 轮时触发；每次只问一个主题。
 */
function buildGetToKnowInjection(state: ConversationState): string {
  try {
    const entry = getToKnowState.get(state.owner) ?? { turn: 0, lastAskedTurn: null };
    entry.turn += 1;
    getToKnowState.set(state.owner, entry);

    const db = getVectorDb();
    const asked = listAskedTopics(db, state.owner);
    const knownKeys = listUserFacts(state.owner).map((f) => f.key);
    const decision = pickGetToKnowAsk({
      knownFactKeys: knownKeys,
      askedTopics: asked.map((a) => a.topic),
      closeness: state.persona.relationship.closeness,
      turnIndex: entry.turn,
      lastAskedTurn: entry.lastAskedTurn,
    });
    if (!decision) return "";
    markTopicAsked(db, state.owner, decision.topic);
    entry.lastAskedTurn = entry.turn;
    console.log(`  [了解你] 主动问一句：${decision.hint}`);
    return buildGetToKnowNote(decision);
  } catch {
    return "";
  }
}

// ── 事实质疑（v0.5）──────────────────────────

/**
 * 与既有说法冲突的事实 → 让她自然确认一句。
 * 同一条事实 2 天内只问一次（markFactsChallenged），避免变成审问。
 */
// ── 反思循环（v0.8）─────────────────────────

/** 每个 owner 的「同类信号」短期计数（进程内即可，重启清零不算准） */
const reflectionSignalCounts = new Map<string, { kind: ReflectionSignalKind; count: number; lastAt: number }>();

/**
 * 每轮喂一个反思信号（是否真的触发由状态机判定）。
 *
 * 信号来源（不读用户原文进 prompt，只作为内部由头）：
 * - 他点破（"你最近是不是冷淡了"）→ user_pointed_out（1 次即察觉）；
 * - 连续冷场/他很少回 → self_observed（需 2 次）；
 * - 24h 内有过冲突 → conflict_echo。
 */
function feedReflectionSignal(state: ConversationState, userInput: string): void {
  try {
    const now = Date.now();
    const kind: ReflectionSignalKind | null = looksLikeUserPointingOut(userInput)
      ? "user_pointed_out"
      : state.relationshipState.lastConflictAt !== null &&
          now - state.relationshipState.lastConflictAt < 24 * 3600_000
        ? "conflict_echo"
        : null;
    if (!kind) return;

    const topic =
      kind === "user_pointed_out"
        ? "他好像觉得我最近有点不一样"
        : "上次那件事我还在想";

    const prev = reflectionSignalCounts.get(state.owner);
    const count =
      prev && prev.kind === kind && now - prev.lastAt < 3 * 24 * 3600_000 ? prev.count + 1 : 1;
    reflectionSignalCounts.set(state.owner, { kind, count, lastAt: now });

    state.reflectionState = applyReflectionSignal(
      state.reflectionState,
      { kind, topic },
      { now, recentSignalCount: count },
    );
  } catch {
    // 反思失败不影响对话
  }
}

/** 承认之后真的改一点（只改一次）：往哪个方向改由由头决定。 */
function applyReflectionChange(state: ConversationState): void {
  try {
    if (!shouldApplyChange(state.reflectionState)) return;
    const topic = state.reflectionState.topic ?? "";
    // 默认：把漂移基线往"更稳"的方向拉一点，并把 perceived 对齐（她自己的感知跟上）
    const drift = state.driftState;
    state.driftState = {
      ...drift,
      actualBaseline: Math.max(-0.3, Math.min(0.3, drift.actualBaseline * 0.85)),
      perceivedBaseline: Math.max(-0.3, Math.min(0.3, drift.perceivedBaseline * 0.85)),
      lastAwareness: Date.now(),
    };
    state.reflectionState = { ...state.reflectionState, changeApplied: true };
    console.log(`  [反思] 她真的改了一点（由头：${previewText(topic, 20)}）`);
  } catch {
    // 忽略
  }
}

/** 反思注入（非平静期才有，一句话）。 */
function buildReflectionNote(state: ConversationState): string {
  try {
    return buildReflectionInjection(state.reflectionState);
  } catch {
    return "";
  }
}

// ── 五维关系注入（v0.8）─────────────────────

/** 把「关系现状」压成一句话注入 prompt：阶段 + 行为倾向。 */
function buildRelationshipDimsInjection(state: ConversationState): string {
  try {
    const dims =
      state.relationshipState.dims ??
      createRelationshipDims(state.relationshipState.closeness);
    const phase = derivePhase(dims, {
      interactionStreak: state.relationshipState.interactionStreak,
      recentConflict:
        state.relationshipState.lastConflictAt !== null &&
        Date.now() - (state.relationshipState.lastConflictAt ?? 0) < 24 * 3600_000,
    });
    const note = behaviorNote(dims, phase);
    if (!note) return "";
    return `\n「关系」${PHASE_LABELS[phase]}：${note}\n`;
  } catch {
    return "";
  }
}

function buildFactConflictInjection(state: ConversationState): string {
  try {
    const conflicts = getFactsNeedingConfirmation(state.owner);
    if (conflicts.length === 0) return "";
    markFactsChallenged(state.owner, conflicts.map((c) => c.key));
    console.log(`  [事实] 待确认 ${conflicts.length} 条（冲突事实，顺口问一句）`);
    return buildFactConflictNote(conflicts);
  } catch {
    return "";
  }
}

// ── 记忆 v2：锚点与日记忆（v0.5）────────────

/** 锚点/日记忆注入预算（字符）与条数上限 */
const MEMORY_ANCHOR_LIMIT = 5;
const MEMORY_DIGEST_LIMIT = 3;

/**
 * 把「锚点 + 最近几天日记忆」注入 prompt。`KAREN_MEMORY_V2=off` 可整体回退。
 * 任何 DB 异常都静默降级为空（聊天不能因为记忆层挂了而报错）。
 */
function buildMemoryInjection(state: ConversationState): string {
  if (process.env.KAREN_MEMORY_V2 === "off") return "";
  try {
    const db = getVectorDb();
    const anchors = listAnchors(db, state.storagePersona, state.owner, MEMORY_ANCHOR_LIMIT);
    const digests = listRecentDigests(db, state.storagePersona, state.owner, MEMORY_DIGEST_LIMIT);
    if (anchors.length === 0 && digests.length === 0) return "";
    const ctx = buildMemoryContext({ anchors, digests });
    if (ctx.usedAnchorIds.length > 0) touchAnchors(db, ctx.usedAnchorIds);
    if (ctx.chars > 0) {
      console.log(
        `  [记忆] 注入锚点 ${ctx.usedAnchorIds.length} 条 / 日记忆 ${digests.length} 天（${ctx.chars} 字符）`,
      );
    }
    return ctx.text;
  } catch {
    return "";
  }
}

/**
 * v0.8.18：上周汇总注入。
 *
 * 真实冒烟发现的缺口：`weekly_rollups` 从 v0.5 就在写，但**没有任何地方读它**，
 * 等于「周记忆」这个能力是断的（日→周链路末端没人消费）。
 * 这里把它压成 ≤140 字的一小段注入 prompt：只给「上周大概」，不抢锚点/日记忆预算。
 */
function buildWeeklyInjection(state: ConversationState): string {
  if (process.env.KAREN_MEMORY_V2 === "off") return "";
  try {
    const db = getVectorDb();
    const rollups = listRecentRollups(db, state.storagePersona, state.owner, 1);
    const text = formatWeeklyInjection(rollups[0] ?? null);
    if (text) console.log("  [记忆] 注入上周汇总");
    return text;
  } catch {
    return "";
  }
}

/**
 * 回合结束时判定这段对话值不值得成为「锚点」。
 *
 * 规则打分（无额外 LLM 调用）：情绪强度/承诺/冲突/道歉/自我披露/共同经历/秘密/表白/失去。
 * 阈值 0.75——宁可少记，也不要什么都记（锚点是"永远不会忘"的那类事）。
 */
function maybeRecordAnchor(state: ConversationState, userInput: string, reply: string): void {
  if (process.env.KAREN_MEMORY_V2 === "off") return;
  try {
    const combined = `${userInput}\n${reply}`;
    const salience = scoreSalience({
      content: combined,
      source: "chat",
      emotionVector: state.emotionState.vector,
    });
    if (salience.score < 0.75) return;
    const db = getVectorDb();
    const id = addAnchor(db, {
      personaId: state.storagePersona,
      ownerId: state.owner,
      kind: inferAnchorKind(combined),
      summary: summarizeAnchor(userInput, 30) || summarizeAnchor(reply, 30),
      quote: combined.slice(0, 200),
      strength: salience.score,
    });
    if (id !== null) {
      console.log(`  [记忆] 新增锚点 #${id}（显著度 ${salience.score}：${salience.reasons.join("、")}）`);
    }
  } catch {
    // 记忆层失败不影响对话
  }
}

// ── 意图式主动性（v0.8）─────────────────────

/** 每天几点后可以生成"今天想找他聊什么"的计划 */

/**
 * 确保今天有主动计划（没有就调一次 LLM 生成，失败下次心跳再试）。
 * 计划只存库，不直接发消息——发不发由 processProactive 按时间窗/上限/校准决定。
 */
export async function ensureDailyInitiativePlan(state: ConversationState): Promise<void> {
  if (process.env.KAREN_INITIATIVE === "off") return;
  try {
    const db = getVectorDb();
    const day = localDayKey(Date.now());
    // v0.8.11：去掉了「7 点前不生成计划」的时段门槛——
    // 深夜聊天（00:00–07:00）本来也需要"她今天想说的由头"，原门槛让夜聊永远没有主动话题。
    if (getInitiativePlan(db, state.storagePersona, state.owner, day)) return;

    const digests = listRecentDigests(db, state.storagePersona, state.owner, 3);
    // v0.9.4：把她自己的生活线索喂给计划生成（原来只喂他的事 → 主动只会追问对方）
    const now = new Date();
    const weatherRaw = state.weatherPerception?.raw;
    const lifeSignals = buildLifeSignals({
      world: (state.persona as { world?: Parameters<typeof buildLifeSignals>[0]["world"] }).world ?? null,
      hour: now.getHours(),
      weekday: now.getDay() === 0 ? 7 : now.getDay(),
      emotionLabel: describeEmotion(state.emotionState),
      weather: weatherRaw ? { condition: weatherRaw.condition, temperature: weatherRaw.temp } : null,
    });
    const prompt = buildDailyPlanPrompt({
      herName: state.persona.name,
      userName: state.config.your_name,
      day,
      closeness: state.relationshipState.closeness,
      lifeSignals,
      recentDigests: digests.map((d) => `${d.day}：${d.summary}`),
      openThreads: digests
        .map((d) => {
          try {
            return (JSON.parse(d.open_threads_json ?? "[]") as string[]).join("；");
          } catch {
            return "";
          }
        })
        .filter(Boolean)
        .slice(0, 3),
    });
    const raw = await generateDailyPlanWithLLM(prompt);
    if (!raw) return;
    const plan = parseDailyPlan(raw, day);
    if (!plan) return;
    saveInitiativePlan(db, {
      personaId: state.storagePersona,
      ownerId: state.owner,
      day,
      planJson: serializePlan(plan),
    });
    console.log(`  [主动计划] ${day} 生成 ${plan.items.length} 条由头`);
  } catch {
    // 计划失败不影响对话
  }
}

/** 正在生成中的「今日由头计划」key（同一人设/owner/天只生成一次） */
const initiativePlanInflight = new Set<string>();

/**
 * v0.8.11：正常回复前顺手把「今日由头计划」准备好（fire-and-forget，不增加回复延迟）。
 * 原来是只在心跳里生成 → 一天里前几轮对话根本没有由头可用，主动性自然偏弱。
 */
function kickInitiativePlan(state: ConversationState): void {
  if (process.env.KAREN_INITIATIVE === "off") return;
  const key = `${state.storagePersona}@${state.owner}@${localDayKey(Date.now())}`;
  if (initiativePlanInflight.has(key)) return;
  initiativePlanInflight.add(key);
  void ensureDailyInitiativePlan(state)
    .catch(() => undefined)
    .finally(() => initiativePlanInflight.delete(key));
}

/** 读今天的计划（没有返回 null）。 */
function loadTodayPlan(state: ConversationState): DailyInitiativePlan | null {
  if (process.env.KAREN_INITIATIVE === "off") return null;
  try {
    const db = getVectorDb();
    const row = getInitiativePlan(db, state.storagePersona, state.owner, localDayKey(Date.now()));
    return row ? deserializePlan(row.plan_json) : null;
  } catch {
    return null;
  }
}

/**
 * v0.8.11：把今天「本来想跟他说的事」注入回复 prompt。
 * 只在能自然接上时提（他不在提问、关系够近、非危机），否则不注入——
 * 目的是解决评审说的"自己开新话题偏少"，而不是让她变成强行转话题。
 */
function buildInitiativeReplyNote(
  state: ConversationState,
  userText: string,
  isCrisis: boolean,
): string {
  try {
    const plan = loadTodayPlan(state);
    return buildInitiativeReplyHint({
      plan,
      userText,
      closeness: state.relationshipState.closeness,
      messageCount: state.session.messages.length,
      isCrisis,
    });
  } catch {
    return "";
  }
}

/** 按最近的回复率算今天最多主动几条。 */
function currentDailyCap(state: ConversationState): number {
  try {
    const db = getVectorDb();
    const replies = recentInitiativeReplyCount(db, state.owner, 10);
    const sentCount = initiativeSentCount(db, state.owner);
    const { cap } = calibratedDailyCap({
      repliesToInitiative: replies,
      hisInitiatives: state.relationshipState.interactionStreak > 0 ? 4 : 1,
      closeness: state.relationshipState.closeness,
      // v0.8.14：从没主动过 ≠ 他不回，否则会死锁（不发→没回复→更不敢发）
      hasSentHistory: sentCount > 0,
    });
    return cap;
  } catch {
    return 2;
  }
}

/**
 * 到期的记忆任务（日记忆 / 周汇总）。
 *
 * 由桥接心跳每 15 分钟调用一次：没有到期任务时只做几次 DB 查询，几乎零成本；
 * 关机错过的日期会在下次启动后补跑（computeDueJobs 负责回看）。
 */
export async function runMemoryJobsIfDue(state: ConversationState): Promise<void> {
  if (process.env.KAREN_MEMORY_V2 === "off") return;
  try {
    const db = getVectorDb();
    // v0.8：今天的主动计划（没有就生成一次）
    await ensureDailyInitiativePlan(state);

    const due = computeDueJobs({
      db,
      personaId: state.storagePersona,
      ownerId: state.owner,
    });
    for (const day of due.dailyDigestDays) {
      const result = await runDailyDigest({
        db,
        personaId: state.storagePersona,
        ownerId: state.owner,
        dayKey: day,
        messages: state.session.messages,
        chatFn: async (prompt) => {
          const text = await summarizeDayWithLLM(prompt);
          if (!text) throw new Error("llm_null");
          return text;
        },
      });
      if (result.ok) {
        console.log(`  [日记忆] ${day} 已生成`);
      } else if (result.reason !== "no_messages") {
        console.log(`  [日记忆] ${day} 未生成（${result.reason}）`);
      }
    }
    // v0.8.4：昨日边界记忆的锚点复筛（每天一次，幂等；候选不足会自动跳过）
    try {
      const targetDay = shiftDayKey(localDayKey(Date.now()), -1);
      const db2 = getVectorDb();
      const done = db2
        .prepare(`SELECT 1 FROM job_runs WHERE job = 'anchor_refine' AND period = ? LIMIT 1`)
        .get(targetDay);
      if (!done) {
        const result = await runAnchorRefine({
          db: db2,
          personaId: state.storagePersona,
          ownerId: state.owner,
          day: targetDay,
          herName: state.persona.name,
          userName: state.config.your_name,
          chatFn: (prompt) => refineAnchorsWithLLM(prompt),
        });
        if (result.ok) {
          db2
            .prepare(`INSERT OR REPLACE INTO job_runs (job, period, ran_at) VALUES ('anchor_refine', ?, ?)`)
            .run(targetDay, Date.now());
          if (result.created > 0) {
            console.log(`  [锚点复筛] ${targetDay} 新增 ${result.created} 条（候选 ${result.candidates}）`);
          }
        } else if (result.reason !== "no_candidates") {
          console.log(`  [锚点复筛] ${targetDay} 跳过（${result.reason}）`);
        }
      }
    } catch {
      // 复筛失败不影响其它任务
    }

    for (const week of due.weeklyRollupWeeks) {
      const result = runWeeklyRollup({
        db,
        personaId: state.storagePersona,
        ownerId: state.owner,
        weekStart: week,
      });
      if (result.ok) console.log(`  [周汇总] ${week} 已生成`);
    }
  } catch {
    // 记忆任务失败不影响聊天
  }
}

// ── 说话动作（v0.3.3：主动/共情小改造）──────

/** 最近几轮做过的说话动作（按 owner + 存储人设隔离，进程内即可） */
const recentTalkMoves = new Map<string, TalkMove[]>();

/**
 * 给这一轮的 system prompt 追加一句内部提示：先接住情绪 / 顺手补一句自己的近况。
 * 只影响措辞，不改变门控与记忆；`KAREN_TALK_MOVES=off` 可整体关闭（A/B 用）。
 */
function buildTalkMoveInjection(
  state: ConversationState,
  userInput: string,
  crisis: string | null,
): string {
  const key = `${state.owner ?? "cli"}|${state.storagePersona}`;
  const recent = recentTalkMoves.get(key) ?? [];
  const decision = decideTalkMove(
    {
      userText: userInput,
      hour: new Date().getHours(),
      closeness: state.persona.relationship.closeness,
      isCrisis: crisis !== null,
      recentMoves: recent,
      quietHours: {
        start: state.config.quiet_hours_start,
        end: state.config.quiet_hours_end,
      },
    },
    { enabled: process.env.KAREN_TALK_MOVES !== "off" },
  );
  if (decision.move !== "none") {
    recentTalkMoves.set(key, [...recent, decision.move].slice(-4));
    console.log(`  [说话动作] ${decision.move}（${decision.reason}）`);
  }
  return decision.note;
}

export async function processMessage(
  state: ConversationState,
  userInput: string,
  opts: ProcessOptions = {},
): Promise<PipelineResult> {
  const logs: string[] = [];
  const now = new Date();
  const { persona, config, emotionState, guiltState, socialTact, driftState, causalChains, silenceState, session, weatherPerception } = state;

  // A-1. 安全兜底：危机信号（不是情感识别，是安全优先）
  const crisis = detectCrisis(userInput);
  if (crisis) logs.push("[安全] 检测到危机信号：本轮强制回复并附加专业求助资源");

  // 多用户隔离：每轮显式切回本 state 的存储 persona（防止多用户交替时串记忆）
  setCurrentPersona(state.storagePersona);

  // v0.8：他说话了 → 把最近一次还没被回的主动标记为已回（频率校准用）
  try {
    markInitiativeReplied(getVectorDb(), state.owner, Date.now());
  } catch {
    // 统计失败不影响对话
  }

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
    logs.push(`[沉默] 阶段${silencePhase}，建议重启: "${previewText(restartMsg)}"`);
  }

  // C. 因果链闯入 + 漂移
  const intrusion = generateIntrusion(causalChains);
  if (intrusion) {
    logs.push(`[因果链] 闯入: ${previewText(intrusion.description)}`);
    Object.assign(emotionState, adjustEmotion(emotionState, intrusion.intensity * (Math.random() > 0.5 ? 1 : -1) * 0.1, "闯入事件"));
  }
  addDriftPressure(driftState, Math.abs(emotionState.vector - emotionState.baseline), 0);
  emotionState.baseline += getDriftOffset(driftState) * 0.01;
  dailyRebound(driftState, 0);
  const awareness = checkAwareness(driftState);
  if (awareness.aware) logs.push(`[觉察] ${previewText(awareness.message)}`);



  // D. 负债衰减
  Object.assign(guiltState, dailyDecay(guiltState));

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

  // H. T2 记忆检索（M1-7 混合检索 → DeepSeek 重排；重排失败/超时自动降级原顺序）
  const memories = await retrieveWithLlmBoost(userInput, 8, { onLog: (line) => logs.push(line) });
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
    personaId: state.storagePersona,
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
  const conflictNote = buildConflictNote(state);
  const crisisNote = crisis ? crisisSafetyNote() : "";
  const factsContext = getUserFactsContext(state.owner);
  // T1 快照 → 最近状态弧（只用数值趋势，不引用对话正文）
  const t1ArcContext = getT1ArcContext(state.storagePersona);
  if (t1ArcContext) logs.push("[T1] 注入最近状态弧");
  // 跨轮反重复：最近几条她自己的话（prompt 注入与回复后检测共用同一份）
  const recentReplies = extractRecentReplies(session.messages, DEFAULT_LONG_RANGE_REPLY_COUNT);
  const avoidRepeatNote = buildAvoidRepeatInjection(recentReplies);
  kickInitiativePlan(state);
  // 用户点名要照片/表情包/语音：让她的语气和程序实际会发的动作对齐
  const mediaRequest = detectMediaRequest(userInput);
  const fullSystem =
    systemPrompt +
    narrationContext(styleContext, trendingContext, interruptedNote, narrativeInject) +
    conflictNote +
    crisisNote +
    t1ArcContext +
    factsContext +
    buildReflectionNote(state) +
    buildRelationshipDimsInjection(state) +
    buildFactConflictInjection(state) +
    buildGetToKnowInjection(state) +
    buildMemoryInjection(state) +
    buildWeeklyInjection(state) +
    avoidRepeatNote +
    buildMediaRequestNote(mediaRequest) +
    buildTalkMoveInjection(state, userInput, crisis) +
    buildInitiativeReplyNote(state, userInput, Boolean(crisis)) +
    `\n${momentTag}`;
  const messages = buildChatMessages(session, fullSystem);

  // M. AI 回复（近期消息已在 messages 里，避免 shortTerm 重复注入；只注入长期 RAG）
  const complexity = classifyComplexity(userInput);
  if (complexity !== "normal") logs.push(`[路由] ${complexity}(${userInput.length}字)`);
  let rawReply = await chat(messages, persona, { ragContext, complexity });
  // 确定性兜底：prompt 已禁用「考我/记性没那么差」话术，模型偶尔仍会说 → 出站前删掉分句
  const guarded = stripMemoryDeflection(rawReply);
  if (guarded.changed) {
    rawReply = guarded.text;
    logs.push("[去AI味] 移除记忆防御话术");
  }
  // 相识场景守卫：用户问「怎么认识的」且记忆里没有任何依据时，删掉编造的具体场景
  const meetingUngrounded =
    isAskingHowWeMet(userInput) &&
    !hasMeetingGrounding({
      userBackground: state.config.relationship_background,
      factsText: factsContext,
      memoryText: ragContext,
    });
  if (meetingUngrounded) {
    const meetingGuard = stripFabricatedMeeting(rawReply, true);
    rawReply = meetingGuard.removedAll
      ? pickMeetingFallback(userInput)
      : meetingGuard.text;
    if (meetingGuard.changed) logs.push("[相识] 拦截编造的具体相识场景");
  }
  noteRepetitionIfAny(rawReply, recentReplies, (line) => logs.push(line));

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
  maybeRecordAnchor(state, userInput, rawReply);
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
      if (trace) logs.push(`[因果链] 回响: ${previewText(trace)}`);
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
  let imageFile: string | undefined;
  let imageCaption: string | undefined;
  try {
    // 群聊默认 skipPhoto：多人群里不发她的生活照（隐私保守，group_photo_enabled 才开）
    const photo = opts.skipPhoto
      ? null
      : await trySharePhoto(state, rawReply, {
          requested: mediaRequest.photo,
          // 他在倒苦水时不顺手发无关的生活照（点名要图除外），免得像没在听
          skipWhenTroubleTalk: !mediaRequest.photo && isTroubleTalk(userInput),
          // 用户点名要照片时，尽量按他说的场景挑图（要晚霞就别发山/花）
          // 点名叫他看什么就发什么；普通聊天里提到晚霞/雪/咖啡/猫等强场景词，也顺手匹配
          preferredTags: detectPhotoSceneTags(userInput),
          // v0.9：相关性判定需要知道"她刚说了什么 / 他在聊什么"
          lastReply: rawReply,
          userText: userInput,
          preferEra: asksForPresentMoment(userInput) ? "today" : undefined,
        });
    if (photo) {
      imageUrl = photo.imageUrl;
      imageFile = photo.imageFile;
      imageCaption = photo.caption;
      logs.push(`[发图] 主动分享(${photo.source}): ${previewText(imageCaption)}`);
    }
  } catch (err: unknown) {
    // 发图失败不影响主回复
    logs.push(`[Unsplash] 发图失败: ${err instanceof Error ? err.message : "未知错误"}`);
  }

  state.consecutiveSilences = 0;
  logs.push(...updateRelationshipAfterTurn(state, userInput, rawReply, complexity));
  persistRuntimeState(state);
  // 后台抽取「确定记得」的用户事实（fire-and-forget，不阻塞回复）
  extractUserFactsAsync(state.owner, userInput, rawReply);
  return {
    reply,
    logs,
    qqFace: rendered.qqFace,
    imageUrl,
    imageFile,
    imageCaption,
    safetyMessage: crisis ? crisisResourcesText() : undefined,
  };
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
  /**
   * 主动发图（流式路径）：url = Unsplash 图；file = 本地兜底图绝对路径；
   * caption 为配文（桥接负责先发配文再发图）。
   */
  image?: { url?: string; file?: string; caption?: string };
  /** 消息门判定「晚点回」：调用方应在 delayMs 后以 {bypassGate:true, skipUserPersist:true} 重新调用 */
  deferred?: { delayMs: number };
  /** 合规：危机信号的专业求助资源（桥接作为独立消息发送） */
  safetyMessage?: string;
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

  // 多用户隔离：每轮显式切回本 state 的存储 persona（防止多用户交替时串记忆）
  setCurrentPersona(state.storagePersona);

  // v0.8：他说话了 → 把最近一次还没被回的主动标记为已回（频率校准用）
  try {
    markInitiativeReplied(getVectorDb(), state.owner, Date.now());
  } catch {
    // 统计失败不影响对话
  }

  // 安全兜底：危机信号（不是情感识别，是安全优先）
  const crisis = detectCrisis(userInput);
  if (crisis) console.log("[安全] 检测到危机信号：本轮强制回复并附加专业求助资源");

  // 状态维护（与非流式保持一致：天气刷新/情绪恢复/沉默追踪）
  await refreshWeatherIfStale(state);
  Object.assign(emotionState, naturalRecover(emotionState));
  Object.assign(guiltState, dailyDecay(guiltState));
  if (!state.weatherApplied && Math.abs(weatherPerception.moodOffset) > 0.01) {
    Object.assign(emotionState, adjustEmotion(emotionState, weatherPerception.moodOffset, "天气感知"));
    state.weatherApplied = true;
  }
  Object.assign(silenceState, touchUserActivity(silenceState, userInput));

  // C. 因果链闯入 + 漂移（与非流式对齐）
  const streamIntrusion = generateIntrusion(state.causalChains);
  if (streamIntrusion) {
    Object.assign(
      emotionState,
      adjustEmotion(
        emotionState,
        streamIntrusion.intensity * (Math.random() > 0.5 ? 1 : -1) * 0.1,
        "闯入事件",
      ),
    );
  }
  addDriftPressure(state.driftState, Math.abs(emotionState.vector - emotionState.baseline), 0);
  emotionState.baseline += getDriftOffset(state.driftState) * 0.01;
  dailyRebound(state.driftState, 0);
  checkAwareness(state.driftState);

  const now = new Date();
  const hour = now.getHours();

  // 消息门（与 CLI/群聊共用同一上下文；修复此前写死 messageCountToday=0 的问题）
  const gateContext = buildGateContext(state, userInput, now);
  const gate = decideGateForTurn(state, gateContext, opts, crisis);
  recordGateDecision(state, gate, opts, crisis);

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

  // P2-b+P2-1: 自我叙事弧线（与非流式对齐）
  const streamDiary = await flipThroughDiary();
  const { arc: streamNarrArc, logs: streamNarrLogs } = advanceNarrativeArc({
    arc: state.narrativeArc,
    drift: state.driftState,
    recentMemories: [],
    attachmentStyle: persona.emotions.attachmentStyle,
    diaryReaction: streamDiary ?? undefined,
  });
  state.narrativeArc = streamNarrArc;
  for (const line of streamNarrLogs) console.log(`  ${line}`);

  let narrativeInject = "";
  if (shouldInjectNarrative(state.narrativeArc) && Math.random() < 0.15) {
    narrativeInject =
      "\n\n## 内心觉察\n你隐隐约约感觉到自己有些变化(" +
      state.narrativeArc.stage +
      ")。若自然可顺带提起，不必硬说。";
    state.narrativeArc = markNarrativeExpressed(state.narrativeArc);
  }

  // G. 纠正层（与非流式对齐）
  applyCorrections(persona.name, userInput);

  // 中断恢复
  let interruptedNote = "";
  if (state.interrupted) {
    interruptedNote = buildInterruptSignal(session, emotionState.vector, hour);
    state.interrupted = false;
  }

  // I/J/L. 社交分寸 + L1 弹性裁决 + 内心状态 EMA（与非流式对齐）
  const exposure = exposureRatio(socialTact, persona.relationship.closeness);
  const impulseIntensity = calculateImpulseIntensity(emotionState, persona.relationship.closeness);
  if (impulseIntensity > 0.3) {
    const rawState: InnerState = {
      exposure,
      guilt: guiltState.guilt,
      emotion: emotionState.vector,
      hour,
      mode: "neutral",
      closeness: persona.relationship.closeness,
    };
    const l1Threshold = computeThreshold(persona.emotions.attachmentStyle, rawState);
    const ruling = checkRuleBreach(state.chainRules, impulseIntensity, l1Threshold);
    if (ruling.phase === "rule_broken") {
      Object.assign(guiltState, incurGuilt(guiltState, ruling.guiltProduced, "规则突破"));
    }
  }

  const exceptionThreshold = calculateExceptionThreshold(
    0.6,
    persona.relationship.closeness,
    Math.abs(emotionState.vector),
    impulseIntensity,
  );
  const isExceptional = isException(impulseIntensity, 0.6, exceptionThreshold);

  session.t3.emotionVector = emotionState.vector;
  const ema = (prev: number, curr: number) => prev * 0.7 + curr * 0.3;
  const smoothedExposure = state.prevInnerState
    ? ema(state.prevInnerState.exposure, exposure)
    : exposure;
  const smoothedGuilt = state.prevInnerState
    ? ema(state.prevInnerState.guilt, guiltState.guilt)
    : guiltState.guilt;

  let innerMode: InnerState["mode"] = "neutral";
  if (isExceptional) innerMode = "guilty";
  else if (smoothedGuilt > 0.3) innerMode = "avoidant";
  else if (smoothedExposure < 0.3) innerMode = "distant";
  else if (smoothedExposure > 0.6 && persona.relationship.closeness >= 5) innerMode = "close";

  const currentInner: InnerState = {
    exposure: smoothedExposure,
    guilt: smoothedGuilt,
    emotion: emotionState.vector,
    hour,
    mode: innerMode,
    closeness: persona.relationship.closeness,
  };
  state.prevInnerState = { ...currentInner };
  state.innerState = currentInner;

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

  // P1-2: 动态风格参考（与非流式对齐）
  const styleRefs = retrieveStyleReference({
    emotionVector: emotionState.vector,
    guilt: guiltState.guilt,
    mode: innerMode,
    userInput,
    personaId: state.storagePersona,
  });
  const styleContext = buildStyleContext(styleRefs);

  // 热点感知：每 1-2 小时刷新一次（与非流式对齐）
  let trendingContext = "";
  const streamNowTs = Date.now();
  if (streamNowTs - state.lastTrendingInject > 60 * 60 * 1000 + Math.random() * 60 * 60 * 1000) {
    const topics = getTrendingTopics();
    const careerKw = persona.identity.lifeStory.career?.split(/[,，、\s]+/) ?? [];
    const matched = matchTrendingTopics(topics, careerKw, []);
    trendingContext = buildTrendingContext(matched);
    if (trendingContext) state.lastTrendingInject = streamNowTs;
  }

  const memories = await retrieveWithLlmBoost(userInput, 8, {
    onLog: (line) => console.log(`  ${line}`),
  });
  const ragContext = buildRagContext(memories);
  // 结构化事实（与非流式对齐）：此前流式主路径漏注入，QQ 私聊里「记得对方说过的事」会失效
  const factsContext = getUserFactsContext(state.owner);
  // T1 快照 → 最近状态弧（与非流式对齐）
  const t1ArcContext = getT1ArcContext(state.storagePersona);
  if (t1ArcContext) console.log("  [T1] 注入最近状态弧");
  // 跨轮反重复（与非流式对齐）
  const recentReplies = extractRecentReplies(session.messages, DEFAULT_LONG_RANGE_REPLY_COUNT);
  const avoidRepeatNote = buildAvoidRepeatInjection(recentReplies);
  kickInitiativePlan(state);
  const mediaRequest = detectMediaRequest(userInput);
  // 相识守卫：用户问「怎么认识」且无依据 → 逐条过滤编造场景
  const meetingUngrounded =
    isAskingHowWeMet(userInput) &&
    !hasMeetingGrounding({
      userBackground: state.config.relationship_background,
      factsText: factsContext,
      memoryText: ragContext,
    });
  if (meetingUngrounded) console.log("  [相识] 无可靠依据：过滤编造场景");

  const fullSystem =
    systemPrompt +
    narrationContext(styleContext, trendingContext, interruptedNote, narrativeInject) +
    buildConflictNote(state) +
    (crisis ? crisisSafetyNote() : "") +
    t1ArcContext +
    factsContext +
    buildReflectionNote(state) +
    buildRelationshipDimsInjection(state) +
    buildFactConflictInjection(state) +
    buildGetToKnowInjection(state) +
    buildMemoryInjection(state) +
    buildWeeklyInjection(state) +
    avoidRepeatNote +
    buildMediaRequestNote(mediaRequest) +
    buildTalkMoveInjection(state, userInput, crisis) +
    buildInitiativeReplyNote(state, userInput, Boolean(crisis)) +
    `\n${momentTag}`;

  // 构建消息列表
  const messages = buildChatMessages(session, fullSystem);

  // 流式 LLM 调用
  let fullReply = "";
  let sentReply = "";
  let buffer = "";
  const BREAKS = /[\n。！？…]/;
  /** 只清理句末软标点，避免发出「……，」碎片 */
  const cleanFragment = (text: string): string => text.replace(/[，,、;；:：\s]+$/g, "").trim();
  let yieldedAny = false;

  const complexity = classifyComplexity(userInput);
  let deflected = false;

  try {
    try {
      const stream = chatStream(messages, persona, { ragContext, complexity });

      for await (const token of stream) {
        fullReply += token;
        buffer += token;

        // 只在自然句末（换行/句号/问号/感叹/省略号）分条；
        // 逗号不再分条，避免「，」结尾的 AI 味碎片
        if (BREAKS.test(token)) {
          const frag = cleanFragment(buffer);
          if (frag) {
            const safe = stripMemoryDeflection(frag);
            if (safe.changed) deflected = true;
            if (safe.text) {
              const meetingSafe = stripFabricatedMeeting(safe.text, meetingUngrounded);
              if (meetingSafe.changed && !meetingSafe.removedAll) {
                console.log("  [相识] 拦截编造的具体相识场景");
              }
              if (meetingSafe.text) {
                sentReply += (sentReply ? "\n" : "") + meetingSafe.text;
                yieldedAny = true;
                yield { text: meetingSafe.text };
              }
            }
          }
          buffer = "";
        }
      }

      // 发送剩余内容
      const tail = cleanFragment(buffer);
      if (tail) {
        const safe = stripMemoryDeflection(tail);
        if (safe.changed) deflected = true;
        if (safe.text) {
          const meetingSafe = stripFabricatedMeeting(safe.text, meetingUngrounded);
          if (meetingSafe.text) {
            sentReply += (sentReply ? "\n" : "") + meetingSafe.text;
            yieldedAny = true;
            yield { text: meetingSafe.text };
          }
        }
      }
    } catch (err) {
      // 流式失败：仅在尚未发送任何内容时降级为非流式，避免「半句 + 完整」重复发送
      if (!yieldedAny) {
        console.log("[流式] 失败，回落到非流式");
        fullReply = await chat(messages, persona, { ragContext });
        const lines = fullReply.split("\n").filter(Boolean);
        for (const line of lines) {
          const frag = line.trim();
          if (!frag) continue;
          const safe = stripMemoryDeflection(frag);
          if (safe.changed) deflected = true;
          if (!safe.text) continue;
          const meetingSafe = stripFabricatedMeeting(safe.text, meetingUngrounded);
          if (!meetingSafe.text) continue;
          sentReply += (sentReply ? "\n" : "") + meetingSafe.text;
          yieldedAny = true;
          yield { text: meetingSafe.text };
        }
      } else {
        console.log(
          `[流式] 已发送部分内容后中断，跳过降级: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    if (deflected) console.log("  [去AI味] 移除记忆防御话术");

    // 相识守卫把整条都删空了（全在编场景）→ 换成一句含糊的真人式回应
    if (meetingUngrounded && !sentReply.trim()) {
      const fallback = pickMeetingFallback(userInput);
      sentReply = fallback;
      yieldedAny = true;
      console.log("  [相识] 全篇编造，改用含糊回应");
      yield { text: fallback };
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

    // 主动发图：流式路径也触发（无 Key 时本地图库兜底；超时/失败静默跳过）
    try {
      const photo = await Promise.race([
        trySharePhoto(state, fullReply, {
          requested: mediaRequest.photo,
          skipWhenTroubleTalk: !mediaRequest.photo && isTroubleTalk(userInput),
          preferredTags: detectPhotoSceneTags(userInput),
          lastReply: fullReply,
          userText: userInput,
          preferEra: asksForPresentMoment(userInput) ? "today" : undefined,
        }).catch(() => null),
        new Promise<null>((resolve) => setTimeout(() => resolve(null), 4000)),
      ]);
      if (photo) {
        yield {
          text: "",
          image: { url: photo.imageUrl, file: photo.imageFile, caption: photo.caption },
        };
      }
    } catch {
      // 发图失败不影响文字回复
    }

    // 合规：危机信号的专业求助资源（独立消息，由程序生成，不依赖模型）
    if (crisis) {
      yield { text: "", safetyMessage: crisisResourcesText() };
    }
  } finally {
    // 无论正常结束还是被消费方中断（break），都持久化「实际已发送」的内容，避免记忆丢失
    const persisted = sentReply || fullReply;
    if (persisted) {
      noteRepetitionIfAny(persisted, recentReplies, (line) => console.log(`  ${line}`));
      addMessage(session, "assistant", persisted);
      storeConversationEpisode(userInput, persisted, emotionState.vector);
      maybeRecordAnchor(state, userInput, persisted);
      maybeCompressToT3();
      maybeGenerateJournal();
      insertT1Snapshot({
        content: `用户: ${userInput.slice(0, 60)} | Karen: ${persisted.slice(0, 60)}`,
        emotionVector: emotionState.vector,
        closeness: persona.relationship.closeness,
        guilt: guiltState.guilt,
        summary: "[stream]",
      });
      session.t3.currentTopic = userInput.slice(0, 40);

      // P. 因果链回响（与非流式对齐）
      for (const chain of state.causalChains) {
        addUserTrace(chain, userInput);
        if (Math.random() < 0.1) recallUserTrace(chain);
      }

      // Q. 纠正记录（与非流式对齐）
      if (userInput.includes("你不会这样说") || userInput.includes("你应该是")) {
        addCorrection(persona.name, userInput.slice(0, 50), persisted.slice(0, 50), userInput);
      }

      // R. herViewOfYou 触发检测 + 异步更新（与非流式对齐）
      const prevStage = state.lastNarrativeStage;
      const currStage = state.narrativeArc.stage;
      if (prevStage !== currStage) state.lastNarrativeStage = currStage;
      if (
        !state.herViewGenerating &&
        shouldUpdateView({
          currentCloseness: persona.relationship.closeness,
          lastViewUpdateCloseness: state.lastViewUpdateCloseness,
          lastViewUpdateAt: state.lastViewUpdateAt,
          narrativeStage: currStage,
          previousNarrativeStage: prevStage,
        })
      ) {
        state.herViewGenerating = true;
        const captureCloseness = persona.relationship.closeness;
        const captureView = state.herViewOfYou;
        const streamRecentEpisodes = (() => {
          try {
            const { getAllEpisodes } = require("../data/vector.js");
            return (getAllEpisodes(5) as Array<{ content: string }>).map((e) => e.content);
          } catch {
            return [];
          }
        })();
        generateHerView({
          persona,
          currentCloseness: captureCloseness,
          previousView: captureView,
          recentMemories: streamRecentEpisodes,
        })
          .then((newView) => {
            if (newView) {
              state.previousViewOfYou = captureView;
              state.herViewOfYou = newView;
              state.lastViewUpdateCloseness = captureCloseness;
              state.lastViewUpdateAt = Date.now();
              console.log(`[herView] 更新: "${newView}"`);
            }
            state.herViewGenerating = false;
          })
          .catch(() => {
            state.herViewGenerating = false;
          });
      }

      triggerMonologue(state, userInput, persisted);
      extractUserFactsAsync(state.owner, userInput, persisted);
      state.consecutiveSilences = 0;
      for (const line of updateRelationshipAfterTurn(state, userInput, persisted, complexity)) {
        console.log(line);
      }
      persistRuntimeState(state);
    }
  }
}

// ── 主动消息：链路窗口 + 决策留痕（v0.4.0）──────

/**
 * 每条 owner 的"冷场窗口"标记与最近决策。
 * 只存在进程内（重启后最多多补一句，治理上限仍在持久化状态里），
 * 目的是让 /why 能回答「她最近为什么没主动找我」。
 */
interface ProactiveWindowState {
  /** 本轮冷场里已经补过话的时间 */
  followUpAt: number | null;
  /** 本轮冷场里已经开过话题的时间 */
  openTopicAt: number | null;
  /** 对方上一次回话之后，她已经主动发过几条（对方回话后清零） */
  sentSinceUserReply: number;
  /** 已计入的对方最后回话时间（用于判断是否来新消息） */
  lastUserAtSeen: number | null;
  /** 最近决策（最新在前，最多 8 条）；note 记录"决定了但没发出去"的原因 */
  recent: Array<{ at: number; decision: ProactiveDecision; note?: string }>;
}

const MAX_PROACTIVE_RECORDS = 8;
const proactiveWindows = new Map<string, ProactiveWindowState>();

function proactiveWindowFor(owner: string): ProactiveWindowState {
  let w = proactiveWindows.get(owner);
  if (!w) {
    w = {
      followUpAt: null,
      openTopicAt: null,
      sentSinceUserReply: 0,
      lastUserAtSeen: null,
      recent: [],
    };
    proactiveWindows.set(owner, w);
  }
  return w;
}

/** 测试用：清空进程内窗口状态 */
export function resetProactiveWindows(): void {
  proactiveWindows.clear();
}

/** 记录一次主动决策（供 /why 与模拟脚本使用） */
export function recordProactiveDecision(owner: string, decision: ProactiveDecision): void {
  const w = proactiveWindowFor(owner);
  w.recent.unshift({ at: Date.now(), decision });
  if (w.recent.length > MAX_PROACTIVE_RECORDS) w.recent.length = MAX_PROACTIVE_RECORDS;
}

/** 决定了要发、但被消息门挡住（深夜/免打扰等）——补一条注记，别让 /why 显示成"发送" */
function markProactiveBlocked(owner: string, note: string): void {
  const w = proactiveWindowFor(owner);
  if (w.recent.length > 0) w.recent[0].note = note;
}

/**
 * /why 用：她最近怎么决定「要不要主动找你」。
 * 只列最近决策 + 今天已发送次数/下一次最早时间，不复述对话正文。
 */
export function buildProactiveExplain(owner: string): string[] {
  const w = proactiveWindows.get(owner);
  const lines: string[] = ["", "【她最近怎么决定要不要主动找你】"];
  if (!w || w.recent.length === 0) {
    lines.push("还没有记录（生活流心跳每 15 分钟跑一次，跑过之后这里会有原因）。");
    return lines;
  }
  for (const item of w.recent.slice(0, 5)) {
    const time = new Date(item.at).toLocaleTimeString("zh-CN", {
      hour12: false,
      hour: "2-digit",
      minute: "2-digit",
    });
    const label = item.decision.action === "send" ? (item.note ? "触发但没发" : "发送") : "跳过";
    const detail =
      item.decision.action === "send"
        ? `${CHANNEL_LABEL[item.decision.channel]}（${item.decision.detail}）`
        : `${item.decision.detail}`;
    lines.push(`- ${time} ${label} · ${detail}${item.note ? `（${item.note}）` : ""}`);
  }
  lines.push("提示：主动消息受「单日上限 / 两次间隔 / 链路开关 / 亲密度 / 沉默时长」共同决定。");
  return lines;
}

/** 把配置里的链路开关归一化成完整对象（`KAREN_PROACTIVE_CHANNELS=off` 一键全关） */
function resolveProactiveChannels(config: ConversationState["config"]): ProactiveChannels {
  if (process.env.KAREN_PROACTIVE_CHANNELS === "off") return { ...ALL_CHANNELS_OFF };
  const raw = config.proactive_channels ?? {};
  return {
    follow_up: raw.follow_up ?? DEFAULT_PROACTIVE_CHANNELS.follow_up,
    silence_revive: raw.silence_revive ?? DEFAULT_PROACTIVE_CHANNELS.silence_revive,
    life_share: raw.life_share ?? DEFAULT_PROACTIVE_CHANNELS.life_share,
    open_topic: raw.open_topic ?? DEFAULT_PROACTIVE_CHANNELS.open_topic,
  };
}

/** 会话里用户/她各自最后一条消息的时间（按时间顺序扫，最后写入者胜出） */
function lastMessageTimes(session: ConversationSession): {
  lastUserAt: number | null;
  lastHerAt: number | null;
} {
  let lastUserAt: number | null = null;
  let lastHerAt: number | null = null;
  for (const m of session.messages) {
    if (m.role === "user") lastUserAt = m.timestamp;
    else if (m.role === "assistant") lastHerAt = m.timestamp;
  }
  return { lastUserAt, lastHerAt };
}

/** 各链路的"冲动强度"（沿用 0-1 语义，供渲染/门控复用） */
const CHANNEL_INTENSITY: Record<ProactiveChannel, number> = {
  follow_up: 0.45,
  open_topic: 0.4,
  silence_revive: 0.55,
  life_share: 0.5,
};

/**
 * 生活流心跳：检查她此刻的生活状态，生成分享冲动。
 * 触发源优先级：因果链 > 天气 > 情绪 > 时间节点。
 * 沉默保温仅在阶段 4（>72h）作为兜底。
 * 不做深夜禁言——消息门自会判断延迟或发送。
 */
export type ProactiveOutcome =
  | {
      sent: true;
      reply: string;
      logs: string[];
      qqFace?: string;
      channel: ProactiveChannel;
    }
  | { sent: false; logs: string[]; decision: ProactiveDecision };

export async function processProactive(
  state: ConversationState,
): Promise<ProactiveOutcome> {
  const logs: string[] = [];
  const { persona, config, emotionState, guiltState, socialTact, silenceState, session,
    causalChains, weatherPerception } = state;

  // 多用户隔离：每轮显式切回本 state 的存储 persona
  setCurrentPersona(state.storagePersona);

  // 状态维护
  await refreshWeatherIfStale(state);
  Object.assign(emotionState, naturalRecover(emotionState));
  Object.assign(guiltState, dailyDecay(guiltState));

  const now = new Date();
  const hour = now.getHours();

  // 最小间隔：两次心跳之间至少 8 分钟（防止并发重复）
  if (state.lastHeartbeatAt && now.getTime() - state.lastHeartbeatAt < 8 * 60 * 1000) {
    return {
      sent: false,
      logs,
      decision: { action: "skip", reason: "min_gap", detail: "心跳过于频繁（距上次不足 8 分钟）" },
    };
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

  // ── 1. 收集生活流候选（她自己的生活里正在发生的事）───

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
      description: `你此刻心情${dir}。你想到了一个可以说说话。`,
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

  // 1e. v0.8：今天的「主动计划」里到点的由头（时间窗/上限/校准都由纯函数判定）
  let planItem: { topic: string; kind: string } | null = null;
  let planCandidate: ImpulseCandidate | null = null;
  try {
    const plan = loadTodayPlan(state);
    if (plan) {
      const lastUserAt = [...session.messages].reverse().find((m) => m.role === "user")?.timestamp;
      const decision = pickDueInitiative(plan, {
        hour,
        closeness: state.relationshipState.closeness,
        sentToday: state.proactiveCountToday,
        dailyCap: currentDailyCap(state),
        minutesSinceLast: state.lastProactiveSentAt
          ? Math.max(0, (now.getTime() - state.lastProactiveSentAt) / 60000)
          : null,
        minGapMinutes: 30,
        quietHours: { start: config.quiet_hours_start, end: config.quiet_hours_end },
        userRecentlyReplied:
          lastUserAt !== undefined && now.getTime() - lastUserAt < 10 * 60 * 1000,
      });
      if (decision.action === "send") {
        planItem = { topic: decision.item.topic, kind: decision.item.kind };
        planCandidate = {
          source: "主动计划",
          description: `你想跟他说这件事：${decision.item.topic}`,
          intensity: 0.35 + decision.item.urgency * 0.4,
          priority: 10, // 明确想说的由头优先于随机生活流
        };
        candidates.push(planCandidate);
        logs.push(`[主动计划] 到点由头：${decision.item.topic}`);
      } else if (decision.reason !== "no_plan") {
        logs.push(`[主动计划] 本轮不发：${decision.reason}`);
      }
    }
  } catch {
    // 计划异常不影响主动消息
  }

  // ── 2. 四条链路决策（v0.4.0：补话 / 沉默保温 / 生活流 / 冷场开话题）───
  // 沉默保温由决策模块按沉默时长判定，不再只看阶段 4。
  const lifeTop = candidates.length > 0
    ? [...candidates].sort((a, b) => b.priority - a.priority)[0]
    : null;
  const window = proactiveWindowFor(state.owner);
  const { lastUserAt, lastHerAt } = lastMessageTimes(session);
  // 对方来新消息 → "连推"计数清零
  if (lastUserAt !== null && (window.lastUserAtSeen === null || lastUserAt > window.lastUserAtSeen)) {
    window.lastUserAtSeen = lastUserAt;
    window.sentSinceUserReply = 0;
  }
  const decision = decideProactive({
    now: now.getTime(),
    lastUserAt,
    lastHerAt,
    followUpAt: window.followUpAt,
    openTopicAt: window.openTopicAt,
    lastProactiveAt: state.lastProactiveSentAt || null,
    proactiveCountToday: state.proactiveCountToday,
    maxPerDay: MAX_PROACTIVE_PER_DAY,
    minGapMs: MIN_PROACTIVE_GAP_MS,
    closeness: persona.relationship.closeness,
    silencePhase: getSilencePhase(silenceState),
    silenceReviveSent: silenceState.restartSent,
    hasLifeCandidate: lifeTop !== null,
    lifePriority: lifeTop?.priority ?? 0,
    unansweredProactive: window.sentSinceUserReply,
    paused: state.proactivePaused,
    channels: resolveProactiveChannels(config),
  });

  recordProactiveDecision(state.owner, decision);
  logs.push(`[主动] ${formatProactiveDecision(decision)}｜${decision.detail}`);

  // v0.8.14：到点的今日由头已经过自己的闸门（时间窗/日上限/间隔/免打扰/回复),
  // 不再被 v0.4 链路的随机概率否掉——否则"想说的事"有一半概率永远说不出来。
  if (decision.action === "skip" && !planCandidate) {
    return { sent: false, logs, decision };
  }
  if (decision.action === "skip" && planCandidate) {
    logs.push(`[主动] 计划由头优先：忽略链路判定（${decision.detail}）`);
  }

  // 统一成"触发候选"形状，下游（日志/门控/生成/渲染）继续复用
  // v0.8.14 修复：到点的「今日由头」优先于 v0.4 四条链路。
  // 之前只在 channel==="life_share" 时才采用 lifeTop，导致计划判定"该发"、
  // 日志也写了"到点由头"，最后却发了一条不相干的生活流（真机冒烟抓到）。
  let picked: ImpulseCandidate;
  if (planCandidate) {
    picked = planCandidate;
  } else {
    // 兜底：走到这里说明不是计划由头，必须是正常链路判定
    if (decision.action !== "send") return { sent: false, logs, decision };
    picked =
      decision.channel === "life_share" && lifeTop
        ? lifeTop
        : {
            source: CHANNEL_LABEL[decision.channel],
            description: decision.detail,
            intensity: CHANNEL_INTENSITY[decision.channel],
            priority: 0,
          };
  }
  // 计划驱动的消息在统计上仍归入「生活流分享」（它就是她在分享/提起自己的事）
  const usedChannel = decision.action === "send" ? decision.channel : "life_share";

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
    quietHours: {
      start: config.quiet_hours_start,
      end: config.quiet_hours_end,
    },
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
          console.log(`[独白] 深夜冲动已记录: ${previewText(mono)}`);
        }
      }).catch(() => { /* 独白失败不影响主流程 */ });
    } else {
      logs.push(`[主动] 门控延迟(${picked.source}): ${gate.reason}`);
    }
    markProactiveBlocked(state.owner, `消息门延迟：${gate.reason}`);
    return { sent: false, logs, decision };
  }
  if (gate.type !== "reply") {
    logs.push(`[主动] 消息门阻止(${picked.source}): ${gate.reason}`);
    markProactiveBlocked(state.owner, `消息门阻止：${gate.reason}`);
    return { sent: false, logs, decision };
  }

  // 标记状态
  state.lastSharedWeather = cond;
  if (usedChannel === "silence_revive") silenceState.restartSent = true;
  // 记录本轮冷场已用过的链路（对方回话后自动失效：时间戳会比较）
  if (usedChannel === "follow_up") window.followUpAt = now.getTime();
  if (usedChannel === "open_topic") window.openTopicAt = now.getTime();

  // ── 5. 生成消息 ──────────────────────────────

  const exposure = exposureRatio(socialTact, persona.relationship.closeness);
  const currentInner: InnerState = {
    exposure,
    guilt: guiltState.guilt,
    emotion: emotionState.vector,
    hour,
    mode:
      usedChannel === "silence_revive"
        ? "guilty"
        : emotionState.vector > 0.3
          ? "close"
          : "neutral",
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

  // 注入触发上下文：告诉 LLM 她因为什么、以什么姿态开口
  const proactiveInject = [
    ``,
    `## 此刻的冲动`,
    buildChannelNote(usedChannel, picked.description),
    `自然地发一条消息。不要用"最近咋样"这种泛泛的开场——你是因为具体的事情才想到他的。`,
  ].join("\n");

  // 跨轮反重复：主动消息同样别和上一轮开口一样
  const recentReplies = extractRecentReplies(session.messages, DEFAULT_LONG_RANGE_REPLY_COUNT);
  const avoidRepeatNote = buildAvoidRepeatInjection(recentReplies);
  kickInitiativePlan(state);
  // T1 快照 → 最近状态弧（主动消息也从最近的关系走势出发）
  const t1ArcContext = getT1ArcContext(state.storagePersona);
  if (t1ArcContext) logs.push("[T1] 注入最近状态弧");
  const fullSystem = systemPrompt + proactiveInject + t1ArcContext + avoidRepeatNote;
  const messages = buildChatMessages(session, fullSystem);

  // LLM 调用
  let rawReply = await chat(messages, persona);
  const proactiveGuarded = stripMemoryDeflection(rawReply);
  if (proactiveGuarded.changed) {
    rawReply = proactiveGuarded.text;
    logs.push("[去AI味] 移除记忆防御话术");
  }
  noteRepetitionIfAny(rawReply, recentReplies, (line) => logs.push(line));

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
  window.sentSinceUserReply += 1;
  // v0.8：计划的由头用完标记（当天不再重复）+ 记一条主动统计（供回复率校准）
  try {
    if (planItem) {
      const plan = loadTodayPlan(state);
      if (plan) {
        saveInitiativePlan(getVectorDb(), {
          personaId: state.storagePersona,
          ownerId: state.owner,
          day: localDayKey(now.getTime()),
          planJson: serializePlan(markInitiativeUsed(plan, planItem.topic)),
        });
      }
    }
    recordInitiativeSent(getVectorDb(), state.owner, now.getTime());
  } catch {
    // 统计失败不影响已发送的消息
  }
  persistRuntimeState(state);

  logs.push(`[主动] 已发送: ${previewText(reply)}`);
  return { sent: true, reply, logs, qqFace: rendered.qqFace, channel: usedChannel };
}

// ── 统计信息 ──────────────────────────────────

export function getStateSummary(state: ConversationState): string[] {
  const { emotionState, guiltState, driftState, causalChains, session } = state;
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

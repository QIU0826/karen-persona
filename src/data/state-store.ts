/**
 * 人格运行时状态持久化（M1-1）。
 *
 * 解决的问题：情绪、负债、基线漂移、因果链、叙事弧、herView、主动消息计数等
 * 之前只存在内存里，进程重启即归零，导致「她会慢慢变化」在主路径上不成立。
 *
 * 设计：
 * - 每个状态一份 JSON（data/persona-state-<persona>.json），原子写（tmp + rename）
 * - 加载时做容错归一化：字段缺失/类型不对 → 用默认值补齐；损坏文件备份后重建
 * - 不存 T1/T2 记忆（SQLite 已持久化）与会话（session 已单独持久化）以外的重复数据
 * - 版本号用于后续迁移
 */
import fs from "node:fs";
import { dataFile, safeFileStem } from "./paths.js";
import { createEmotionState, type EmotionState } from "../persona/emotion.js";
import { createGuiltState, type GuiltState } from "../persona/guilt-repayment.js";
import { createDriftState, type DriftState } from "../evolution/baseline-drift.js";
import { createSilenceState, type SilenceState } from "../impulse/silence-arc.js";
import type { CausalChain } from "../evolution/causal-chain.js";
import { createNarrativeArc, type NarrativeArc } from "../evolution/narrative-reconstruct.js";
import { createRelationshipState, type RelationshipState } from "../persona/relationship.js";
import type { WeatherInfo } from "../world/weather.js";

/** 当前持久化 schema 版本 */
export const PERSONA_STATE_VERSION = 1;

export interface PersistedHerView {
  current: string | null;
  previous: string | null;
  lastUpdateCloseness: number;
  lastUpdateAt: number | null;
}

export interface PersistedCounters {
  consecutiveSilences: number;
  lastProactiveSentAt: number;
  proactiveCountToday: number;
  proactiveDay: string;
  lastHeartbeatAt: number;
  lastTrendingInject: number;
  lastSharedWeather: string | null;
  interrupted: boolean;
}

/** 消息门裁决记录（/why 可解释；不含消息正文） */
export interface PersistedGateRecord {
  action: "reply" | "delay" | "silence";
  reason: string;
  at: number;
  remainingMs?: number;
}

export interface PersistedPersonaState {
  version: number;
  personaId: string;
  savedAt: number;
  emotion: EmotionState;
  guilt: GuiltState;
  drift: DriftState;
  silence: SilenceState;
  causalChains: CausalChain[];
  narrativeArc: NarrativeArc;
  herView: PersistedHerView;
  relationship: RelationshipState;
  counters: PersistedCounters;
  weather: { raw: WeatherInfo; fetchedAt: number } | null;
  lastGate: PersistedGateRecord | null;
  proactivePaused: boolean;
}

function stateFilePath(personaId: string): string {
  return dataFile(`persona-state-${safeFileStem(personaId)}.json`);
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

function num(v: unknown, fallback: number): number {
  return typeof v === "number" && Number.isFinite(v) ? v : fallback;
}

function str(v: unknown, fallback: string | null): string | null {
  return typeof v === "string" ? v : fallback;
}

function boolean(v: unknown, fallback: boolean): boolean {
  return typeof v === "boolean" ? v : fallback;
}

/** 默认状态（用于首次运行 / 字段缺失补齐） */
export function createPersistedPersonaState(personaId: string, initialCloseness = 3): PersistedPersonaState {
  return {
    version: PERSONA_STATE_VERSION,
    personaId,
    savedAt: 0,
    emotion: createEmotionState(),
    guilt: createGuiltState(),
    drift: createDriftState(0),
    silence: createSilenceState(),
    causalChains: [],
    narrativeArc: createNarrativeArc(),
    herView: { current: null, previous: null, lastUpdateCloseness: initialCloseness, lastUpdateAt: null },
    relationship: createRelationshipState(initialCloseness),
    counters: {
      consecutiveSilences: 0,
      lastProactiveSentAt: 0,
      proactiveCountToday: 0,
      proactiveDay: "",
      lastHeartbeatAt: 0,
      lastTrendingInject: 0,
      lastSharedWeather: null,
      interrupted: false,
    },
    weather: null,
    lastGate: null,
    proactivePaused: false,
  };
}

/** 把任意 JSON 归一化成合法状态（尽量保留可用字段，坏字段回退默认值） */
function normalize(raw: unknown, personaId: string, initialCloseness: number): PersistedPersonaState {
  const base = createPersistedPersonaState(personaId, initialCloseness);
  if (!isRecord(raw)) return base;

  const emotionRaw = isRecord(raw.emotion) ? raw.emotion : {};
  const emotion: EmotionState = {
    vector: Math.max(-1, Math.min(1, num(emotionRaw.vector, base.emotion.vector))),
    baseline: Math.max(-1, Math.min(1, num(emotionRaw.baseline, base.emotion.baseline))),
    arousal: Math.max(0, Math.min(1, num(emotionRaw.arousal, base.emotion.arousal))),
    lastUpdated: num(emotionRaw.lastUpdated, Date.now()),
  };

  const guiltRaw = isRecord(raw.guilt) ? raw.guilt : {};
  const guilt: GuiltState = {
    guilt: Math.max(0, Math.min(1, num(guiltRaw.guilt, 0))),
    resentment: Math.max(0, Math.min(1, num(guiltRaw.resentment, 0))),
    pendingRepayment: null,
  };

  const driftRaw = isRecord(raw.drift) ? raw.drift : {};
  const drift: DriftState = {
    actualBaseline: Math.max(-0.3, Math.min(0.3, num(driftRaw.actualBaseline, 0))),
    perceivedBaseline: Math.max(-0.3, Math.min(0.3, num(driftRaw.perceivedBaseline, 0))),
    pressure: num(driftRaw.pressure, 0),
    lastAwareness: num(driftRaw.lastAwareness, Date.now()),
    history: Array.isArray(driftRaw.history) ? (driftRaw.history as DriftState["history"]).slice(-100) : [],
  };

  const silenceRaw = isRecord(raw.silence) ? raw.silence : {};
  const silencePhase = num(silenceRaw.phase, 1);
  const silence: SilenceState = {
    userLastMessageAt: num(silenceRaw.userLastMessageAt, base.silence.userLastMessageAt),
    userLastMessage: str(silenceRaw.userLastMessage, "") ?? "",
    phase: (silencePhase === 2 || silencePhase === 3 || silencePhase === 4 ? silencePhase : 1) as SilenceState["phase"],
    restartSent: boolean(silenceRaw.restartSent, false),
  };

  const narrativeRaw = isRecord(raw.narrativeArc) ? raw.narrativeArc : {};
  const narrativeArc: NarrativeArc = {
    ...base.narrativeArc,
    ...(narrativeRaw as Partial<NarrativeArc>),
  };

  const relationshipRaw = isRecord(raw.relationship) ? raw.relationship : {};
  const closeness = Math.max(
    0,
    Math.min(10, num(relationshipRaw.closeness, initialCloseness)),
  );
  const relationship: RelationshipState = {
    ...createRelationshipState(closeness),
    ...(relationshipRaw as Partial<RelationshipState>),
    closeness,
    events: Array.isArray(relationshipRaw.events) ? (relationshipRaw.events as RelationshipState["events"]).slice(-200) : [],
    milestones: Array.isArray(relationshipRaw.milestones)
      ? (relationshipRaw.milestones as RelationshipState["milestones"]).slice(-50)
      : [],
  };

  const herViewRaw = isRecord(raw.herView) ? raw.herView : {};
  const herView: PersistedHerView = {
    current: str(herViewRaw.current, null),
    previous: str(herViewRaw.previous, null),
    lastUpdateCloseness: num(herViewRaw.lastUpdateCloseness, closeness),
    lastUpdateAt: typeof herViewRaw.lastUpdateAt === "number" ? herViewRaw.lastUpdateAt : null,
  };

  const countersRaw = isRecord(raw.counters) ? raw.counters : {};
  const counters: PersistedCounters = {
    consecutiveSilences: Math.max(0, num(countersRaw.consecutiveSilences, 0)),
    lastProactiveSentAt: num(countersRaw.lastProactiveSentAt, 0),
    proactiveCountToday: Math.max(0, num(countersRaw.proactiveCountToday, 0)),
    proactiveDay: str(countersRaw.proactiveDay, "") ?? "",
    lastHeartbeatAt: num(countersRaw.lastHeartbeatAt, 0),
    lastTrendingInject: num(countersRaw.lastTrendingInject, 0),
    lastSharedWeather: str(countersRaw.lastSharedWeather, null),
    interrupted: boolean(countersRaw.interrupted, false),
  };

  let weather: PersistedPersonaState["weather"] = null;
  if (isRecord(raw.weather) && isRecord(raw.weather.raw)) {
    const w = raw.weather.raw;
    if (typeof w.condition === "string" && typeof w.temp === "number") {
      weather = {
        raw: {
          condition: w.condition,
          temp: w.temp,
          humidity: num(w.humidity, 0),
          description: str(w.description, w.condition) ?? w.condition,
          city: str(w.city, "") ?? "",
        },
        fetchedAt: num(raw.weather.fetchedAt, 0),
      };
    }
  }

  let lastGate: PersistedGateRecord | null = null;
  if (isRecord(raw.lastGate)) {
    const action = raw.lastGate.action;
    if (action === "reply" || action === "delay" || action === "silence") {
      lastGate = {
        action,
        reason: str(raw.lastGate.reason, "") ?? "",
        at: num(raw.lastGate.at, 0),
        ...(typeof raw.lastGate.remainingMs === "number"
          ? { remainingMs: raw.lastGate.remainingMs }
          : {}),
      };
    }
  }

  return {
    version: PERSONA_STATE_VERSION,
    personaId,
    savedAt: num(raw.savedAt, 0),
    emotion,
    guilt,
    drift,
    silence,
    causalChains: Array.isArray(raw.causalChains)
      ? (raw.causalChains as CausalChain[]).filter(isRecord).slice(0, 20)
      : [],
    narrativeArc,
    herView,
    relationship,
    counters,
    weather,
    lastGate,
    proactivePaused: boolean(raw.proactivePaused, false),
  };
}

/** 加载状态；文件不存在返回 null；损坏时备份并返回 null */
export function loadPersonaState(personaId: string, initialCloseness = 3): PersistedPersonaState | null {
  const p = stateFilePath(personaId);
  if (!fs.existsSync(p)) return null;
  try {
    const raw = JSON.parse(fs.readFileSync(p, "utf-8")) as unknown;
    return normalize(raw, personaId, initialCloseness);
  } catch (err) {
    const backup = `${p}.corrupt-${Date.now()}`;
    try {
      fs.renameSync(p, backup);
      console.warn(`[状态] 状态文件损坏，已备份到 ${backup}`);
    } catch {
      // ignore
    }
    console.warn(`[状态] 加载失败: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

/** 原子保存状态（同步，几 KB，单条消息一次写可接受） */
export function savePersonaState(state: PersistedPersonaState): void {
  state.savedAt = Date.now();
  const p = stateFilePath(state.personaId);
  const tmp = `${p}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2), "utf-8");
  fs.renameSync(tmp, p);
}

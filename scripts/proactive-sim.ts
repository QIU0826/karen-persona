/**
 * 主动消息链路模拟（离线、不调模型）。
 *
 * 用真实的决策函数 `decideProactive` 跑一条多日时间线，打印每个心跳的
 * 「发/不发 + 原因」，用来回答两个问题：
 *  1. 四条链路在真实时间线上到底什么时候触发；
 *  2. 不改代码、只改配置（关某条链路）会怎样。
 *
 * 运行：node node_modules/tsx/dist/cli.mjs scripts/proactive-sim.ts
 *     加 --no-open-topic 演示关掉"冷场开话题"后的时间线。
 */
import {
  CHANNEL_LABEL,
  DEFAULT_PROACTIVE_CHANNELS,
  SKIP_REASON_LABEL,
  decideProactive,
  type ProactiveChannels,
  type ProactiveDecision,
} from "../src/impulse/proactive-plan.js";

const HEARTBEAT_MS = 15 * 60 * 1000;
const MIN_GAP_MS = 30 * 60 * 1000;
const MAX_PER_DAY = 4;
const HOUR = 60 * 60 * 1000;

/** 线性同余随机数，保证输出可复现 */
function seededRandom(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

function fmt(at: number): string {
  const d = new Date(at);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${String(d.getMonth() + 1).padStart(2, "0")}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

interface SimOptions {
  channels: ProactiveChannels;
  seed: number;
}

interface SimResult {
  /** 每行：时间 / 是否发出 / 说明 */
  rows: Array<{ at: number; sent: boolean; text: string; detail: string; reasonKey: string }>;
  sentByChannel: Record<string, number>;
  skipByReason: Record<string, number>;
}

/**
 * 时间线（Asia/Shanghai 本地时间，硬编码，便于复现）：
 * - 第 1 天 09:00 对方发消息 → 她 09:02 回
 * - 第 1 天 09:40 对方又发 → 她 09:42 回，之后对方消失
 * - 第 3 天 09:00 对方回来发了一条 → 她 09:02 回，之后消失 4 天
 */
function buildTimeline(): { start: number; userMessages: number[]; herReplies: number[] } {
  const start = new Date(2026, 9, 20, 9, 0, 0, 0).getTime(); // 10-20 09:00
  const userMessages = [start, start + 40 * 60 * 1000, start + 2 * 24 * HOUR];
  const herReplies = userMessages.map((t) => t + 2 * 60 * 1000);
  return { start, userMessages, herReplies };
}

function simulate(opts: SimOptions): SimResult {
  const random = seededRandom(opts.seed);
  const { start, userMessages, herReplies } = buildTimeline();
  const end = start + 7 * 24 * HOUR;

  const result: SimResult = { rows: [], sentByChannel: {}, skipByReason: {} };

  // 时间线事件（对方消息 / 她的回复 / 心跳），按时间排序后顺序处理
  type Event = { at: number; kind: "user" | "her" | "tick" };
  const events: Event[] = [];
  for (const t of userMessages) events.push({ at: t, kind: "user" });
  for (const t of herReplies) events.push({ at: t, kind: "her" });
  for (let t = start + HEARTBEAT_MS; t < end; t += HEARTBEAT_MS) {
    events.push({ at: t, kind: "tick" });
  }
  events.sort((a, b) => a.at - b.at);

  let lastUserAt: number | null = null;
  let lastHerAt: number | null = null;
  let followUpAt: number | null = null;
  let openTopicAt: number | null = null;
  let lastProactiveAt: number | null = null;
  let countToday = 0;
  let dayKey = "";
  let sentSinceUserReply = 0;
  let restartSent = false;
  let lastUserAtSeen: number | null = null;

  for (const ev of events) {
    if (ev.kind === "user") {
      lastUserAt = ev.at;
      restartSent = false;
      continue;
    }
    if (ev.kind === "her") {
      lastHerAt = ev.at;
      continue;
    }

    // 心跳：每天清零主动计数
    const key = fmt(ev.at).slice(0, 5);
    if (key !== dayKey) {
      dayKey = key;
      countToday = 0;
    }
    if (lastUserAt !== null && (lastUserAtSeen === null || lastUserAt > lastUserAtSeen)) {
      lastUserAtSeen = lastUserAt;
      sentSinceUserReply = 0;
    }

    const decision: ProactiveDecision = decideProactive(
      {
        now: ev.at,
        lastUserAt,
        lastHerAt,
        followUpAt,
        openTopicAt,
        lastProactiveAt,
        proactiveCountToday: countToday,
        maxPerDay: MAX_PER_DAY,
        minGapMs: MIN_GAP_MS,
        closeness: 4.2,
        silencePhase: lastUserAt !== null && ev.at - lastUserAt > 72 * HOUR ? 4 : 2,
        silenceReviveSent: restartSent,
        // 生活流候选在模拟里固定给一个"情绪 5 分"的量，便于观察链路优先级
        hasLifeCandidate: Math.abs((ev.at - start) % (5 * HOUR)) < HEARTBEAT_MS,
        lifePriority: 5,
        unansweredProactive: sentSinceUserReply,
        paused: false,
        channels: opts.channels,
      },
      { random },
    );

    if (decision.action === "send") {
      countToday += 1;
      lastProactiveAt = ev.at;
      lastHerAt = ev.at; // 她发了消息，沉默窗口从这条重新计时
      sentSinceUserReply += 1;
      if (decision.channel === "follow_up") followUpAt = ev.at;
      if (decision.channel === "open_topic") openTopicAt = ev.at;
      if (decision.channel === "silence_revive") restartSent = true;
      result.sentByChannel[CHANNEL_LABEL[decision.channel]] =
        (result.sentByChannel[CHANNEL_LABEL[decision.channel]] ?? 0) + 1;
      result.rows.push({
        at: ev.at,
        sent: true,
        text: CHANNEL_LABEL[decision.channel],
        detail: decision.detail,
        reasonKey: `send:${decision.channel}`,
      });
    } else {
      result.skipByReason[SKIP_REASON_LABEL[decision.reason]] =
        (result.skipByReason[SKIP_REASON_LABEL[decision.reason]] ?? 0) + 1;
      // 只打印"有变化"的跳过原因，避免每 15 分钟一行噪声
      const last = result.rows[result.rows.length - 1];
      if (!last || last.reasonKey !== decision.reason) {
        result.rows.push({
          at: ev.at,
          sent: false,
          text: "不发",
          detail: decision.detail,
          reasonKey: decision.reason,
        });
      }
    }
  }

  return result;
}

function print(name: string, result: SimResult): void {
  console.log(`\n=== ${name} ===`);
  for (const row of result.rows) {
    console.log(`${fmt(row.at)}  ${row.sent ? "发" : "不发"}  ${row.detail}`);
  }
  const perDay = new Map<string, number>();
  for (const row of result.rows) {
    if (!row.sent) continue;
    const key = fmt(row.at).slice(0, 5);
    perDay.set(key, (perDay.get(key) ?? 0) + 1);
  }
  console.log("每天发出条数：", Object.fromEntries(perDay));
  console.log("— 汇总 —");
  console.log("发出的消息（按链路）：", result.sentByChannel);
  console.log("跳过原因分布：", result.skipByReason);
}

const noOpenTopic = process.argv.includes("--no-open-topic");
const channels: ProactiveChannels = noOpenTopic
  ? { ...DEFAULT_PROACTIVE_CHANNELS, open_topic: false }
  : DEFAULT_PROACTIVE_CHANNELS;

print(
  noOpenTopic ? "时间线（关掉「冷场开话题」链路）" : "时间线（四条链路全开）",
  simulate({ channels, seed: 20261020 }),
);

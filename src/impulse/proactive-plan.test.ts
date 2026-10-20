import { describe, it, expect } from "vitest";
import {
  ALL_CHANNELS_OFF,
  CHANNEL_LABEL,
  DEFAULT_PROACTIVE_CHANNELS,
  FOLLOW_UP_MAX_MS,
  FOLLOW_UP_MIN_MS,
  OPEN_TOPIC_MIN_MS,
  buildChannelNote,
  decideProactive,
  formatProactiveDecision,
  type ProactiveChannels,
  type ProactiveSignals,
} from "./proactive-plan.js";

const NOW = 1_800_000_000_000; // 固定时间基准，避免本机时区/时间影响
const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;

/**
 * 构造信号。约定：显式给 lastHerAt 时，若没给 lastUserAt，则用户消息自动早 5 分钟
 * （保证「最后一句是她说的」这个前提成立，避免 fixture 自相矛盾）。
 */
function signals(patch: Partial<ProactiveSignals> = {}): ProactiveSignals {
  const merged: Partial<ProactiveSignals> =
    patch.lastHerAt !== undefined && patch.lastUserAt === undefined
      ? { ...patch, lastUserAt: patch.lastHerAt - 5 * MINUTE }
      : patch;
  return {
    now: NOW,
    lastUserAt: NOW - 30 * MINUTE,
    lastHerAt: NOW - 25 * MINUTE, // 最后一句是她说的
    followUpAt: null,
    openTopicAt: null,
    lastProactiveAt: null,
    proactiveCountToday: 0,
    maxPerDay: 4,
    minGapMs: 30 * MINUTE,
    closeness: 3,
    silencePhase: 0,
    silenceReviveSent: false,
    hasLifeCandidate: false,
    lifePriority: 0,
    unansweredProactive: 0,
    paused: false,
    channels: { ...DEFAULT_PROACTIVE_CHANNELS },
    ...merged,
  };
}

const alwaysSend = () => 0; // random() = 0 → 必中
const neverSend = () => 0.999; // random() = 0.999 → 必不中

describe("decideProactive：治理与基础信号", () => {
  it("默认四条链路全开", () => {
    expect(DEFAULT_PROACTIVE_CHANNELS).toEqual({
      follow_up: true,
      silence_revive: true,
      life_share: true,
      open_topic: true,
    });
    expect(ALL_CHANNELS_OFF.follow_up).toBe(false);
  });

  it("/pause 后一律跳过，且原因可读", () => {
    const d = decideProactive(signals({ paused: true }), { random: alwaysSend });
    expect(d).toMatchObject({ action: "skip", reason: "paused" });
    expect(d.action === "skip" && d.detail).toContain("暂停");
  });

  it("单日上限到了就跳过", () => {
    const d = decideProactive(signals({ proactiveCountToday: 4 }), { random: alwaysSend });
    expect(d).toMatchObject({ action: "skip", reason: "daily_cap" });
    expect(d.action === "skip" && d.detail).toContain("4/4");
  });

  it("距上次主动消息太近就跳过（并说明还要等多久）", () => {
    const d = decideProactive(signals({ lastProactiveAt: NOW - 5 * MINUTE }), {
      random: alwaysSend,
    });
    expect(d).toMatchObject({ action: "skip", reason: "min_gap" });
    expect(d.action === "skip" && d.detail).toMatch(/还要等约 \d+ 分钟/);
  });

  it("没有任何对话记录时不主动", () => {
    const d = decideProactive(signals({ lastUserAt: null, lastHerAt: null }), {
      random: alwaysSend,
    });
    expect(d).toMatchObject({ action: "skip", reason: "no_signal" });
  });

  it("对方刚发完消息（等她回复）时不插主动消息", () => {
    const d = decideProactive(signals({ lastUserAt: NOW - MINUTE, lastHerAt: NOW - 10 * MINUTE }), {
      random: alwaysSend,
    });
    expect(d).toMatchObject({ action: "skip", reason: "in_conversation" });
  });
});

describe("decideProactive：follow_up（没人接话补一句）", () => {
  it("她说完 25 分钟没被回 → 补一句", () => {
    const d = decideProactive(signals(), { random: alwaysSend });
    expect(d).toEqual({ action: "send", channel: "follow_up", detail: expect.any(String) });
  });

  it("刚说完 10 分钟不催", () => {
    const d = decideProactive(signals({ lastHerAt: NOW - 10 * MINUTE }), { random: alwaysSend });
    expect(d).toMatchObject({ action: "skip", reason: "follow_up_too_soon" });
  });

  it("这轮冷场里已经补过一次就不再补", () => {
    const d = decideProactive(
      signals({ followUpAt: NOW - 2 * MINUTE, lastHerAt: NOW - 25 * MINUTE }),
      { random: alwaysSend },
    );
    expect(d).toMatchObject({ action: "skip" });
    expect(d.action === "skip" && d.detail).toContain("补过一句");
  });

  it("对方回话后又冷场 → 新一轮窗口，可以再补", () => {
    // followUpAt 早于对方最后一条消息 → 不算「已经补过」
    const d = decideProactive(
      signals({ followUpAt: NOW - 40 * MINUTE, lastUserAt: NOW - 35 * MINUTE }),
      { random: alwaysSend },
    );
    expect(d).toEqual({ action: "send", channel: "follow_up", detail: expect.any(String) });
  });

  it("亲密度不够不主动（低亲密度不该像熟人一样催）", () => {
    const d = decideProactive(signals({ closeness: 1 }), { random: alwaysSend });
    expect(d).toMatchObject({ action: "skip", reason: "low_closeness" });
  });

  it("超过 3 小时窗口后交给 open_topic", () => {
    const d = decideProactive(signals({ lastHerAt: NOW - 4 * HOUR }), { random: alwaysSend });
    expect(d).toEqual({ action: "send", channel: "open_topic", detail: expect.any(String) });
  });
});

describe("decideProactive：open_topic（冷场开话题）", () => {
  it("冷场 4 小时 → 主动开个话头", () => {
    const d = decideProactive(signals({ lastHerAt: NOW - 4 * HOUR }), { random: alwaysSend });
    expect(d).toMatchObject({ action: "send", channel: "open_topic" });
  });

  it("链路关掉后不再开话题", () => {
    const channels: ProactiveChannels = { ...DEFAULT_PROACTIVE_CHANNELS, open_topic: false };
    const d = decideProactive(signals({ lastHerAt: NOW - 4 * HOUR, channels }), {
      random: alwaysSend,
    });
    expect(d).toMatchObject({ action: "skip", reason: "channel_off" });
  });

  it("这轮冷场里已经开过话头就不重复", () => {
    const d = decideProactive(
      signals({ lastHerAt: NOW - 4 * HOUR, openTopicAt: NOW - 3 * HOUR }),
      { random: alwaysSend },
    );
    expect(d).toMatchObject({ action: "skip", reason: "open_topic_already" });
  });

  it("冷场超过 72 小时交给沉默保温，不硬开话题", () => {
    const d = decideProactive(
      signals({ lastHerAt: NOW - 80 * HOUR, silencePhase: 4 }),
      { random: alwaysSend },
    );
    expect(d).toMatchObject({ action: "send", channel: "silence_revive" });
  });
});

describe("decideProactive：silence_revive（沉默保温）", () => {
  it("沉默阶段 4 → 重启联系", () => {
    const d = decideProactive(
      signals({ lastHerAt: NOW - 100 * HOUR, silencePhase: 4 }),
      { random: alwaysSend },
    );
    expect(d).toMatchObject({ action: "send", channel: "silence_revive" });
  });

  it("沉默超过 72h 但阶段数据偏低时，仍按时间判为重启联系", () => {
    const d = decideProactive(
      signals({ lastHerAt: NOW - 100 * HOUR, silencePhase: 2 }),
      { random: alwaysSend },
    );
    // 阶段数据可能来自旧版本/重启后未刷新，时间才是硬证据
    expect(d).toMatchObject({ action: "send", channel: "silence_revive" });
  });

  it("这轮失联已经问过一次 → 不再重复问", () => {
    const d = decideProactive(
      signals({ lastHerAt: NOW - 100 * HOUR, silencePhase: 4, silenceReviveSent: true }),
      { random: alwaysSend },
    );
    expect(d).toMatchObject({ action: "skip", reason: "silence_revive_already" });
  });

  it("冷场 4 小时不会被误判成沉默保温", () => {
    const d = decideProactive(signals({ lastHerAt: NOW - 4 * HOUR }), { random: alwaysSend });
    expect(d).not.toMatchObject({ channel: "silence_revive" });
  });
});

describe("decideProactive：life_share（生活流）", () => {
  it("她刚说完 5 分钟，但生活里刚有事发生 → 分享生活", () => {
    const d = decideProactive(
      signals({ lastHerAt: NOW - 5 * MINUTE, hasLifeCandidate: true, lifePriority: 9 }),
      { random: alwaysSend },
    );
    expect(d).toMatchObject({ action: "send", channel: "life_share" });
  });

  it("生活流优先级高于冷场开话题（因果链 9 分 > open_topic 50）", () => {
    const d = decideProactive(
      signals({ lastHerAt: NOW - 4 * HOUR, hasLifeCandidate: true, lifePriority: 9 }),
      { random: alwaysSend },
    );
    expect(d).toMatchObject({ action: "send", channel: "life_share" });
  });

  it("没有生活候选时不会走 life_share", () => {
    const d = decideProactive(
      signals({ lastHerAt: NOW - 5 * MINUTE, hasLifeCandidate: false }),
      { random: alwaysSend },
    );
    expect(d.action).toBe("skip");
  });

  it("生活流链路关掉、补话也关掉 → 原因是「链路被关」", () => {
    const channels: ProactiveChannels = {
      ...DEFAULT_PROACTIVE_CHANNELS,
      life_share: false,
      follow_up: false,
    };
    const d = decideProactive(
      signals({ lastHerAt: NOW - 5 * MINUTE, hasLifeCandidate: true, lifePriority: 9, channels }),
      { random: alwaysSend },
    );
    expect(d).toMatchObject({ action: "skip", reason: "channel_off" });
  });
});

describe("decideProactive：对方一直不回时收手", () => {
  it("一天内已经主动 2 条没被回 → 先等等", () => {
    const d = decideProactive(signals({ unansweredProactive: 2 }), { random: alwaysSend });
    expect(d).toMatchObject({ action: "skip", reason: "unanswered_wait" });
  });

  it("隔了一天（>24h）可以再试着联系", () => {
    const d = decideProactive(
      signals({ unansweredProactive: 2, lastHerAt: NOW - 30 * HOUR, silencePhase: 3 }),
      { random: alwaysSend },
    );
    expect(d).toMatchObject({ action: "send", channel: "open_topic" });
  });

  it("对方回过话（计数清零）就恢复正常主动", () => {
    const d = decideProactive(signals({ unansweredProactive: 0 }), { random: alwaysSend });
    expect(d).toMatchObject({ action: "send", channel: "follow_up" });
  });
});

describe("decideProactive：概率与可解释性", () => {
  it("命中链路但随机没过 → probability_miss（带上链路名与概率）", () => {
    const d = decideProactive(signals(), { random: neverSend });
    expect(d).toMatchObject({ action: "skip", reason: "probability_miss" });
    expect(d.action === "skip" && d.detail).toContain("没人接话补一句");
    expect(d.action === "skip" && d.detail).toContain("55%");
  });

  it("常用窗口常量符合设计（20 分钟 / 3 小时 起）", () => {
    expect(FOLLOW_UP_MIN_MS).toBe(20 * MINUTE);
    expect(FOLLOW_UP_MAX_MS).toBe(3 * HOUR);
    expect(OPEN_TOPIC_MIN_MS).toBe(3 * HOUR);
  });

  it("formatProactiveDecision 输出可读中文", () => {
    expect(
      formatProactiveDecision({ action: "send", channel: "follow_up", detail: "" }),
    ).toBe(`发送 · ${CHANNEL_LABEL.follow_up}`);
    expect(
      formatProactiveDecision({ action: "skip", reason: "min_gap", detail: "" }),
    ).toContain("跳过");
  });
});

describe("buildChannelNote：说话姿态", () => {
  it("补一句：明确禁止催促/连发", () => {
    const note = buildChannelNote("follow_up");
    expect(note).toContain("别追问");
    expect(note).toContain("一条就够");
  });

  it("开话题：禁止泛泛开场", () => {
    const note = buildChannelNote("open_topic");
    expect(note).toContain("最近咋样");
    expect(note).toContain("具体");
  });

  it("沉默保温：语气收着、不质问", () => {
    const note = buildChannelNote("silence_revive");
    expect(note).toContain("不要质问");
  });

  it("生活流：带上具体事件", () => {
    expect(buildChannelNote("life_share", "外面下雪了")).toContain("外面下雪了");
    expect(buildChannelNote("life_share")).toContain("想到对方");
  });
});

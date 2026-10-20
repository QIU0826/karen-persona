/**
 * 真实验证台纯函数单测（不联网、不 spawn、不写仓库数据）。
 *
 * 覆盖：CQ/OneBot 出站解析、指标计算、探针/编造检测、提示词解析、报告渲染
 * （人工观察段落保留）、隔离/端口红线、CLI 参数校验、进程日志解析。
 * 真实链路（mock OneBot + 真实 DeepSeek）由 scripts/mock-onebot-longrun.ts 手工跑。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  BridgeLogCollector,
  DAILY_SCENARIO,
  FORBIDDEN_PORTS,
  HEALTH_PORT,
  MOCK_QQ,
  SETUP_STEPS,
  WS_PORT,
  assertIsolatedWorkspace,
  assertSafePorts,
  buildReviewerMessages,
  buildUserSimulatorMessages,
  computeMetrics,
  decodeCqText,
  describeMedia,
  detectFabrication,
  estimateBase64Bytes,
  evaluateProbes,
  extractManualSection,
  maskSensitive,
  parseBridgeLogLine,
  parseLongrunCliArgs,
  parseOneBotMessage,
  parseReviewerOutput,
  parseUserSimulatorOutput,
  percentile,
  renderReport,
  type CollectedMessage,
  type LongrunResult,
  type LongrunTurn,
  type ScenarioBeat,
} from "./mock-longrun.js";

// ── CQ / 出站消息解析 ───────────────────────────

function textMessage(at: number, text: string): CollectedMessage {
  return {
    at,
    action: "send_private_msg",
    userId: MOCK_QQ,
    segments: [{ kind: "text", text }],
    text,
    hasMedia: false,
  };
}

describe("parseOneBotMessage（CQ 解析）", () => {
  it("解析文本 + QQ 表情 + 贴纸 + 照片 + 语音", () => {
    const sticker = "A".repeat(400); // base64 → 300 bytes，贴纸
    const photo = "A".repeat(160_000); // base64 → 120KB，照片
    const record = "B".repeat(8_000); // base64 → 6KB，语音
    const message =
      `她说&#91;笑&#93; ` +
      `[CQ:face,id=178]` +
      `[CQ:image,file=base64://${sticker}]` +
      `[CQ:image,file=base64://${photo}]` +
      `[CQ:record,file=base64://${record}]`;
    const segments = parseOneBotMessage(message);
    expect(segments.map((segment) => segment.kind)).toEqual([
      "text",
      "face",
      "image",
      "image",
      "record",
    ]);
    expect(segments[0].text).toBe("她说[笑] ");
    expect(segments[2].sticker).toBe(true);
    expect(segments[3].sticker).toBe(false);
    expect(segments[4].kind).toBe("record");
    expect(segments[4].bytes).toBeGreaterThan(0);
    // 不保留 base64 本体：文本拼接不含 file 内容
    expect(JSON.stringify(segments)).not.toContain("base64://");
  });

  it("支持 segment 数组（另有 url 型图片）", () => {
    const segments = parseOneBotMessage([
      { type: "text", data: { text: "给你看" } },
      { type: "image", data: { url: "https://example.com/a.jpg" } },
      { type: "face", data: { id: "1" } },
    ]);
    expect(segments.map((segment) => segment.kind)).toEqual(["text", "image", "face"]);
    expect(segments[1].bytes).toBeUndefined();
  });

  it("普通文本与空消息", () => {
    expect(parseOneBotMessage("晚安")).toEqual([{ kind: "text", text: "晚安" }]);
    expect(parseOneBotMessage("")).toEqual([]);
    expect(parseOneBotMessage(undefined)).toEqual([]);
  });

  it("CQ 文本反转义", () => {
    expect(decodeCqText("&amp;&#91;CQ:at&#93;&#44;x")).toBe("&[CQ:at],x");
  });

  it("estimateBase64Bytes 只认 base64://", () => {
    expect(estimateBase64Bytes("base64://AAAA")).toBe(3);
    expect(estimateBase64Bytes("https://x/a.jpg")).toBeUndefined();
  });

  it("describeMedia 区分照片/贴纸/表情/语音", () => {
    const segments = parseOneBotMessage(
      `[CQ:image,file=base64://${"A".repeat(400)}]` +
        `[CQ:image,file=base64://${"A".repeat(160_000)}]` +
        "[CQ:face,id=1][CQ:record,file=base64://BBBB]",
    );
    expect(describeMedia(segments)).toEqual(["贴纸", "照片", "表情", "语音"]);
  });
});

// ── 指标计算 ────────────────────────────────────

function makeTurn(overrides: Partial<LongrunTurn> & { outbound?: CollectedMessage[] }): LongrunTurn {
  const outbound = overrides.outbound ?? [];
  return {
    index: 1,
    beatId: "chat-1",
    tag: "chat",
    intent: "test",
    sentTexts: ["测试"],
    sentAt: 1_000,
    firstReplyAt: outbound.length > 0 ? 2_000 : null,
    latencyMs: outbound.length > 0 ? 1_000 : null,
    outbound,
    status: outbound.length > 0 ? "reply" : "no_reply",
    ...overrides,
  };
}

describe("computeMetrics", () => {
  it("回合/延迟/气泡/字数/多媒体/重复度", () => {
    const turns: LongrunTurn[] = [
      makeTurn({
        index: 1,
        outbound: [textMessage(2_000, "你好呀"), textMessage(2_100, "在干嘛")],
        latencyMs: 3_000,
        firstReplyAt: 4_000,
      }),
      makeTurn({
        index: 2,
        outbound: [
          textMessage(7_000, "哈哈😄"),
          {
            at: 7_500,
            action: "send_private_msg",
            userId: MOCK_QQ,
            segments: [{ kind: "image", bytes: 50_000, sticker: false }],
            text: "",
            hasMedia: true,
          },
          {
            at: 8_000,
            action: "send_private_msg",
            userId: MOCK_QQ,
            segments: [{ kind: "record", bytes: 6_000 }],
            text: "",
            hasMedia: true,
          },
        ],
        latencyMs: 5_000,
        firstReplyAt: 6_000,
      }),
      makeTurn({ index: 3, status: "no_reply", noReplyReason: "timeout", latencyMs: null, firstReplyAt: null }),
    ];
    const metrics = computeMetrics(turns);
    expect(metrics.turns).toBe(3);
    expect(metrics.repliedTurns).toBe(2);
    expect(metrics.noReplyTurns).toBe(1);
    expect(metrics.noReplyReasons).toEqual({ timeout: 1 });
    expect(metrics.latency.p50).toBe(3_000);
    expect(metrics.latency.p95).toBe(5_000);
    expect(metrics.latency.max).toBe(5_000);
    expect(metrics.bubbles.total).toBe(5);
    expect(metrics.bubbles.avgPerReply).toBe(2.5);
    expect(metrics.bubbles.multiBubbleTurns).toBe(2);
    expect(metrics.bubbles.multiBubbleRate).toBe(1);
    expect(metrics.text.bubbles).toBe(3);
    expect(metrics.text.avgCharsPerBubble).toBe(3.3);
    expect(metrics.emojiKaomoji).toBe(1);
    expect(metrics.media.image).toBe(1);
    expect(metrics.media.imagePhoto).toBe(1);
    expect(metrics.media.record).toBe(1);
  });

  it("产品红线扫描：AI 措辞 / 括号动作", () => {
    const turns: LongrunTurn[] = [
      makeTurn({
        outbound: [textMessage(2_000, "作为一个AI，我（笑了笑）不会累。")],
      }),
    ];
    const metrics = computeMetrics(turns);
    expect(metrics.redlines.aiPhrases).toBe(1);
    expect(metrics.redlines.bracketActions).toBe(1);
    expect(metrics.redlines.bracketSamples[0]).toBe("（笑了笑）");
  });

  it("空数组安全", () => {
    const metrics = computeMetrics([]);
    expect(metrics.turns).toBe(0);
    expect(metrics.noReplyRate).toBe(0);
    expect(metrics.latency.p50).toBe(0);
  });
});

describe("percentile", () => {
  it("最近秩百分位", () => {
    expect(percentile([], 0.5)).toBe(0);
    expect(percentile([10], 0.5)).toBe(10);
    expect(percentile([1, 2, 3, 4, 5], 0.5)).toBe(3);
    expect(percentile([1, 2, 3, 4, 5], 0.95)).toBe(5);
  });
});

// ── 探针 / 编造检测 ─────────────────────────────

describe("evaluateProbes / detectFabrication", () => {
  it("记忆探针命中与未命中", () => {
    const beats: ScenarioBeat[] = [
      { id: "p1", tag: "probe", intent: "问猫", probe: "memory-cat", expect: ["年糕"] },
      { id: "p2", tag: "probe", intent: "问出差", probe: "memory-trip", expect: ["杭州"] },
    ];
    const turns: LongrunTurn[] = [
      makeTurn({ beatId: "p1", outbound: [textMessage(2_000, "你猫叫年糕呀")] }),
      makeTurn({ beatId: "p2", outbound: [textMessage(3_000, "我忘了…")] }),
    ];
    const outcomes = evaluateProbes(turns, beats);
    expect(outcomes).toHaveLength(2);
    expect(outcomes[0].passed).toBe(true);
    expect(outcomes[1].passed).toBe(false);
    expect(outcomes[0].evidence).toContain("年糕");
  });

  it("编造检测：具体场景标记命中", () => {
    const beats: ScenarioBeat[] = [
      {
        id: "origin",
        tag: "probe",
        intent: "怎么认识",
        probe: "fabrication-origin",
        fixedText: "我们怎么认识的？",
      },
    ];
    const turns: LongrunTurn[] = [
      makeTurn({
        beatId: "origin",
        outbound: [textMessage(2_000, "我们不是在一家咖啡店认识的吗，那天还下雨。")],
      }),
    ];
    const check = detectFabrication(turns, beats);
    expect(check).not.toBeNull();
    expect(check!.flagged).toBe(true);
    expect(check!.markers).toContain("咖啡店");
  });

  it("编造检测：没有具体场景时不标记", () => {
    const beats: ScenarioBeat[] = [
      { id: "origin", tag: "probe", intent: "怎么认识", probe: "fabrication-origin" },
    ];
    const turns: LongrunTurn[] = [
      makeTurn({ beatId: "origin", outbound: [textMessage(2_000, "我们好像还没认真聊过这个。")] }),
    ];
    expect(detectFabrication(turns, beats)!.flagged).toBe(false);
  });
});

// ── 模拟器 / 评审 prompt 与解析 ─────────────────

describe("用户模拟器", () => {
  const beat: ScenarioBeat = { id: "chat", tag: "chat", intent: "吐槽老板骂人" };

  it("prompt 包含人设、意图与最近对话", () => {
    const messages = buildUserSimulatorMessages(beat, {
      recent: [{ user: ["今天好累"], her: "怎么啦，被老板说了？" }],
      facts: ["我叫阿哲，在上海张江做程序员"],
    });
    expect(messages[0].role).toBe("system");
    const serialized = JSON.stringify(messages);
    expect(serialized).toContain("阿哲");
    expect(serialized).toContain("吐槽老板骂人");
    expect(serialized).toContain("小雅");
  });

  it("解析 JSON messages", () => {
    expect(parseUserSimulatorOutput('{"messages":["在吗","今天好累"]}')).toEqual(["在吗", "今天好累"]);
  });

  it("解析纯文本兜底并去掉括号动作 / 截断过长", () => {
    const text = "（叹气）今天真的好累啊，不想动";
    const messages = parseUserSimulatorOutput(text);
    expect(messages[0]).toBe("今天真的好累啊，不想动");
    const long = parseUserSimulatorOutput("啊".repeat(80))[0];
    expect(long.length).toBeLessThanOrEqual(40);
  });

  it("空输出使用兜底文本", () => {
    expect(parseUserSimulatorOutput("", "嗯，我在呢。")).toEqual(["嗯，我在呢。"]);
  });
});

describe("LLM 评审", () => {
  it("prompt 带聊天记录与打分维度", () => {
    const messages = buildReviewerMessages([
      { index: 1, tag: "chat", user: ["在吗"], her: "在呀，怎么啦", media: [] },
    ]);
    const serialized = JSON.stringify(messages);
    expect(serialized).toContain("realism");
    expect(serialized).toContain("在呀，怎么啦");
  });

  it("解析合法 JSON 并夹取 1-5 分", () => {
    const review = parseReviewerOutput(
      '好的：{"realism":4,"coherence":9,"initiative":3,"multimedia":3,"memory":2,' +
        '"reasons":{"realism":"像真人","coherence":"有点跳","initiative":"偏被动","multimedia":"没图","memory":"记错"},"top_issues":["问题A","问题B"],"summary":"还行"}',
    );
    expect(review).not.toBeNull();
    expect(review!.realism).toBe(4);
    expect(review!.coherence).toBe(5); // 9 被夹到 5
    expect(review!.topIssues).toEqual(["问题A", "问题B"]);
    expect(review!.reasons.realism).toBe("像真人");
  });

  it("非法输出返回 null", () => {
    expect(parseReviewerOutput("我觉得还不错")).toBeNull();
    expect(parseReviewerOutput('{"realism": "x"}')).not.toBeNull();
  });
});

// ── 日志解析 ────────────────────────────────────

describe("bridge 日志解析", () => {
  it("解析 JSON 事件并按时间过滤", () => {
    const collector = new BridgeLogCollector();
    collector.append(
      '{"time":"2026-10-20T07:00:00.000Z","level":"info","scope":"qq","event":"gate.deferred_scheduled","fields":{"delay_s":30}}\n',
    );
    collector.append(
      '{"time":"2026-10-20T07:00:05.000Z","level":"error","scope":"qq","event":"reply.failed","fields":{"error":"boom"}}\n',
    );
    collector.append("普通 console.log 行\n");
    collector.flush();
    expect(collector.errorCount).toBe(1);
    expect(collector.findEventSince(Date.parse("2026-10-20T06:59:00.000Z"), "gate.deferred_scheduled")).not.toBeNull();
    expect(collector.findEventSince(Date.parse("2026-10-20T07:00:03.000Z"), "gate.deferred_scheduled")).toBeNull();
    expect(collector.errorEvents()[0].event).toBe("reply.failed");
  });

  it("非 JSON 行返回 null", () => {
    expect(parseBridgeLogLine("hello")).toBeNull();
    expect(parseBridgeLogLine('{"foo":1}')).toBeNull();
  });
});

// ── 安全红线：端口 / 隔离 / 脱敏 ─────────────────

describe("安全红线", () => {
  it("拒绝真实桥接端口", () => {
    for (const port of FORBIDDEN_PORTS) {
      expect(() => assertSafePorts(port, HEALTH_PORT)).toThrow(/端口红线/);
      expect(() => assertSafePorts(WS_PORT, port)).toThrow(/端口红线/);
    }
    expect(() => assertSafePorts(WS_PORT, WS_PORT)).toThrow(/不能相同/);
    expect(() => assertSafePorts(19180, 19181)).not.toThrow();
  });

  it("workspace 必须隔离在系统临时目录", () => {
    const parent = fs.mkdtempSync(path.join(os.tmpdir(), "karen-mock-test-"));
    const workDir = path.join(parent, "work");
    const dataDir = path.join(workDir, "data");
    fs.mkdirSync(dataDir, { recursive: true });
    try {
      expect(() => assertIsolatedWorkspace(process.cwd(), workDir, dataDir)).not.toThrow();
      // dataDir 不在 workdir 内
      expect(() => assertIsolatedWorkspace(process.cwd(), workDir, parent)).toThrow();
    } finally {
      fs.rmSync(parent, { recursive: true, force: true });
    }
  });

  it("脱敏 Key 与非 mock QQ 号", () => {
    const text = `key=sk-abcdefgh12345678 Authorization: Bearer abc123 真实QQ 123456789 mock ${MOCK_QQ}`;
    const masked = maskSensitive(text);
    expect(masked).not.toContain("sk-abcdefgh");
    expect(masked).not.toContain("123456789");
    expect(masked).toContain(String(MOCK_QQ));
  });
});

// ── 参数解析 ────────────────────────────────────

describe("parseLongrunCliArgs", () => {
  it("默认值：15 轮、daily、语音开、预算 1 元", () => {
    const options = parseLongrunCliArgs([]);
    expect(options.turns).toBe(15);
    expect(options.scenario).toBe("daily");
    expect(options.voice).toBe(true);
    expect(options.photoProbability).toBe(0.3);
    expect(options.budgetCny).toBe(1);
    expect(options.review).toBe(true);
  });

  it("解析常用参数", () => {
    const options = parseLongrunCliArgs([
      "--turns",
      "12",
      "--gap-ms",
      "8000",
      "--budget-cny",
      "0.4",
      "--out",
      "docs/x.md",
      "--keep",
      "--no-review",
      "--no-voice",
      "--photo-probability",
      "0.5",
    ]);
    expect(options.turns).toBe(12);
    expect(options.gapMs).toBe(8000);
    expect(options.budgetCny).toBe(0.4);
    expect(options.out).toBe("docs/x.md");
    expect(options.keep).toBe(true);
    expect(options.review).toBe(false);
    expect(options.voice).toBe(false);
    expect(options.photoProbability).toBe(0.5);
  });

  it("非法参数报错", () => {
    expect(() => parseLongrunCliArgs(["--turns", "0"])).toThrow();
    expect(() => parseLongrunCliArgs(["--turns", "999"])).toThrow();
    expect(() => parseLongrunCliArgs(["--scenario", "night"])).toThrow();
    expect(() => parseLongrunCliArgs(["--gap-ms", "10"])).toThrow();
    expect(() => parseLongrunCliArgs(["--unknown", "1"])).toThrow();
    expect(() => parseLongrunCliArgs(["--turns"])).toThrow();
  });
});

// ── 场景定义 ────────────────────────────────────

describe("DAILY_SCENARIO 覆盖度", () => {
  it("含 18+ 准备步骤与关键探针，且事实在探针之前", () => {
    expect(SETUP_STEPS[0].text).toBe("在吗");
    expect(SETUP_STEPS[1].text).toBe("我成年了");
    const probes = DAILY_SCENARIO.map((beat) => beat.probe).filter(Boolean);
    expect(probes).toContain("memory-cat");
    expect(probes).toContain("memory-trip");
    expect(probes).toContain("memory-name");
    expect(probes).toContain("fabrication-origin");
    const catFact = DAILY_SCENARIO.findIndex((beat) => beat.fixedText?.includes("年糕"));
    const catProbe = DAILY_SCENARIO.findIndex((beat) => beat.probe === "memory-cat");
    expect(catFact).toBeGreaterThanOrEqual(0);
    expect(catFact).toBeLessThan(catProbe);
    const tripFact = DAILY_SCENARIO.findIndex((beat) => beat.fixedText?.includes("杭州"));
    const tripProbe = DAILY_SCENARIO.findIndex((beat) => beat.probe === "memory-trip");
    expect(tripFact).toBeGreaterThanOrEqual(0);
    expect(tripFact).toBeLessThan(tripProbe);
  });

  it("默认 15 轮即可覆盖所有探针", () => {
    const first15 = DAILY_SCENARIO.slice(0, 15).map((beat) => beat.probe).filter(Boolean);
    expect(first15).toContain("memory-cat");
    expect(first15).toContain("memory-trip");
    expect(first15).toContain("memory-name");
    expect(first15).toContain("fabrication-origin");
  });
});

// ── 报告渲染 ────────────────────────────────────

function makeResult(overrides: Partial<LongrunResult> = {}): LongrunResult {
  const turns: LongrunTurn[] = [
    makeTurn({
      index: 1,
      beatId: DAILY_SCENARIO[0].id,
      tag: DAILY_SCENARIO[0].tag,
      outbound: [textMessage(2_000, "你好呀，阿哲"), textMessage(2_200, "今天过得怎么样")],
      latencyMs: 3_000,
    }),
    makeTurn({
      index: 2,
      beatId: "probe-cat",
      tag: "probe",
      outbound: [textMessage(6_000, "你猫叫年糕")],
      latencyMs: 2_000,
    }),
  ];
  return {
    ok: true,
    tag: "unit-test",
    startedAt: new Date("2026-10-20T07:00:00Z").toISOString(),
    finishedAt: new Date("2026-10-20T07:05:00Z").toISOString(),
    durationMs: 300_000,
    scenario: "daily",
    turnsPlanned: 15,
    turnsRun: 2,
    budgetCny: 0.5,
    budgetExceeded: false,
    voiceEnabled: true,
    photoProbability: 0.3,
    isolation: {
      workDir: "/tmp/karen-mock-longrun-test",
      dataDir: "/tmp/karen-mock-longrun-test/data",
      wsUrl: "ws://127.0.0.1:19180/onebot/v11/ws",
      healthUrl: "http://127.0.0.1:19181",
      kept: false,
      repoDataDir: "/repo/data",
    },
    setup: { ok: true, detail: "年龄门通过", turns: 2 },
    turns,
    metrics: computeMetrics(turns),
    probes: [
      {
        key: "memory-cat",
        beatId: "probe-cat",
        question: "我猫叫啥？",
        expect: ["年糕"],
        passed: true,
        evidence: "你猫叫年糕",
      },
    ],
    fabrication: null,
    cost: {
      bridge: {
        total: { calls: 10, cost_cny: 0.1, prompt_tokens: 1_000, completion_tokens: 100, cached_tokens: 0, reasoning_tokens: 0 },
        by_kind: [{ kind: "chat", calls: 5, cost_cny: 0.08 }],
      },
      simulator: { calls: 2, promptTokens: 200, completionTokens: 20, costCny: 0.001 },
      reviewer: { calls: 1, promptTokens: 300, completionTokens: 30, costCny: 0.002 },
      totalCny: 0.103,
    },
    bridgeErrors: { count: 0, events: [], outputTail: "" },
    review: {
      realism: 4,
      coherence: 4,
      initiative: 3,
      multimedia: 3,
      memory: 4,
      reasons: { realism: "像真人", coherence: "连贯", initiative: "偏被动", multimedia: "一般", memory: "记得住" },
      topIssues: ["回复偏长"],
      summary: "总体自然",
    },
    reviewError: null,
    autoObservations: ["自动观察 A"],
    transcript: [
      { index: 1, tag: "chat", user: ["在吗"], her: "你好呀，阿哲", media: [] },
    ],
    health: { db_ok: true, ws_connections: 1, pending_replies: 0, cost_today: 0.1 },
    notes: [],
    ...overrides,
  };
}

describe("renderReport / manual section", () => {
  it("渲染报告包含关键指标与成本", () => {
    const report = renderReport(makeResult(), null);
    expect(report).toContain("Karen 真实验证台报告");
    expect(report).toContain("19180");
    expect(report).toContain("100000001");
    expect(report).toContain("¥0.1030");
    expect(report).toContain("LLM 评审");
    expect(report).toContain("MANUAL:BEGIN");
    expect(report).toContain("记忆探针");
  });

  it("重跑时保留上一版人工观察段落", () => {
    const existing = [
      "# 旧报告",
      "<!-- MANUAL:BEGIN -->",
      "## 人工观察",
      "- 我发现：她的回复偏长",
      "<!-- MANUAL:END -->",
    ].join("\n");
    const report = renderReport(makeResult(), existing);
    expect(report).toContain("她的回复偏长");
    expect(extractManualSection(existing)).toContain("她的回复偏长");
    expect(extractManualSection("没有标记")).toBeNull();
  });

  it("预算触顶与 no_reply 会在摘要中提示", () => {
    const turns = [
      makeTurn({ status: "no_reply", noReplyReason: "deferred", latencyMs: null, firstReplyAt: null }),
    ];
    const result = makeResult({ turns, metrics: computeMetrics(turns), budgetExceeded: true });
    const report = renderReport(result, null);
    expect(report).toContain("deferred");
    expect(report).toContain("触顶");
  });
});

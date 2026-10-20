import Database from "better-sqlite3";
import { beforeEach, describe, expect, it } from "vitest";
import {
  buildDailyDigestPrompt,
  buildWeeklySummary,
  computeDueJobs,
  localDayKey,
  parseDailyDigest,
  pickDayMessages,
  runDailyDigest,
  runWeeklyRollup,
  shiftDayKey,
  weekStartOf,
  type ChatLine,
} from "./jobs.js";
import { ensureMemoryV2Schema, listRecentDigests, markJobRun, wasJobRun } from "../data/memory-v2.js";

const PERSONA = "小雅";
const OWNER = "qq:1";

let db: Database.Database;
beforeEach(() => {
  db = new Database(":memory:");
  ensureMemoryV2Schema(db);
});

function msg(role: "user" | "assistant", content: string, at: string, hour = 12): ChatLine {
  const [y, m, d] = at.split("-").map(Number);
  return { role, content, timestamp: new Date(y, m - 1, d, hour, 0, 0, 0).getTime() };
}

describe("日期工具", () => {
  it("本地日期 key 与偏移", () => {
    const t = new Date(2026, 9, 20, 15, 0).getTime();
    expect(localDayKey(t)).toBe("2026-10-20");
    expect(shiftDayKey("2026-10-20", -1)).toBe("2026-10-19");
    expect(shiftDayKey("2026-03-01", -1)).toBe("2026-02-28");
  });

  it("周起点是周一（含跨月/跨年）", () => {
    expect(weekStartOf("2026-10-20")).toBe("2026-10-19"); // 周二 → 周一
    expect(weekStartOf("2026-10-19")).toBe("2026-10-19"); // 周一 → 自己
    expect(weekStartOf("2026-10-25")).toBe("2026-10-19"); // 周日 → 周一
  });
});

describe("日记忆 prompt 与解析", () => {
  it("按天挑消息，其余天不混入", () => {
    const messages = [
      msg("user", "昨天的消息", "2026-10-19"),
      msg("user", "今天的消息", "2026-10-20"),
    ];
    const picked = pickDayMessages(messages, "2026-10-20");
    expect(picked).toHaveLength(1);
    expect(picked[0].content).toBe("今天的消息");
  });

  it("prompt 里带日期与双方台词，且要求只写片段内内容", () => {
    const prompt = buildDailyDigestPrompt("2026-10-20", [
      msg("user", "今天被老板骂了", "2026-10-20"),
      msg("assistant", "抱抱，先别想了", "2026-10-20"),
    ]);
    expect(prompt.user).toContain("2026-10-20");
    expect(prompt.user).toContain("他：今天被老板骂了");
    expect(prompt.user).toContain("你：抱抱，先别想了");
    expect(prompt.system).toContain("不要编造");
  });

  it("解析 JSON（容忍代码块与前后说明），字段超长会截断", () => {
    const raw = '好的：\n```json\n{"summary":"他加班到很晚，情绪不好","mood":"有点累","events":["加班","被老板催"],"open_threads":["明天要不要早点睡"]}\n```';
    const parsed = parseDailyDigest(raw);
    expect(parsed?.summary).toContain("加班");
    expect(parsed?.mood).toBe("有点累");
    expect(parsed?.events).toHaveLength(2);
    expect(parsed?.openThreads?.[0]).toContain("早点睡");
  });

  it("坏 JSON / 空 summary 返回 null", () => {
    expect(parseDailyDigest("not json")).toBeNull();
    expect(parseDailyDigest('{"summary":""}')).toBeNull();
    expect(parseDailyDigest("")).toBeNull();
  });
});

describe("runDailyDigest：幂等与失败兜底", () => {
  const messages = [
    msg("user", "今天被老板骂了", "2026-10-20"),
    msg("assistant", "抱抱", "2026-10-20"),
  ];

  it("成功写入日记忆并标记跑过", async () => {
    const result = await runDailyDigest({
      db,
      personaId: PERSONA,
      ownerId: OWNER,
      dayKey: "2026-10-20",
      messages,
      chatFn: async () => '{"summary":"他被老板骂了，心情不好","mood":"低落","events":["被老板骂"],"open_threads":[]}',
      now: new Date(2026, 9, 21, 0, 30).getTime(),
    });
    expect(result).toMatchObject({ ok: true });
    expect(wasJobRun(db, "daily_digest", "2026-10-20")).toBe(true);
    const digests = listRecentDigests(db, PERSONA, OWNER);
    expect(digests[0].summary).toContain("老板");
  });

  it("同一天重复调用直接跳过（不重复花 token）", async () => {
    let calls = 0;
    const chatFn = async () => {
      calls += 1;
      return '{"summary":"x"}';
    };
    await runDailyDigest({ db, personaId: PERSONA, ownerId: OWNER, dayKey: "2026-10-20", messages, chatFn });
    const again = await runDailyDigest({
      db,
      personaId: PERSONA,
      ownerId: OWNER,
      dayKey: "2026-10-20",
      messages,
      chatFn,
    });
    expect(again.reason).toBe("already_done");
    expect(calls).toBe(1);
  });

  it("当天没消息不写、也不标记跑过", async () => {
    const result = await runDailyDigest({
      db,
      personaId: PERSONA,
      ownerId: OWNER,
      dayKey: "2026-10-18",
      messages,
      chatFn: async () => '{"summary":"x"}',
    });
    expect(result.reason).toBe("no_messages");
    expect(wasJobRun(db, "daily_digest", "2026-10-18")).toBe(false);
  });

  it("模型返回坏 JSON 时不写、不标记（下次还会重试）", async () => {
    const result = await runDailyDigest({
      db,
      personaId: PERSONA,
      ownerId: OWNER,
      dayKey: "2026-10-20",
      messages,
      chatFn: async () => "抱歉我不会",
    });
    expect(result.reason).toBe("parse_failed");
    expect(wasJobRun(db, "daily_digest", "2026-10-20")).toBe(false);
  });

  it("模型调用抛错被兜住", async () => {
    const result = await runDailyDigest({
      db,
      personaId: PERSONA,
      ownerId: OWNER,
      dayKey: "2026-10-20",
      messages,
      chatFn: async () => {
        throw new Error("boom");
      },
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("chat_failed");
  });
});

describe("周汇总", () => {
  it("把一周的日记忆拼起来，并带上未完成话题", () => {
    const summary = buildWeeklySummary([
      {
        id: 1,
        persona_id: PERSONA,
        owner_id: OWNER,
        day: "2026-10-19",
        summary: "他加班",
        mood: null,
        events_json: "[]",
        open_threads_json: '["周末看电影"]',
        created_at: 0,
      },
      {
        id: 2,
        persona_id: PERSONA,
        owner_id: OWNER,
        day: "2026-10-20",
        summary: "他生病了",
        mood: null,
        events_json: "[]",
        open_threads_json: "[]",
        created_at: 0,
      },
    ]);
    expect(summary).toContain("10-19 他加班");
    expect(summary).toContain("10-20 他生病了");
    expect(summary).toContain("还没聊完：周末看电影");
  });

  it("写周汇总幂等", () => {
    const first = runWeeklyRollup({ db, personaId: PERSONA, ownerId: OWNER, weekStart: "2026-10-19" });
    expect(first.reason).toBe("no_digests");
    // 先造一条日记忆
    db.prepare(
      `INSERT INTO daily_digests (persona_id, owner_id, day, summary, created_at) VALUES (?,?,?,?,?)`,
    ).run(PERSONA, OWNER, "2026-10-20", "他加班", Date.now());
    expect(runWeeklyRollup({ db, personaId: PERSONA, ownerId: OWNER, weekStart: "2026-10-19" }).ok).toBe(true);
    expect(runWeeklyRollup({ db, personaId: PERSONA, ownerId: OWNER, weekStart: "2026-10-19" }).reason).toBe(
      "already_done",
    );
  });
});

describe("computeDueJobs：到期与补跑", () => {
  it("凌晨 00:05 还不跑昨天（等 00:10）", () => {
    const now = new Date(2026, 9, 21, 0, 5).getTime();
    const due = computeDueJobs({ db, personaId: PERSONA, ownerId: OWNER, now });
    expect(due.dailyDigestDays).not.toContain("2026-10-20");
  });

  it("凌晨 00:15 会补昨天；再跑一次就不会重复", () => {
    const now = new Date(2026, 9, 21, 0, 15).getTime();
    const first = computeDueJobs({ db, personaId: PERSONA, ownerId: OWNER, now });
    expect(first.dailyDigestDays).toContain("2026-10-20");
    // 标记昨天已跑
    markJobRun(db, "daily_digest", "2026-10-20");
    const second = computeDueJobs({ db, personaId: PERSONA, ownerId: OWNER, now });
    expect(second.dailyDigestDays).not.toContain("2026-10-20");
  });

  it("关机几天后启动，会一次补多天（默认回看 3 天）", () => {
    const now = new Date(2026, 9, 25, 9, 0).getTime();
    const due = computeDueJobs({ db, personaId: PERSONA, ownerId: OWNER, now });
    expect(due.dailyDigestDays).toEqual(["2026-10-24", "2026-10-23", "2026-10-22"]);
  });

  it("周一 00:40 会补上一周的周汇总", () => {
    const now = new Date(2026, 9, 19, 0, 40).getTime(); // 2026-10-19 是周一
    const due = computeDueJobs({ db, personaId: PERSONA, ownerId: OWNER, now });
    expect(due.weeklyRollupWeeks).toContain("2026-10-12");
  });
});

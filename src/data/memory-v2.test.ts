import Database from "better-sqlite3";
import { beforeEach, describe, expect, it } from "vitest";
import {
  addAnchor,
  getInitiativePlan,
  markInitiativeReplied,
  recentInitiativeReplyCount,
  recordInitiativeSent,
  saveInitiativePlan,
  buildAnchorInjection,
  buildDailyInjection,
  ensureMemoryV2Schema,
  expireAnchor,
  inferAnchorKind,
  listAnchors,
  listRecentDigests,
  markJobRun,
  formatWeeklyInjection,
  scoreSalience,
  summarizeAnchor,
  touchAnchors,
  upsertDailyDigest,
  wasJobRun,
} from "./memory-v2.js";

const PERSONA = "小雅";
const OWNER = "qq:1";

function freshDb(): Database.Database {
  const db = new Database(":memory:");
  db.exec(`CREATE TABLE user_facts (owner_id TEXT, fact_key TEXT, fact_value TEXT, category TEXT, updated_at INTEGER)`);
  db.exec(`CREATE TABLE t2_episodes (id INTEGER PRIMARY KEY, content TEXT)`);
  ensureMemoryV2Schema(db);
  return db;
}

let db: Database.Database;
beforeEach(() => {
  db = freshDb();
});

describe("ensureMemoryV2Schema", () => {
  it("建表 + 加列，且可重复执行（幂等）", () => {
    ensureMemoryV2Schema(db);
    ensureMemoryV2Schema(db);
    const tables = (
      db.prepare(`SELECT name FROM sqlite_master WHERE type='table'`).all() as Array<{ name: string }>
    ).map((r) => r.name);
    for (const t of ["memory_anchors", "daily_digests", "weekly_rollups", "job_runs"]) {
      expect(tables).toContain(t);
    }
    const factCols = (db.prepare(`PRAGMA table_info(user_facts)`).all() as Array<{ name: string }>).map(
      (c) => c.name,
    );
    expect(factCols).toEqual(expect.arrayContaining(["confidence", "status", "source_quote", "confirmed_at"]));
    const epCols = (db.prepare(`PRAGMA table_info(t2_episodes)`).all() as Array<{ name: string }>).map(
      (c) => c.name,
    );
    expect(epCols).toEqual(expect.arrayContaining(["salience", "heat", "anchor_id"]));
  });

  it("原表不存在时也不抛错（老库/测试环境）", () => {
    const bare = new Database(":memory:");
    expect(() => ensureMemoryV2Schema(bare)).not.toThrow();
    bare.close();
  });
});

describe("scoreSalience：显著度", () => {
  it("普通闲聊分数低（<0.5）", () => {
    expect(scoreSalience({ content: "今天天气不错" }).score).toBeLessThan(0.5);
  });

  it("承诺/约定类明显更高", () => {
    const plain = scoreSalience({ content: "今天天气不错" }).score;
    const promise = scoreSalience({ content: "说好了周末一起去看电影" });
    expect(promise.score).toBeGreaterThan(plain);
    expect(promise.reasons).toContain("承诺/约定");
  });

  it("情绪强度参与打分", () => {
    const calm = scoreSalience({ content: "今天有点累", emotionVector: 0.05 }).score;
    const strong = scoreSalience({ content: "今天有点累", emotionVector: -0.8 }).score;
    expect(strong).toBeGreaterThan(calm);
  });

  it("秘密/表白/失去权重更高", () => {
    expect(scoreSalience({ content: "只跟你说个事" }).reasons).toContain("秘密");
    expect(scoreSalience({ content: "我好像喜欢你了" }).reasons).toContain("表白/亲密表达");
    expect(scoreSalience({ content: "我奶奶上个月走了" }).reasons).toContain("失去/离开");
  });

  it("她的内心独白降权（不作为共同经历的主要来源）", () => {
    const chat = scoreSalience({ content: "说好了下次一起去", source: "chat" }).score;
    const mono = scoreSalience({ content: "说好了下次一起去", source: "internal_monologue" }).score;
    expect(mono).toBeLessThan(chat);
  });

  it("结果始终夹在 0-1", () => {
    const high = scoreSalience({
      content: "说好了下次一起，只跟你说，我好像喜欢你了，我奶奶走了",
      emotionVector: 1,
    }).score;
    expect(high).toBeLessThanOrEqual(1);
    expect(high).toBeGreaterThanOrEqual(0);
  });
});

describe("inferAnchorKind / summarizeAnchor", () => {
  it("按内容判断锚点类型", () => {
    expect(inferAnchorKind("我奶奶上个月走了")).toBe("loss");
    expect(inferAnchorKind("我们吵架了，我有点生气")).toBe("conflict");
    expect(inferAnchorKind("对不起，我错了")).toBe("makeup");
    expect(inferAnchorKind("只跟你说个秘密")).toBe("secret");
    expect(inferAnchorKind("我好像有点喜欢你")).toBe("confession");
    expect(inferAnchorKind("说好了周末一起看电影")).toBe("promise");
    expect(inferAnchorKind("那天我们一起看的夕阳")).toBe("shared_experience");
  });

  it("摘要截断到指定字数并加省略号", () => {
    const s = summarizeAnchor("一".repeat(40), 10);
    expect(Array.from(s)).toHaveLength(11); // 10 字 + …
    expect(summarizeAnchor("短句", 30)).toBe("短句");
  });
});

describe("锚点 CRUD", () => {
  it("写入后能按强度/新近取回", () => {
    addAnchor(db, { personaId: PERSONA, ownerId: OWNER, kind: "promise", summary: "说好周末看电影", strength: 0.9 });
    addAnchor(db, { personaId: PERSONA, ownerId: OWNER, kind: "conflict", summary: "上次吵架了", strength: 0.5 });
    const list = listAnchors(db, PERSONA, OWNER);
    expect(list).toHaveLength(2);
    expect(list[0].summary).toBe("说好周末看电影");
  });

  it("同一件事重复提到只保留一条，且强度上升", () => {
    addAnchor(db, { personaId: PERSONA, ownerId: OWNER, kind: "promise", summary: "说好周末看电影", strength: 0.6 });
    addAnchor(db, { personaId: PERSONA, ownerId: OWNER, kind: "promise", summary: "说好周末看电影", strength: 0.6 });
    const list = listAnchors(db, PERSONA, OWNER);
    expect(list).toHaveLength(1);
    expect(list[0].strength).toBeCloseTo(0.7, 5);
  });

  it("不同 owner 互不可见（多用户隔离）", () => {
    addAnchor(db, { personaId: PERSONA, ownerId: "qq:1", kind: "promise", summary: "A 的事" });
    addAnchor(db, { personaId: PERSONA, ownerId: "qq:2", kind: "promise", summary: "B 的事" });
    expect(listAnchors(db, PERSONA, "qq:1").map((a) => a.summary)).toEqual(["A 的事"]);
    expect(listAnchors(db, PERSONA, "qq:2").map((a) => a.summary)).toEqual(["B 的事"]);
  });

  it("expire 之后不再出现在列表里（双时间轴：不删只标记）", () => {
    const id = addAnchor(db, { personaId: PERSONA, ownerId: OWNER, kind: "promise", summary: "说好周末看电影" })!;
    expireAnchor(db, id);
    expect(listAnchors(db, PERSONA, OWNER)).toHaveLength(0);
    const row = db.prepare(`SELECT valid_to FROM memory_anchors WHERE id = ?`).get(id) as {
      valid_to: number | null;
    };
    expect(row.valid_to).toBeGreaterThan(0);
  });

  it("touch 会累计被回忆次数", () => {
    const id = addAnchor(db, { personaId: PERSONA, ownerId: OWNER, kind: "promise", summary: "说好周末看电影" })!;
    touchAnchors(db, [id, id]);
    const row = db.prepare(`SELECT recall_count FROM memory_anchors WHERE id = ?`).get(id) as {
      recall_count: number;
    };
    expect(row.recall_count).toBe(2);
  });

  it("注入片段带类型标签，且空列表不产生内容", () => {
    addAnchor(db, { personaId: PERSONA, ownerId: OWNER, kind: "promise", summary: "说好周末看电影" });
    const text = buildAnchorInjection(listAnchors(db, PERSONA, OWNER));
    expect(text).toContain("你记得的关键时刻");
    expect(text).toContain("[约定] 说好周末看电影");
    expect(buildAnchorInjection([])).toBe("");
  });
});

describe("日记忆与调度记录", () => {
  it("同一天的摘要会覆盖更新，不会重复", () => {
    upsertDailyDigest(db, { personaId: PERSONA, ownerId: OWNER, day: "2026-10-20", summary: "第一次版本" });
    upsertDailyDigest(db, { personaId: PERSONA, ownerId: OWNER, day: "2026-10-20", summary: "第二次版本" });
    const list = listRecentDigests(db, PERSONA, OWNER);
    expect(list).toHaveLength(1);
    expect(list[0].summary).toBe("第二次版本");
  });

  it("按日期倒序取最近 N 天，注入时按时间正序", () => {
    upsertDailyDigest(db, { personaId: PERSONA, ownerId: OWNER, day: "2026-10-19", summary: "昨天" });
    upsertDailyDigest(db, { personaId: PERSONA, ownerId: OWNER, day: "2026-10-20", summary: "今天" });
    const recent = listRecentDigests(db, PERSONA, OWNER, 3);
    expect(recent[0].day).toBe("2026-10-20");
    const text = buildDailyInjection(recent);
    expect(text.indexOf("2026-10-19")).toBeLessThan(text.indexOf("2026-10-20"));
  });

  it("主动计划：按天存/取/覆盖，不同 owner 隔离", () => {
    saveInitiativePlan(db, { personaId: PERSONA, ownerId: OWNER, day: "2026-10-20", planJson: '{"items":[]}' });
    expect(getInitiativePlan(db, PERSONA, OWNER, "2026-10-20")?.plan_json).toContain("items");
    expect(getInitiativePlan(db, PERSONA, "qq:9", "2026-10-20")).toBeNull();
    saveInitiativePlan(db, { personaId: PERSONA, ownerId: OWNER, day: "2026-10-20", planJson: '{"items":[1]}' });
    expect(getInitiativePlan(db, PERSONA, OWNER, "2026-10-20")?.plan_json).toContain("[1]");
  });

  it("主动统计：发送计数与「他回了」标记只作用于之前的记录", () => {
    recordInitiativeSent(db, OWNER, 1000);
    recordInitiativeSent(db, OWNER, 2000);
    expect(recentInitiativeReplyCount(db, OWNER)).toBe(0);
    markInitiativeReplied(db, OWNER, 1500);
    expect(recentInitiativeReplyCount(db, OWNER)).toBe(1);
    // 1500 之后的（2000）仍然未回
    markInitiativeReplied(db, OWNER, 2001);
    expect(recentInitiativeReplyCount(db, OWNER)).toBe(2);
    expect(recentInitiativeReplyCount(db, "qq:other")).toBe(0);
  });

  it("任务记录幂等（同 job+period 只算跑过）", () => {
    expect(wasJobRun(db, "daily_digest", "2026-10-20")).toBe(false);
    markJobRun(db, "daily_digest", "2026-10-20");
    expect(wasJobRun(db, "daily_digest", "2026-10-20")).toBe(true);
    expect(wasJobRun(db, "daily_digest", "2026-10-21")).toBe(false);
  });
});

describe("scoreSalience：至亲离世必须能记住（v0.8.15 真实冒烟驱动）", () => {
  const score = (content: string) => scoreSalience({ content, source: "chat", emotionVector: 0 }).score;

  it("「我奶奶上个月走了」→ 达到 0.75 阈值（能成为锚点）", () => {
    expect(score("我奶奶上个月走了。这件事我还没跟别人说过，晚上经常想她。")).toBeGreaterThanOrEqual(0.75);
  });

  it("「去世/过世/离世/病逝」等明确表达都能记住", () => {
    for (const word of ["去世", "过世", "离世", "病逝"]) {
      expect(score(`我爷爷上个月${word}了`), word).toBeGreaterThanOrEqual(0.75);
    }
  });

  it("含糊的「我先走了 / 没电了」不能被当成失去事件（避免什么都记）", () => {
    expect(score("太晚了，我先走了")).toBeLessThan(0.75);
    expect(score("手机没电了")).toBeLessThan(0.75);
  });

  it("承诺 + 共同经历仍然是强信号（原有行为不变）", () => {
    expect(score("我们约好了下个月一起去看海")).toBeGreaterThanOrEqual(0.75);
  });
});

describe("formatWeeklyInjection（v0.8.18）", () => {
  it("有周汇总 → 生成一小段注入文本，带周起点与时间提醒", () => {
    const text = formatWeeklyInjection({
      week_start: "2026-10-12",
      summary: "他月底要上线晚风信箱项目；被老板谈话；橘猫团子踩坏键盘",
    });
    expect(text).toContain("上一周大概");
    expect(text).toContain("2026-10-12");
    expect(text).toContain("晚风信箱");
    expect(text).toContain("别当成这两天刚发生的");
  });

  it("超长摘要被压到 140 字以内（不能抢锚点/日记忆的 prompt 预算）", () => {
    const text = formatWeeklyInjection({ week_start: "2026-10-12", summary: "长".repeat(500) });
    const body = text.replace(/\s+/g, "");
    expect(Array.from(body).length).toBeLessThan(200);
  });

  it("没有周汇总 → 空串（不注入）", () => {
    expect(formatWeeklyInjection(null)).toBe("");
    expect(formatWeeklyInjection({ week_start: "2026-10-12", summary: "   " })).toBe("");
  });
});

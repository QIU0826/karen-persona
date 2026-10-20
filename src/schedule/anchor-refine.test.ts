import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import {
  REFINE_MIN_SALIENCE,
  buildAnchorRefinePrompt,
  parseAnchorVerdicts,
  runAnchorRefine,
  selectRefineCandidates,
} from "./anchor-refine.js";
import { ensureMemoryV2Schema, listAnchors } from "../data/memory-v2.js";

function makeDb(): InstanceType<typeof Database> {
  const db = new Database(":memory:");
  // 复筛读 t2_episodes（由 vector.migrate 建表）+ 锚点表（memory-v2 建）
  db.exec(`
    CREATE TABLE t2_episodes (
      id INTEGER PRIMARY KEY,
      persona_id TEXT NOT NULL,
      role TEXT,
      content TEXT NOT NULL,
      salience REAL,
      anchor_id INTEGER,
      created_at TEXT NOT NULL
    );
  `);
  ensureMemoryV2Schema(db);
  return db;
}

function insertEpisode(
  db: Database,
  input: { personaId: string; content: string; salience: number; createdAt: number },
): number {
  const info = db
    .prepare(
      `INSERT INTO t2_episodes (persona_id, role, content, salience, created_at)
       VALUES (?, 'user', ?, ?, ?)`,
    )
    .run(input.personaId, input.content, input.salience, input.createdAt);
  return Number(info.lastInsertRowid);
}

const T0 = "2026-10-19 12:00:00";

describe("selectRefineCandidates", () => {
  it("只挑边界显著度、且未被锚点记录的", () => {
    const rows = [
      { id: 1, content: "约好周末看电影", salience: 0.6, anchor_id: null, created_at: T0 },
      { id: 2, content: "今天好热", salience: 0.2, anchor_id: null, created_at: T0 },
      { id: 3, content: "我已经是锚点了", salience: 0.7, anchor_id: 9, created_at: T0 },
      { id: 4, content: "太高不用复筛", salience: 0.9, anchor_id: null, created_at: T0 },
    ];
    const picked = selectRefineCandidates(rows);
    expect(picked.map((c) => c.id)).toEqual([1]);
    expect(picked[0].salience).toBeGreaterThanOrEqual(REFINE_MIN_SALIENCE);
  });

  it("截断过长内容，最多 12 条", () => {
    const rows = Array.from({ length: 20 }, (_, i) => ({
      id: i + 1,
      content: "很长的内容" + "啊".repeat(300),
      salience: 0.5,
      anchor_id: null,
      created_at: T0,
    }));
    const picked = selectRefineCandidates(rows);
    expect(picked).toHaveLength(12);
    expect(picked[0].content.length).toBeLessThanOrEqual(120);
  });
});

describe("buildAnchorRefinePrompt", () => {
  it("带编号候选与判断规则", () => {
    const prompt = buildAnchorRefinePrompt({
      day: "2026-10-19",
      herName: "小雅",
      userName: "你",
      candidates: [
        { id: 1, content: "约好周末看电影", salience: 0.6, createdAt: T0 },
        { id: 2, content: "我妈住院了", salience: 0.55, createdAt: T0 },
      ],
    });
    expect(prompt.user).toContain("0. [显著度0.60] 约好周末看电影");
    expect(prompt.user).toContain("1. [显著度0.55] 我妈住院了");
    expect(prompt.system).toContain("值得记");
    expect(prompt.system).toContain("不要脑补");
  });
});

describe("parseAnchorVerdicts", () => {
  it("只保留 anchor=true，非法 kind 降级，越界 index 丢弃", () => {
    const content = JSON.stringify({
      items: [
        { index: 0, anchor: true, kind: "promise", summary: "约好周末看电影" },
        { index: 1, anchor: false, kind: "promise", summary: "日常闲聊" },
        { index: 2, anchor: true, kind: "随便写的", summary: "我妈住院了" },
        { index: 99, anchor: true, kind: "promise", summary: "越界" },
        { index: 3, anchor: true, kind: "promise", summary: "" },
      ],
    });
    const verdicts = parseAnchorVerdicts(content, 4);
    // index 0(收)、1(拒，保留)、2(收，kind 降级)；99 越界丢弃；3 summary 空且拒收 → 丢
    expect(verdicts).toHaveLength(3);
    expect(verdicts[0].kind).toBe("promise");
    expect(verdicts[1].anchor).toBe(false);
    expect(verdicts[2].kind).toBe("shared_experience");
  });

  it("坏 JSON / 非数组返回空", () => {
    expect(parseAnchorVerdicts("nope", 3)).toEqual([]);
    expect(parseAnchorVerdicts('{"items":{}}', 3)).toEqual([]);
  });
});

describe("runAnchorRefine", () => {
  it("候选不足 2 条时不调用模型", async () => {
    const db = makeDb();
    insertEpisode(db, { personaId: "p", content: "约好周末看电影", salience: 0.6, createdAt: T0 });
    let called = 0;
    const result = await runAnchorRefine({
      db,
      personaId: "p",
      ownerId: "o",
      day: "2026-10-19",
      chatFn: async () => {
        called += 1;
        return null;
      },
      now: T0,
    });
    expect(called).toBe(0);
    expect(result.reason).toBe("no_candidates");
  });

  it("模型判断后写入锚点（拒绝的不写）", async () => {
    const db = makeDb();
    const day = "2026-10-19";
      insertEpisode(db, { personaId: "p", content: "约好周末一起去看电影", salience: 0.6, createdAt: "2026-10-19 10:00:00" });
    insertEpisode(db, { personaId: "p", content: "今天好热啊", salience: 0.5, createdAt: "2026-10-19 11:00:00" });

    const result = await runAnchorRefine({
      db,
      personaId: "p",
      ownerId: "o",
      day,
      chatFn: async () =>
        JSON.stringify({
          items: [
            { index: 0, anchor: true, kind: "promise", summary: "约好周末一起去看电影" },
            { index: 1, anchor: false, kind: "shared_experience", summary: "今天好热" },
          ],
        }),
      now: new Date(2026, 9, 20, 12).getTime(),
    });

    expect(result.reason).toBe("done");
    expect(result.created).toBe(1);
    const anchors = listAnchors(db, "p", "o");
    expect(anchors).toHaveLength(1);
    expect(anchors[0].summary).toContain("电影");
    expect(anchors[0].kind).toBe("promise");
  });

  it("全部拒绝是正常结果（done，created=0），不算解析失败", async () => {
    const db = makeDb();
    insertEpisode(db, { personaId: "p", content: "今天好热", salience: 0.6, createdAt: "2026-10-19 09:00:00" });
    insertEpisode(db, { personaId: "p", content: "有点困", salience: 0.5, createdAt: "2026-10-19 10:00:00" });
    const result = await runAnchorRefine({
      db, personaId: "p", ownerId: "o", day: "2026-10-19",
      chatFn: async () =>
        JSON.stringify({
          items: [
            { index: 0, anchor: false, kind: "shared_experience", summary: "天气闲聊" },
            { index: 1, anchor: false, kind: "shared_experience", summary: "日常状态" },
          ],
        }),
    });
    expect(result.reason).toBe("done");
    expect(result.created).toBe(0);
    expect(listAnchors(db, "p", "o")).toHaveLength(0);
  });

  it("模型失败返回 llm_failed 且不写库", async () => {
    const db = makeDb();
    insertEpisode(db, { personaId: "p", content: "a", salience: 0.6, createdAt: "2026-10-19 09:00:00" });
    insertEpisode(db, { personaId: "p", content: "b", salience: 0.6, createdAt: "2026-10-19 10:00:00" });
    const result = await runAnchorRefine({
      db, personaId: "p", ownerId: "o", day: "2026-10-19",
      chatFn: async () => null,
    });
    expect(result.reason).toBe("llm_failed");
    expect(listAnchors(db, "p", "o")).toHaveLength(0);
  });

  it("只看当天（前一天的不参与）", async () => {
    const db = makeDb();
    insertEpisode(db, { personaId: "p", content: "前天的", salience: 0.6, createdAt: "2026-10-18 12:00:00" });
    insertEpisode(db, { personaId: "p", content: "当天的A", salience: 0.6, createdAt: "2026-10-19 09:00:00" });
    insertEpisode(db, { personaId: "p", content: "当天的B", salience: 0.6, createdAt: "2026-10-19 10:00:00" });
    let promptSeen = "";
    await runAnchorRefine({
      db, personaId: "p", ownerId: "o", day: "2026-10-19",
      chatFn: async (p) => {
        promptSeen = p.user;
        return JSON.stringify({ items: [] });
      },
    });
    expect(promptSeen).toContain("当天的A");
    expect(promptSeen).not.toContain("前天的");
  });
});

describe("复筛幂等与计数（v0.8.17 真实冒烟驱动）", () => {
  function makeDb() {
    const Database = require("better-sqlite3") as typeof import("better-sqlite3");
    const db = new Database(":memory:");
    db.exec(`
      CREATE TABLE memory_anchors (
        id INTEGER PRIMARY KEY AUTOINCREMENT, persona_id TEXT, owner_id TEXT, kind TEXT,
        summary TEXT, quote TEXT, strength REAL, recall_count INTEGER DEFAULT 0,
        source_msg_ids TEXT, created_at INTEGER, valid_from INTEGER, valid_to INTEGER
      );
      CREATE TABLE t2_episodes (
        id INTEGER PRIMARY KEY AUTOINCREMENT, persona_id TEXT, content TEXT, source TEXT,
        strength REAL, emotional_weight REAL, half_life_days REAL, salience REAL,
        anchor_id INTEGER, created_at TEXT
      );
    `);
    return db;
  }

  const seed = (db: ReturnType<typeof makeDb>) => {
    db.prepare(
      `INSERT INTO t2_episodes (persona_id, content, source, strength, emotional_weight, half_life_days, salience, anchor_id, created_at)
       VALUES ('xiaoya','他爸住院下周手术他睡不好','chat',1,0.2,30,0.7,NULL,'2026-10-20 20:00:00'),
              ('xiaoya','他说想辞职做独立开发','chat',1,0.2,30,0.65,NULL,'2026-10-20 21:00:00')`,
    ).run();
  };
  const fakeChat = async () =>
    JSON.stringify({
      items: [
        { index: 0, anchor: true, kind: "loss", summary: "他爸住院手术" },
        { index: 1, anchor: true, kind: "promise", summary: "想辞职独立开发" },
      ],
    });

  it("第一次跑：created 等于真正新建的锚点数", async () => {
    const db = makeDb();
    seed(db);
    const { runAnchorRefine } = await import("./anchor-refine.js");
    const result = await runAnchorRefine({
      db: db as never,
      personaId: "xiaoya",
      ownerId: "cli:local",
      day: "2026-10-20",
      chatFn: fakeChat,
    });
    expect(result).toMatchObject({ ok: true, candidates: 2, created: 2 });
    db.close();
  });

  it("守卫丢失后重跑：episode 已回写 anchor_id → 不再进候选（不重复花 LLM）", async () => {
    const db = makeDb();
    seed(db);
    const { runAnchorRefine } = await import("./anchor-refine.js");
    await runAnchorRefine({
      db: db as never,
      personaId: "xiaoya",
      ownerId: "cli:local",
      day: "2026-10-20",
      chatFn: fakeChat,
    });
    // 模拟 job_runs 丢失（不在脚本里建守卫），直接再跑
    const again = await runAnchorRefine({
      db: db as never,
      personaId: "xiaoya",
      ownerId: "cli:local",
      day: "2026-10-20",
      chatFn: fakeChat,
    });
    expect(again.candidates).toBe(0);
    expect(again.created).toBe(0);
    db.close();
  });

  it("同 summary 已存在时，复述强化不计入 created", async () => {
    const db = makeDb();
    seed(db);
    const { runAnchorRefine } = await import("./anchor-refine.js");
    await runAnchorRefine({
      db: db as never,
      personaId: "xiaoya",
      ownerId: "cli:local",
      day: "2026-10-20",
      chatFn: fakeChat,
    });
    // 手动把 episode 的 anchor_id 清掉（模拟老数据/回写失败），再跑一次
    db.prepare("UPDATE t2_episodes SET anchor_id = NULL").run();
    const again = await runAnchorRefine({
      db: db as never,
      personaId: "xiaoya",
      ownerId: "cli:local",
      day: "2026-10-20",
      chatFn: fakeChat,
    });
    expect(again.candidates).toBe(2);
    expect(again.created).toBe(0); // 锚点已存在 → 只是强化，不算新建
    db.close();
  });
});

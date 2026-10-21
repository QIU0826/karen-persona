import Database from "better-sqlite3";
import { beforeEach, describe, expect, it } from "vitest";
import { ensureMemoryV2Schema } from "./memory-v2.js";
import { getDailyLife, listRecentDailyLife, saveDailyLife } from "./daily-life.js";

const PERSONA = "小雅";
const OWNER = "qq:1";

function freshDb(): Database.Database {
  const db = new Database(":memory:");
  ensureMemoryV2Schema(db);
  return db;
}

let db: Database.Database;
beforeEach(() => {
  db = freshDb();
});

describe("daily_life 存储（v0.9.6）", () => {
  it("写入后能读回同一天的生活流", () => {
    saveDailyLife(db, {
      personaId: PERSONA,
      ownerId: OWNER,
      day: "2026-10-21",
      lifeJson: JSON.stringify({ day: "2026-10-21", events: [{ hour: 9, kind: "work", text: "店里来了个熟客" }] }),
      now: 123,
    });
    const row = getDailyLife(db, PERSONA, OWNER, "2026-10-21");
    expect(row?.life_json).toContain("店里来了个熟客");
    expect(row?.created_at).toBe(123);
  });

  it("同一天重复写入会覆盖（幂等）", () => {
    const write = (text: string) =>
      saveDailyLife(db, {
        personaId: PERSONA,
        ownerId: OWNER,
        day: "2026-10-21",
        lifeJson: JSON.stringify({ day: "2026-10-21", events: [{ hour: 9, kind: "work", text }] }),
      });
    write("第一版");
    write("第二版");
    expect(getDailyLife(db, PERSONA, OWNER, "2026-10-21")?.life_json).toContain("第二版");
  });

  it("不同 owner 互不串（多用户隔离）", () => {
    saveDailyLife(db, {
      personaId: PERSONA,
      ownerId: "qq:1",
      day: "2026-10-21",
      lifeJson: JSON.stringify({ day: "2026-10-21", events: [{ hour: 9, kind: "work", text: "A 的生活" }] }),
    });
    expect(getDailyLife(db, PERSONA, "qq:2", "2026-10-21")).toBeNull();
    saveDailyLife(db, {
      personaId: PERSONA,
      ownerId: "qq:2",
      day: "2026-10-21",
      lifeJson: JSON.stringify({ day: "2026-10-21", events: [{ hour: 9, kind: "work", text: "B 的生活" }] }),
    });
    expect(getDailyLife(db, PERSONA, "qq:1", "2026-10-21")?.life_json).toContain("A 的生活");
  });

  it("最近 N 天按天倒序，最多 7 天", () => {
    for (let i = 1; i <= 9; i++) {
      saveDailyLife(db, {
        personaId: PERSONA,
        ownerId: OWNER,
        day: `2026-10-${String(i).padStart(2, "0")}`,
        lifeJson: JSON.stringify({ day: `2026-10-${String(i).padStart(2, "0")}`, events: [] }),
      });
    }
    const recent = listRecentDailyLife(db, PERSONA, OWNER, 20);
    expect(recent).toHaveLength(7);
    expect(recent[0]?.day).toBe("2026-10-09");
  });
});

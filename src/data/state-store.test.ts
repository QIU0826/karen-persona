/**
 * M1-1 人格运行时状态持久化测试。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "karen-state-"));
  process.env.KAREN_DATA_DIR = dir;
  vi.resetModules();
});

afterEach(() => {
  delete process.env.KAREN_DATA_DIR;
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    // ignore
  }
});

describe("state-store", () => {
  it("保存后可完整加载（情绪/关系/因果链/计数/天气）", async () => {
    const m = await import("./state-store.js");
    const { applyRelationshipEvent } = await import("../persona/relationship.js");

    const state = m.createPersistedPersonaState("小雅", 3);
    state.emotion.vector = 0.42;
    state.guilt.guilt = 0.3;
    state.drift.actualBaseline = 0.05;
    state.relationship = applyRelationshipEvent(state.relationship, 0.6, "深度对话", new Date("2026-10-19T21:00:00+08:00"));
    state.counters.consecutiveSilences = 2;
    state.counters.lastSharedWeather = "雨";
    state.weather = {
      raw: { condition: "雨", temp: 18, humidity: 80, description: "小雨", city: "上海" },
      fetchedAt: 123456789,
    };

    m.savePersonaState(state);
    const loaded = m.loadPersonaState("小雅");

    expect(loaded).not.toBeNull();
    expect(loaded!.emotion.vector).toBeCloseTo(0.42, 2);
    expect(loaded!.guilt.guilt).toBeCloseTo(0.3, 2);
    expect(loaded!.drift.actualBaseline).toBeCloseTo(0.05, 2);
    expect(loaded!.relationship.closeness).toBeCloseTo(3.6, 2);
    expect(loaded!.relationship.milestones.map((x) => x.id)).toContain("getting-familiar");
    expect(loaded!.counters.consecutiveSilences).toBe(2);
    expect(loaded!.counters.lastSharedWeather).toBe("雨");
    expect(loaded!.weather?.raw.condition).toBe("雨");
  });

  it("文件不存在返回 null", async () => {
    const m = await import("./state-store.js");
    expect(m.loadPersonaState("不存在")).toBeNull();
  });

  it("字段缺失/部分损坏时用默认值补齐而不是崩溃", async () => {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, "persona-state-小雅.json"),
      JSON.stringify({ emotion: { vector: 99 }, relationship: { closeness: 6.5 } }),
      "utf-8",
    );

    const m = await import("./state-store.js");
    const loaded = m.loadPersonaState("小雅", 3);

    expect(loaded).not.toBeNull();
    expect(loaded!.emotion.vector).toBe(1);
    expect(loaded!.relationship.closeness).toBe(6.5);
    expect(loaded!.guilt.guilt).toBe(0);
    expect(loaded!.counters.consecutiveSilences).toBe(0);
  });

  it("完全损坏的 JSON 会备份并返回 null", async () => {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "persona-state-小雅.json"), "{broken", "utf-8");

    const m = await import("./state-store.js");
    expect(m.loadPersonaState("小雅")).toBeNull();
    expect(fs.readdirSync(dir).some((f) => f.includes(".corrupt-"))).toBe(true);
  });
});

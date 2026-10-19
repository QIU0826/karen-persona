/**
 * 成本统计单测：DeepSeek 峰谷价 / 缓存命中 / flash vs pro / SQLite 记录与 7 日摘要。
 * 使用 KAREN_DATA_DIR 临时目录，不联网、不触碰仓库 data/。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/** 2026-10-19 是周一；北京时间 10:00 = 高峰 */
const MONDAY_PEAK = Date.parse("2026-10-19T02:00:00Z");
/** 同一周一北京时间 20:00 = 低峰 */
const MONDAY_OFF_PEAK = Date.parse("2026-10-19T12:00:00Z");
/** 2026-10-24 是周六，任何时间低峰 */
const SATURDAY_NOON_BEIJING = Date.parse("2026-10-24T04:00:00Z");

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "karen-cost-"));
  process.env.KAREN_DATA_DIR = dir;
  vi.resetModules();
});

afterEach(() => {
  delete process.env.KAREN_DATA_DIR;
  vi.resetModules();
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    // ignore
  }
});

async function loadModules() {
  const cost = await import("./cost-tracker.js");
  const vector = await import("../data/vector.js");
  return { cost, vector };
}

describe("峰谷判断 isPeakTime（北京时间工作日 9-12 / 14-18）", () => {
  it("工作日高峰/边界", async () => {
    const { cost } = await loadModules();
    expect(cost.isPeakTime(MONDAY_PEAK)).toBe(true); // 10:00
    expect(cost.isPeakTime(Date.parse("2026-10-19T00:59:00Z"))).toBe(false); // 08:59
    expect(cost.isPeakTime(Date.parse("2026-10-19T01:00:00Z"))).toBe(true); // 09:00 边界
    expect(cost.isPeakTime(Date.parse("2026-10-19T04:00:00Z"))).toBe(false); // 12:00 边界
    expect(cost.isPeakTime(Date.parse("2026-10-19T06:00:00Z"))).toBe(true); // 14:00
    expect(cost.isPeakTime(Date.parse("2026-10-19T10:00:00Z"))).toBe(false); // 18:00 边界
  });

  it("周末按低峰", async () => {
    const { cost } = await loadModules();
    expect(cost.isPeakTime(SATURDAY_NOON_BEIJING)).toBe(false);
    expect(cost.isPeakTime(Date.parse("2026-10-25T02:00:00Z"))).toBe(false); // 周日 10:00
  });
});

describe("computeCostCny（元/百万 tokens）", () => {
  it("flash：高峰/低峰未命中输入 + 输出", async () => {
    const { cost } = await loadModules();
    // 高峰：1M 未命中输入 × 2 + 1M 输出 × 8 = 10 元
    expect(
      cost.computeCostCny({
        model: "deepseek-flash",
        promptTokens: 1_000_000,
        completionTokens: 1_000_000,
        at: MONDAY_PEAK,
      })
    ).toBeCloseTo(10, 6);
    // 低峰（半价）= 5 元
    expect(
      cost.computeCostCny({
        model: "deepseek-flash",
        promptTokens: 1_000_000,
        completionTokens: 1_000_000,
        at: MONDAY_OFF_PEAK,
      })
    ).toBeCloseTo(5, 6);
  });

  it("pro：高峰/低峰价格明显更高", async () => {
    const { cost } = await loadModules();
    expect(
      cost.computeCostCny({
        model: "deepseek-v4-pro",
        promptTokens: 1_000_000,
        completionTokens: 1_000_000,
        at: MONDAY_PEAK,
      })
    ).toBeCloseTo(36, 6); // 9 + 27
    expect(
      cost.computeCostCny({
        model: "deepseek-v4-pro",
        promptTokens: 1_000_000,
        completionTokens: 1_000_000,
        at: MONDAY_OFF_PEAK,
      })
    ).toBeCloseTo(18, 6); // 4.5 + 13.5
  });

  it("缓存命中按命中价计费（远低于未命中）", async () => {
    const { cost } = await loadModules();
    expect(
      cost.computeCostCny({
        model: "deepseek-flash",
        promptTokens: 1_000_000,
        cachedTokens: 1_000_000,
        at: MONDAY_PEAK,
      })
    ).toBeCloseTo(0.04, 6);
    expect(
      cost.computeCostCny({
        model: "deepseek-flash",
        promptTokens: 1_000_000,
        cachedTokens: 1_000_000,
        at: MONDAY_OFF_PEAK,
      })
    ).toBeCloseTo(0.02, 6);
    expect(
      cost.computeCostCny({
        model: "deepseek-v4-pro",
        promptTokens: 1_000_000,
        cachedTokens: 1_000_000,
        at: MONDAY_PEAK,
      })
    ).toBeCloseTo(0.3, 6);
  });

  it("混合缓存命中/未命中 + 输出", async () => {
    const { cost } = await loadModules();
    // 0.4M 命中 × 0.04 + 0.6M 未命中 × 2 + 0.5M 输出 × 8 = 0.016 + 1.2 + 4 = 5.216
    expect(
      cost.computeCostCny({
        model: "deepseek-flash",
        promptTokens: 1_000_000,
        cachedTokens: 400_000,
        cacheMissTokens: 600_000,
        completionTokens: 500_000,
        at: MONDAY_PEAK,
      })
    ).toBeCloseTo(5.216, 6);
  });

  it("reasoning tokens 已含在 completion 内，不重复计费；负数/缺失按 0", async () => {
    const { cost } = await loadModules();
    const withReasoning = cost.computeCostCny({
      model: "deepseek-flash",
      promptTokens: 0,
      completionTokens: 1_000_000,
      reasoningTokens: 900_000,
      at: MONDAY_PEAK,
    });
    expect(withReasoning).toBeCloseTo(8, 6);
    expect(
      cost.computeCostCny({ model: "deepseek-flash", promptTokens: -5, completionTokens: -1, at: MONDAY_PEAK })
    ).toBe(0);
  });
});

describe("recordLlmUsage + 摘要", () => {
  it("懒建 llm_usage 表：首次记录前数据目录可无 DB", async () => {
    const { cost, vector } = await loadModules();
    expect(fs.existsSync(path.join(dir, "memory.sqlite"))).toBe(false);

    const at = Date.now();
    const recordedCost = cost.recordLlmUsage({
      model: "deepseek-flash",
      kind: "chat",
      promptTokens: 1_000_000,
      completionTokens: 1_000_000,
      cachedTokens: 0,
      reasoningTokens: 0,
      latencyMs: 1234,
      at,
    });

    expect(recordedCost).toBeGreaterThan(0);
    expect(fs.existsSync(path.join(dir, "memory.sqlite"))).toBe(true);

    const db = vector.getVectorDb();
    const row = db
      .prepare("SELECT * FROM llm_usage ORDER BY id DESC LIMIT 1")
      .get() as Record<string, unknown>;
    expect(row.model).toBe("deepseek-flash");
    expect(row.kind).toBe("chat");
    expect(row.prompt_tokens).toBe(1_000_000);
    expect(row.completion_tokens).toBe(1_000_000);
    expect(row.latency_ms).toBe(1234);
    expect(row.total_tokens).toBe(2_000_000);
    expect(Number(row.cost_cny)).toBeCloseTo(recordedCost, 6);
    vector.closeVectorDb();
  });

  it("记录 peak 标记与 reasoning tokens", async () => {
    const { cost, vector } = await loadModules();
    cost.recordLlmUsage({ model: "deepseek-flash", promptTokens: 10, completionTokens: 5, at: MONDAY_PEAK });
    cost.recordLlmUsage({ model: "deepseek-flash", promptTokens: 10, completionTokens: 5, at: MONDAY_OFF_PEAK });
    cost.recordLlmUsage({
      model: "deepseek-v4-pro",
      promptTokens: 10,
      completionTokens: 5,
      reasoningTokens: 4,
      at: MONDAY_PEAK,
    });

    const rows = vector
      .getVectorDb()
      .prepare("SELECT model, peak, reasoning_tokens FROM llm_usage ORDER BY id")
      .all() as Array<{ model: string; peak: number; reasoning_tokens: number }>;
    expect(rows.map((row) => row.peak)).toEqual([1, 0, 1]);
    expect(rows[2].reasoning_tokens).toBe(4);
    expect(rows[2].model).toBe("deepseek-v4-pro");
    vector.closeVectorDb();
  });

  it("getTodayCostSummary 汇总当日调用数与成本", async () => {
    const { cost, vector } = await loadModules();
    const at = Date.now();
    const first = cost.recordLlmUsage({
      model: "deepseek-flash",
      promptTokens: 1000,
      completionTokens: 500,
      cachedTokens: 400,
      at,
    });
    const second = cost.recordLlmUsage({
      model: "deepseek-v4-pro",
      promptTokens: 2000,
      completionTokens: 800,
      latencyMs: 900,
      at,
    });

    const summary = cost.getTodayCostSummary(at);
    expect(summary.calls).toBe(2);
    expect(summary.cost_cny).toBeCloseTo(first + second, 6);
    expect(summary.prompt_tokens).toBe(3000);
    expect(summary.completion_tokens).toBe(1300);
    expect(summary.cached_tokens).toBe(400);
    expect(summary.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    vector.closeVectorDb();
  });

  it("getCostReport(7)：补齐 7 天、总计与按模型聚合", async () => {
    const { cost, vector } = await loadModules();
    const at = Date.now();
    cost.recordLlmUsage({ model: "deepseek-flash", promptTokens: 100, completionTokens: 50, at });
    cost.recordLlmUsage({ model: "deepseek-flash", promptTokens: 200, completionTokens: 60, at });
    cost.recordLlmUsage({ model: "deepseek-v4-pro", promptTokens: 300, completionTokens: 70, at });

    const report = cost.getCostReport(7, at);
    expect(report.window_days).toBe(7);
    expect(report.by_day).toHaveLength(7);
    expect(report.total.calls).toBe(3);
    expect(report.total.cost_cny).toBeGreaterThan(0);
    // 最后一天是今天
    expect(report.by_day[6].calls).toBe(3);
    expect(report.by_day.slice(0, 6).every((day) => day.calls === 0)).toBe(true);
    const modelNames = report.by_model.map((bucket) => bucket.model).sort();
    expect(modelNames).toEqual(["deepseek-flash", "deepseek-v4-pro"]);
    vector.closeVectorDb();
  });

  it("成本记录跨模块重载仍可见（SQLite 持久化）", async () => {
    const { cost, vector } = await loadModules();
    const at = Date.now();
    cost.recordLlmUsage({ model: "deepseek-flash", promptTokens: 500, completionTokens: 200, at });
    const before = cost.getTodayCostSummary(at);
    expect(before.calls).toBe(1);
    vector.closeVectorDb();

    vi.resetModules();
    const reloaded = await import("./cost-tracker.js");
    const after = reloaded.getTodayCostSummary(at);
    expect(after.calls).toBe(1);
    expect(after.cost_cny).toBeCloseTo(before.cost_cny, 6);
  });
});

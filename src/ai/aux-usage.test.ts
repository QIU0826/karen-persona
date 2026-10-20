/**
 * 旁路 LLM 用量记账单测（临时数据目录；不联网）。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "karen-aux-"));
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

describe("recordAuxUsage", () => {
  it("把旁路调用的 usage 写入 llm_usage，并出现在 by_kind", async () => {
    const { recordAuxUsage } = await import("./aux-usage.js");
    const { getCostReport } = await import("../obs/cost-tracker.js");

    const wrote = recordAuxUsage(
      { kind: "fact_extraction", model: "deepseek-flash", startedAtMs: Date.now() },
      {
        prompt_tokens: 120,
        completion_tokens: 30,
        prompt_cache_hit_tokens: 20,
        prompt_cache_miss_tokens: 100,
      },
    );
    expect(wrote).toBe(true);

    const report = getCostReport(7);
    const bucket = report.by_kind.find((item) => item.kind === "fact_extraction");
    expect(bucket?.calls).toBe(1);
    expect(report.total.prompt_tokens).toBe(120);
    expect(report.total.completion_tokens).toBe(30);
    expect(report.total.cached_tokens).toBe(20);
  });

  it("无 usage 时不写记录（不估算/不造假）", async () => {
    const { recordAuxUsage } = await import("./aux-usage.js");
    const { getCostReport } = await import("../obs/cost-tracker.js");

    expect(
      recordAuxUsage({ kind: "vision", model: "deepseek-flash", startedAtMs: Date.now() }, null),
    ).toBe(false);
    expect(getCostReport(7).total.calls).toBe(0);
  });
});

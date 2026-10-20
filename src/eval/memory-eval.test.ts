/**
 * 记忆评测 harness 的离线测试。
 *
 * 约束：
 * - 不联网：强制 ngram + fetch stub，live 只测「无 Key 时报错」的守卫；
 * - 不污染真实 data/：全部跑在 mkdtemp 目录，测试后清理；
 * - env 用 vi.stubEnv + unstubAllEnvs 恢复，避免 vitest 并行测试之间串环境。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  evaluateLive,
  evaluateOffline,
  loadGoldCases,
  validateGoldCases,
} from "./memory-eval.js";

const createdDirs = new Set<string>();

function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "karen-memory-eval-test-"));
  createdDirs.add(dir);
  return dir;
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  for (const dir of createdDirs) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // 清理失败不影响断言
    }
  }
  createdDirs.clear();
});

describe("memory-gold 金标集", () => {
  it("至少 20 条、覆盖 7 类、direct/indirect 都有、expect 可从 fact 推出", () => {
    const cases = loadGoldCases();
    validateGoldCases(cases);

    expect(cases.length).toBeGreaterThanOrEqual(20);
    const categories = new Set(cases.map((item) => item.category));
    expect([...categories].sort()).toEqual(
      ["姓名", "城市", "工作", "宠物", "项目", "偏好", "计划"].sort()
    );
    expect(cases.some((item) => item.type === "direct")).toBe(true);
    expect(cases.some((item) => item.type === "indirect")).toBe(true);
    expect(new Set(cases.map((item) => item.id)).size).toBe(cases.length);

    // 每条 case 至少有一个 expect 子串能从注入事实里推导出来，
    // 否则这条 gold 的「事实命中」永远不可能成立。
    const factText = cases.map((item) => item.fact.value).join("\n");
    for (const item of cases) {
      expect(
        item.expect.some((expect) => factText.includes(expect)),
        `${item.id} 的 expect 不在任何 fact value 中`
      ).toBe(true);
    }
  });
});

describe("evaluateOffline", () => {
  it("离线跑通、指标自洽、临时目录清理、env 恢复、不联网", { timeout: 60_000 }, () => {
    const originalDataDir = path.join(os.tmpdir(), "karen-memory-eval-original");
    vi.stubEnv("KAREN_DATA_DIR", originalDataDir);
    vi.stubEnv("EMBEDDING_PROVIDER", "ngram");
    // 任何真实网络请求都会让这个 stub 抛错；离线 harness 不应触发 fetch。
    const fetchStub = vi.fn(() => {
      throw new Error("offline eval must not use network");
    });
    vi.stubGlobal("fetch", fetchStub);

    const dataDir = makeTempDir();
    const result = evaluateOffline({ dataDir });
    const cases = loadGoldCases();

    expect(fetchStub).not.toHaveBeenCalled();
    expect(result.cleanedUp).toBe(true);
    expect(fs.existsSync(dataDir)).toBe(false);
    expect(process.env.KAREN_DATA_DIR).toBe(originalDataDir);
    expect(process.env.EMBEDDING_PROVIDER).toBe("ngram");

    // 种子规模与 gold 一致（唯一 fact / 唯一 statement）
    expect(result.seeded.facts).toBe(new Set(cases.map((item) => item.fact.key)).size);
    expect(result.seeded.episodes).toBe(new Set(cases.map((item) => item.statement)).size);

    // 指标自洽：facts 全覆盖（评测侧显式放开注入上限，测的是事实层而不是注入预算）；
    // recall 单调；合并 ≥ facts；总数正确
    expect(result.metrics.total).toBe(cases.length);
    expect(result.metrics.factsHits).toBe(cases.length);
    expect(result.metrics.factsHitRate).toBe(1);
    expect(result.metrics.mergedHits).toBe(cases.length);
    expect(result.metrics.mergedHitRate).toBe(1);
    expect(result.metrics.recallHits.at1).toBeLessThanOrEqual(result.metrics.recallHits.at3);
    expect(result.metrics.recallHits.at3).toBeLessThanOrEqual(result.metrics.recallHits.at8);
    // 具体百分比由报告如实记录；测试只要求非零，避免数据层调参把测试变成脆快照。
    expect(result.metrics.recallHits.at8).toBeGreaterThan(0);
    expect(result.metrics.direct.total + result.metrics.indirect.total).toBe(cases.length);
    expect(Object.keys(result.metrics.categories)).toHaveLength(7);

    // anti-forget：即使「我不知道」记忆排第一，正确事实仍必须被注入/合并检索到
    expect(result.antiForget).not.toBeNull();
    expect(result.antiForget?.factsHit).toBe(true);
    expect(result.antiForget?.mergedHit).toBe(true);
    expect(result.antiForget?.passed).toBe(true);
    expect(result.antiForget?.denialRank).not.toBeNull();
  });

  it("拒绝把真实 data/ 或仓库根当评测目录", { timeout: 10_000 }, () => {
    expect(() => evaluateOffline({ dataDir: path.resolve("data") })).toThrow(/真实数据目录/);
    expect(() => evaluateOffline({ dataDir: path.resolve(".") })).toThrow(/仓库根/);
  });

  it("同一进程重复运行，指标完全可复现", { timeout: 60_000 }, () => {
    vi.stubEnv("EMBEDDING_PROVIDER", "ngram");
    const fetchStub = vi.fn(() => {
      throw new Error("offline eval must not use network");
    });
    vi.stubGlobal("fetch", fetchStub);

    const first = evaluateOffline();
    const second = evaluateOffline();

    expect(fetchStub).not.toHaveBeenCalled();
    expect(first.cleanedUp).toBe(true);
    expect(second.cleanedUp).toBe(true);
    expect(second.metrics).toEqual(first.metrics);
    expect(second.failures.map((item) => item.id)).toEqual(first.failures.map((item) => item.id));
    expect(second.antiForget).toEqual(first.antiForget);
  });
});

describe("evaluateLive 守卫", () => {
  it("没有 DEEPSEEK_API_KEY 时快速失败，不建库、不联网", { timeout: 10_000 }, async () => {
    vi.stubEnv("DEEPSEEK_API_KEY", "");
    await expect(evaluateLive()).rejects.toThrow(/DEEPSEEK_API_KEY/);
  });
});

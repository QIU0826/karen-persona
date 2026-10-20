/**
 * 真实 QQ 长跑观察：报告计算 + 只读快照采集 + CLI 落报告。
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildRealRunReport,
  collectRealRunSnapshot,
  formatRealRunReportMarkdown,
  readLatestSession,
  type RealRunSnapshot,
} from "./qq-realrun.js";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const TSX_CLI = path.join(REPO_ROOT, "node_modules/tsx/dist/cli.mjs");
const WATCH_CLI = path.join(REPO_ROOT, "scripts/qq-longrun-watch.ts");

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "karen-realrun-"));
  process.env.KAREN_DATA_DIR = dir;
  vi.resetModules();
});

afterEach(async () => {
  try {
    const vector = await import("../data/vector.js");
    vector.closeVectorDb();
  } catch {
    // ignore
  }
  delete process.env.KAREN_DATA_DIR;
  vi.resetModules();
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    // ignore
  }
});

function snapshot(overrides: Partial<RealRunSnapshot> = {}): RealRunSnapshot {
  return {
    capturedAt: 10_000,
    personaName: "小雅",
    storageKey: "",
    messages: [
      { role: "user", content: "测试消息一", timestamp: 1_000 },
      { role: "assistant", content: "回复一", timestamp: 2_500 },
      { role: "user", content: "测试消息二", timestamp: 3_000 },
      { role: "assistant", content: "回复一", timestamp: 7_000 },
      { role: "user", content: "测试消息三", timestamp: 8_000 },
      { role: "assistant", content: "  ", timestamp: 9_000 },
    ],
    usage: [
      {
        kind: "chatStream",
        model: "deepseek-flash",
        prompt_tokens: 100,
        completion_tokens: 20,
        cached_tokens: 60,
        cost_cny: 0.001,
        created_at: 1_500,
        latency_ms: 1_200,
      },
      {
        kind: "fact_extraction",
        model: "deepseek-flash",
        prompt_tokens: 50,
        completion_tokens: 10,
        cached_tokens: 0,
        cost_cny: 0.0005,
        created_at: 4_000,
        latency_ms: 800,
      },
    ],
    facts: [{ ownerId: "qq:1", key: "name", value: "林哲" }],
    consent: null,
    ...overrides,
  };
}

describe("buildRealRunReport", () => {
  it("计算回合/延迟/重复/空回复/成本/记忆标记", () => {
    const report = buildRealRunReport(snapshot());
    expect(report.turnCount).toBe(3);
    expect(report.latency).toEqual({ avgMs: 2167, p95Ms: 4000, maxMs: 4000, samples: 3 });
    expect(report.quality.duplicateReplies).toBe(1);
    expect(report.quality.emptyReplies).toBe(1);
    expect(report.cost.totalCny).toBeCloseTo(0.0015, 6);
    expect(report.cost.calls).toBe(2);
    expect(report.cost.promptTokens).toBe(150);
    expect(report.cost.cachedTokens).toBe(60);
    expect(report.cost.byKind[0]).toEqual({ kind: "chatStream", calls: 1, costCny: 0.001 });
    expect(report.memory).toEqual({
      facts: 1,
      hasConsent: false,
      ageConfirmed: false,
      disclosureAcked: false,
    });
    expect(report.flags).toContain("有 1 条空回复");
    expect(report.flags).toContain("有 1 条重复回复");
    expect(report.flags.some((flag) => flag.includes("18+"))).toBe(true);
    // 仅一个事实，不触发「多轮无事实」提示；延迟正常，不触发 >5s
    expect(report.flags.some((flag) => flag.includes("事实"))).toBe(false);
  });

  it("sinceMs 只统计窗口内回合与成本；无成本记录时给提示", () => {
    const report = buildRealRunReport(snapshot(), { sinceMs: 5_000 });
    expect(report.turnCount).toBe(1);
    expect(report.messageCount).toBe(3);
    expect(report.cost.calls).toBe(0);
    expect(report.cost.totalCny).toBe(0);
    expect(report.flags).toContain("有对话但没有成本记录（usage 未落库）");
  });
});

describe("collectRealRunSnapshot", () => {
  it("只读采集会话/usage/事实/同意；since 过滤新数据", async () => {
    const history = await import("../data/history.js");
    const cost = await import("../obs/cost-tracker.js");
    const facts = await import("../data/user-facts.js");
    const consent = await import("../data/consent.js");

    const session = history.loadSession("小雅", "");
    history.addMessage(session, "user", "今晚吃什么");
    history.addMessage(session, "assistant", "随便啊，你想吃啥");
    cost.recordLlmUsage({
      model: "deepseek-flash",
      kind: "chatStream",
      promptTokens: 10,
      completionTokens: 5,
      at: 1_000,
    });
    facts.upsertUserFacts("qq:1", [{ key: "name", value: "林哲", category: "profile" }]);
    consent.confirmAge("qq:1");
    consent.ackDisclosure("qq:1");

    const all = collectRealRunSnapshot({ sinceMs: 0 });
    expect(all.personaName).toBe("小雅");
    expect(all.storageKey).toBe("");
    expect(all.messages).toHaveLength(2);
    expect(all.usage).toHaveLength(1);
    expect(all.facts).toHaveLength(1);
    expect(all.consent?.ageConfirmedAt).toBeTruthy();
    expect(all.consent?.disclosureAckedAt).toBeTruthy();

    const future = collectRealRunSnapshot({ sinceMs: Date.now() + 60_000 });
    expect(future.messages).toHaveLength(0);
    expect(future.usage).toHaveLength(0);
    // 事实/同意是当前状态，不按 since 过滤
    expect(future.facts).toHaveLength(1);
    expect(future.consent).not.toBeNull();
  });

  it("数据目录不存在/无 DB 时安全返回空", () => {
    const empty = collectRealRunSnapshot({ dataDirOverride: path.join(dir, "nope"), sinceMs: 0 });
    expect(empty.messages).toEqual([]);
    expect(empty.usage).toEqual([]);
    expect(empty.facts).toEqual([]);
    expect(empty.consent).toBeNull();
  });

  it("readLatestSession 可按人设名选择会话文件", async () => {
    const history = await import("../data/history.js");
    const session = history.loadSession("小雅", "");
    history.addMessage(session, "user", "你好");
    const found = readLatestSession(dir, "小雅");
    expect(found?.personaName).toBe("小雅");
    expect(found?.messages[0].content).toBe("你好");
    expect(readLatestSession(dir, "不存在")).toBeNull();
  });
});

describe("formatRealRunReportMarkdown", () => {
  it("包含关键字段与标记", () => {
    const md = formatRealRunReportMarkdown(buildRealRunReport(snapshot()));
    expect(md).toContain("真实 QQ 长跑观察报告");
    expect(md).toContain("平均 2167ms");
    expect(md).toContain("空回复 1");
    expect(md).toContain("事实 1 条");
    expect(md).toContain("⚠️");
  });
});

describe("qq-longrun-watch CLI", () => {
  it(
    "短时长观察结束后写出 JSON/MD 报告",
    async () => {
      const dataDir = path.join(dir, "data");
      const child = spawn(
        process.execPath,
        [TSX_CLI, WATCH_CLI, "--duration", "1", "--interval", "1"],
        {
          cwd: REPO_ROOT,
          env: { ...process.env, KAREN_DATA_DIR: dataDir },
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
      let output = "";
      child.stdout.on("data", (chunk: Buffer) => {
        output += chunk.toString();
      });
      child.stderr.on("data", (chunk: Buffer) => {
        output += chunk.toString();
      });
      const code = await new Promise<number | null>((resolve, reject) => {
        const timer = setTimeout(() => {
          child.kill("SIGKILL");
          reject(new Error(`watch CLI 超时\n${output}`));
        }, 20_000);
        child.on("exit", (exitCode) => {
          clearTimeout(timer);
          resolve(exitCode);
        });
      });
      expect(code).toBe(0);
      expect(output).toContain("真实 QQ 长跑观察");
      expect(output).toContain("观察结束");
      const files = fs.readdirSync(dataDir);
      expect(files.some((file) => file.startsWith("realrun-") && file.endsWith(".json"))).toBe(true);
      expect(files.some((file) => file.startsWith("realrun-") && file.endsWith(".md"))).toBe(true);
      const md = fs.readFileSync(
        path.join(dataDir, files.find((file) => file.endsWith(".md"))!),
        "utf-8",
      );
      expect(md).toContain("真实 QQ 长跑观察报告");
    },
    30_000,
  );
});

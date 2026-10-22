/**
 * 文档数字 ↔ 代码事实核对（v0.8.22）。
 *
 * 背景：发布过程中反复出现「文档写 1233、实测 1232」「文档写 1254、实测 1252」这类漂移。
 * 这轮把 README / CLAUDE / CAPABILITY_MATRIX 里**可机器核对**的数字断言集中起来，
 * 与代码常量、资产文件、评测阈值逐一对照，防止文档越写越飘。
 *
 * 原则：只核对「能自动判定真假」的；需要真实模型跑的指标（如 live 95–100%）不在这里断言。
 */
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { MAX_COLLECTED_STICKERS, MAX_STICKER_BYTES } from "../data/sticker-library.js";
import { DEFAULT_HEALTH_PORT, DEFAULT_ONE_BOT_WS_PORT, DEFAULT_WEB_PORT } from "../data/store.js";
import { COMPRESSION_BATCH_SIZE, COMPRESSION_MIN_COUNT } from "../evolution/t3-summarizer.js";

const ROOT = process.cwd();
const read = (rel: string): string => fs.readFileSync(path.join(ROOT, rel), "utf-8");
const DOCS = {
  readme: read("README.md"),
  claude: read("CLAUDE.md"),
  matrix: read("docs/CAPABILITY_MATRIX.md"),
};
/** 所有对外文档合起来的文本（断言"至少在对外文档里说过这个数字"） */
const ALL_DOCS = Object.values(DOCS).join("\n");
const readSrc = (rel: string): string => read(path.join("src", rel));

/** 数某个目录下除 README 外的文件数 */
function countAssets(dir: string): number {
  return fs
    .readdirSync(path.join(ROOT, dir))
    .filter((name) => name !== "README.md" && !name.startsWith(".")).length;
}

describe("资产数量与文档宣称一致", () => {
  it("本地图库：实际张数 == 文档写的 29 张", () => {
    const count = countAssets("assets/photos");
    expect(count, "assets/photos 里的图数量变了，记得同步 README/CLAUDE").toBe(29);
    expect(ALL_DOCS).toContain("29 张");
  });

  it("内置贴纸：实际张数 == 文档写的 11 个；贴纸目录里都有对应条目", async () => {
    const count = countAssets("assets/stickers");
    expect(count).toBe(11);
    expect(ALL_DOCS).toContain("11 个");
    const { getStickerCatalog } = await import("../impulse/stickers.js");
    expect(getStickerCatalog().length, "贴纸目录条目数应与实际文件数一致").toBe(11);
  });

  it("配文池规模在「约 150 条」的合理区间（140–180）", () => {
    const src = readSrc("impulse/photo-library.ts");
    const blocks = [...src.matchAll(/captions:\s*\{(.*?)\n\s*\}/gs)].map((m) => m[1] ?? "");
    const total = blocks.reduce((sum, block) => sum + [...block.matchAll(/"[^"]+"/g)].length, 0);
    expect(total, `配文池实际约 ${total} 条`).toBeGreaterThanOrEqual(140);
    expect(total).toBeLessThanOrEqual(180);
    expect(ALL_DOCS).toContain("约 150 条");
  });
});

describe("金标集规模与文档一致", () => {
  it("记忆金标 40 条", () => {
    const gold = JSON.parse(read("src/eval/memory-gold.json")) as unknown[];
    expect(gold.length).toBe(40);
    expect(ALL_DOCS).toContain("40 条");
  });

  it("锚点金标 30 条，且 该记 17 / 不该记 13 与文档一致", () => {
    interface AnchorCase { expect: { anchor: boolean } }
    const gold = JSON.parse(read("src/eval/anchor-gold.json")) as AnchorCase[];
    const yes = gold.filter((item) => item.expect.anchor).length;
    expect(gold.length).toBe(30);
    expect(yes).toBe(17);
    expect(gold.length - yes).toBe(13);
    expect(ALL_DOCS).toContain("该记 17 / 不该记 13");
  });
});

describe("阈值常量与文档一致", () => {
  it("离线守门阈值：facts 95% / recall@8 90% / 合并 95%", () => {
    const src = read("scripts/eval-offline.ts");
    expect(src).toMatch(/factsHitRate:\s*0\.95/);
    expect(src).toMatch(/recallAt8:\s*0\.9/);
    expect(src).toMatch(/mergedHitRate:\s*0\.95/);
    expect(ALL_DOCS).toContain("facts≥95%");
    expect(ALL_DOCS).toContain("recall@8≥90%");
    expect(ALL_DOCS).toContain("合并≥95%");
  });

  it("T3 压缩：40 条触发 + ≥20 条且隔天兜底", () => {
    expect(COMPRESSION_BATCH_SIZE).toBe(40);
    expect(COMPRESSION_MIN_COUNT).toBe(20);
    const claude = DOCS.claude;
    expect(claude, "CLAUDE 应写明 T3 阈值 40 与兜底 20").toMatch(/T3 压缩（40 条/);
    expect(claude).toContain("≥20 条且距上次摘要 ≥1 天");
  });

  it("主动消息：单日上限 4 条 + 最小间隔 30 分钟", () => {
    const src = read("src/pipeline/orchestrator.ts");
    expect(src).toMatch(/MAX_PROACTIVE_PER_DAY\s*=\s*4/);
    expect(src).toMatch(/MIN_PROACTIVE_GAP_MS\s*=\s*30 \* 60 \* 1000/);
    expect(ALL_DOCS).toContain("单日上限 4 条");
    expect(ALL_DOCS).toContain("30 分钟");
  });

  it("单轮文字气泡上限 4（与 persona「2-4 条」一致）", () => {
    expect(readSrc("impulse/renderer.ts")).toMatch(/MAX_BURST\s*=\s*4/);
    expect(ALL_DOCS).toContain("单轮文字气泡上限 4");
  });

  it("贴纸：普通 22% / 收到表情 55%，与文档一致", () => {
    const src = readSrc("bridge/qq.ts");
    expect(src).toMatch(/STICKER_PROBABILITY\s*=\s*0\.22/);
    expect(src).toMatch(/STICKER_REPLY_TO_STICKER_PROBABILITY\s*=\s*0\.55/);
    expect(ALL_DOCS).toContain("22%");
    expect(ALL_DOCS).toContain("55%");
  });

  it("收集库容量 500 / 单文件 ≤2MB，与文档一致", () => {
    expect(MAX_COLLECTED_STICKERS).toBe(500);
    expect(MAX_STICKER_BYTES).toBe(2 * 1024 * 1024);
    expect(ALL_DOCS).toContain("库容 500");
    expect(ALL_DOCS).toContain("单文件≤2MB");
  });
});

describe("默认端口与免打扰与文档一致", () => {
  it("端口 18080 / 18081 / 18082", () => {
    expect(DEFAULT_ONE_BOT_WS_PORT).toBe(18080);
    expect(DEFAULT_HEALTH_PORT).toBe(18081);
    expect(DEFAULT_WEB_PORT).toBe(18082);
    for (const port of ["18080", "18081", "18082"]) expect(ALL_DOCS).toContain(port);
  });

  it("默认免打扰 23:00–07:00（start==end 关闭）", () => {
    const src = readSrc("data/store.ts");
    expect(src).toMatch(/quiet_hours_start.*23|23.*quiet_hours_start|默认 23:00-07:00/);
    expect(src).toContain("默认 23:00-07:00");
    expect(src).toContain("start == end");
    expect(ALL_DOCS).toContain("23:00–07:00");
  });
});

describe("文档提到的环境变量都真实存在", () => {
  it("README/CLAUDE 的能力开关类 env 都能在代码或示例配置里找到", () => {
    const envNames = new Set<string>();
    for (const doc of Object.values(DOCS)) {
      for (const match of doc.matchAll(/KAREN_[A-Z0-9_]{2,}/g)) envNames.add(match[0]);
    }
    expect(envNames.size).toBeGreaterThanOrEqual(5);
    // 代码 + 示例配置里出现过的所有 env（递归收集 src，避免逐个文件维护）
    const srcFiles: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (entry.name.endsWith(".ts")) srcFiles.push(fs.readFileSync(full, "utf-8"));
      }
    };
    walk(path.join(ROOT, "src"));
    const codeAndConfig = [read(".env.example"), ...srcFiles].join("\n");
    const missing = [...envNames].filter((name) => !codeAndConfig.includes(name));
    expect(missing, `文档提到但代码/.env.example 里没有：${missing.join(", ")}`).toEqual([]);
  });
});

describe("文档新鲜度（防止状态块停在旧版本）", () => {
  const pkg = JSON.parse(read("package.json")) as { version: string };
  const latestChangelogDate = (() => {
    const match = read("CHANGELOG.md").match(/^## v\d+\.\d+\.\d+ — (\d{4}-\d{2}-\d{2})/m);
    return match?.[1] ?? "";
  })();

  it("README 项目状态块写的是当前版本（不是旧版本）", () => {
    const firstBlock = DOCS.readme.split("\n").slice(0, 15).join("\n");
    const versionInBlock = firstBlock.match(/v(\d+\.\d+\.\d+)/)?.[1];
    expect(versionInBlock, "README 项目状态块应写明当前版本").toBe(pkg.version);
  });

  it("CLAUDE 头部「最后更新」日期 == CHANGELOG 最新条目日期", () => {
    const claudeDate = DOCS.claude.match(/最后更新：(\d{4}-\d{2}-\d{2})/)?.[1];
    expect(claudeDate, "CLAUDE 缺少「最后更新」").toBeTruthy();
    expect(claudeDate).toBe(latestChangelogDate);
  });

  it("能力总表 / 覆盖审计的「最后更新」版本 == package.json 版本", () => {
    const matrixVersion = DOCS.matrix.match(/最后更新：[^（]*（v(\d+\.\d+\.\d+)）/)?.[1];
    expect(matrixVersion).toBe(pkg.version);
    const auditVersion = read("docs/COVERAGE_AUDIT.md").match(/最后更新：[^（]*（v(\d+\.\d+\.\d+)）/)?.[1];
    expect(auditVersion).toBe(pkg.version);
  });
});

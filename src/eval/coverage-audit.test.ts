/**
 * 能力宣称 × 单测 × 真实链路 的三层交叉核对（v0.8.21）。
 *
 * 目的：防止「文档里写着 ✅，但代码没有单测」或「只有单测、从没真实跑过」的宣称漂移。
 *
 * - 第一层（本文件）：能力总表里标 ✅ 的行，它引用的代码至少被**某个测试文件**覆盖，
 *   或者是纯配置/脚本入口（白名单）；
 * - 第二层：真实链路覆盖清单（docs/COVERAGE_AUDIT.md 的「真实链路」列由人维护，
 *   这里是自动化的最低保障）。
 */
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = process.cwd();
const MATRIX = path.join(ROOT, "docs", "CAPABILITY_MATRIX.md");

/** 允许「有 ✅ 但不需要单测」的纯入口/配置类文件 */
const NO_TEST_NEEDED = new Set([
  "scripts/anchor-smoke.ts",
  "scripts/digest-smoke.ts",
  "scripts/refine-smoke.ts",
  "scripts/rollup-smoke.ts",
  "scripts/asr-smoke.ts",
  "scripts/asr-start.ts",
  "services/asr/server.py",
  "scripts/initiative-sim.ts",
  "scripts/eval-offline.ts",
  "scripts/memory-eval.ts",
  "scripts/anchor-eval.ts",
  "services/embed/server.py",
  "services/image/server.py",
  "src/data/memory-v2.ts", // 建表/迁移为主，逻辑函数已被多条测试覆盖（见下）
]);

/** 数据文件（金标集等）：不要求「被 import」，但要求有专门的数据校验测试 */
const DATA_FILES: Record<string, string> = {
  "src/eval/memory-gold.json": "src/eval/memory-gold.test.ts",
};

function listTestFiles(): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === "node_modules" || entry.name === "dist") continue;
        walk(full);
      } else if (/\.test\.ts$/.test(entry.name)) {
        out.push(full);
      }
    }
  };
  walk(path.join(ROOT, "src"));
  return out;
}

/** 矩阵每行：能力、代码单元、状态 */
export function parseCapabilityRows(markdown: string): Array<{
  name: string;
  codePaths: string[];
  status: string;
}> {
  const rows: Array<{ name: string; codePaths: string[]; status: string }> = [];
  for (const line of markdown.split("\n")) {
    if (!line.startsWith("|")) continue;
    const cells = line.split("|").map((c) => c.trim());
    // | 能力 | 代码 | 状态 | 实测 | 弱项 |  → cells[0]="", [1]=能力, [2]=代码, [3]=状态
    if (cells.length < 5) continue;
    const name = cells[1] ?? "";
    const code = cells[2] ?? "";
    const status = cells[3] ?? "";
    if (!name || name === "能力" || /^-+$/.test(name)) continue;
    const codePaths = [...code.matchAll(/`((?:src|services|scripts)\/[\w./-]+)`/g)].map(
      (m) => m[1]!,
    );
    if (codePaths.length === 0) continue;
    rows.push({ name, codePaths, status });
  }
  return rows;
}

describe("能力宣称 × 单测覆盖（v0.8.21）", () => {
  const markdown = fs.readFileSync(MATRIX, "utf-8");
  const rows = parseCapabilityRows(markdown);
  const testFiles = listTestFiles();
  const testSources = testFiles.map((file) => fs.readFileSync(file, "utf-8")).join("\n");

  it("解析器能读出足够多的能力行（防正则失效后静默通过）", () => {
    expect(rows.length).toBeGreaterThanOrEqual(20);
    expect(rows.some((row) => row.name.includes("锚点"))).toBe(true);
    expect(rows.some((row) => row.name.includes("多媒体"))).toBe(true);
  });

  it("标 ✅ 的能力，其代码至少有对应单测或明确的白名单豁免", () => {
    const failures: string[] = [];
    for (const row of rows) {
      if (!row.status.includes("✅")) continue;
      for (const codePath of row.codePaths) {
        if (NO_TEST_NEEDED.has(codePath)) continue;
        const dataGuard = DATA_FILES[codePath];
        if (dataGuard) {
          if (!fs.existsSync(path.join(ROOT, dataGuard))) {
            failures.push(`${row.name} → ${codePath}（数据校验测试缺失：${dataGuard}）`);
          }
          continue;
        }
        const base = codePath.replace(/\.ts$/, "");
        const sibling = `${base}.test.ts`;
        const covered =
          fs.existsSync(path.join(ROOT, sibling)) ||
          testSources.includes(codePath) ||
          testSources.includes(path.basename(codePath));
        if (!covered) failures.push(`${row.name} → ${codePath}`);
      }
    }
    expect(failures, `这些 ✅ 能力没有单测覆盖：\n${failures.join("\n")}`).toEqual([]);
  });

  it("代码路径都存在（矩阵引用的文件不能消失）", () => {
    const missing: string[] = [];
    for (const row of rows) {
      for (const codePath of row.codePaths) {
        const abs = path.join(ROOT, codePath);
        if (!fs.existsSync(abs)) missing.push(`${row.name} → ${codePath}`);
      }
    }
    expect(missing, `能力总表引用了不存在的文件：\n${missing.join("\n")}`).toEqual([]);
  });
});

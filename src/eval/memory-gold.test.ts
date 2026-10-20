/**
 * 记忆金标集（40 条）数据校验（v0.8.21 覆盖率核对）。
 *
 * 金标集是离线守门（`npm run eval:offline`）与 live 评测的**唯一标准答案**。
 * 它本身坏掉（字段缺失/expect 为空/id 重复/数量掉了）会让评测静默失真——
 * 这里把「金标集自身的完整性」也纳入单测。
 */
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

interface GoldCase {
  id: string;
  category: string;
  type: string;
  statement: string;
  probe: string;
  expect: string[];
  fact?: { key: string; value: string; category: string };
}

const GOLD = path.resolve(process.cwd(), "src/eval/memory-gold.json");
const cases = JSON.parse(fs.readFileSync(GOLD, "utf-8")) as GoldCase[];

describe("记忆金标集完整性", () => {
  it("不少于 40 条（v0.8.2 起的基线，掉数量说明被误删）", () => {
    expect(cases.length).toBeGreaterThanOrEqual(40);
  });

  it("id 唯一、字段齐全、expect 非空", () => {
    const ids = new Set<string>();
    for (const item of cases) {
      expect(item.id, "缺 id").toBeTruthy();
      expect(ids.has(item.id), `id 重复：${item.id}`).toBe(false);
      ids.add(item.id);
      expect(item.statement.length, `${item.id} 的 statement 太短`).toBeGreaterThan(4);
      expect(item.probe.length, `${item.id} 的 probe 太短`).toBeGreaterThan(2);
      expect(Array.isArray(item.expect) && item.expect.length > 0, `${item.id} 没有 expect`).toBe(
        true,
      );
      for (const word of item.expect) {
        expect(word.length, `${item.id} 的 expect 有空的`).toBeGreaterThan(0);
      }
    }
  });

  it("覆盖核心类别（姓名/城市/工作/宠物/偏好/计划等至少 6 类）", () => {
    const categories = new Set(cases.map((item) => item.category));
    expect(categories.size).toBeGreaterThanOrEqual(6);
    for (const must of ["姓名"]) {
      expect([...categories].some((c) => c.includes(must)), `缺少类别：${must}`).toBe(true);
    }
  });

  it("答案必须能在陈述里找到依据（事实类金标不能凭空编）", () => {
    // 只校验 direct 类型：expect 里**至少一个**答案要能在陈述原文找到（允许多种可接受叫法）
    const direct = cases.filter((item) => item.type === "direct");
    expect(direct.length).toBeGreaterThan(0);
    const bad = direct.filter((item) => !item.expect.some((word) => item.statement.includes(word)));
    expect(bad.map((item) => item.id), "这些 direct 金标的答案在陈述里完全没有依据").toEqual([]);
  });
});

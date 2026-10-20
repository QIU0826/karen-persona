import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "karen-facts-"));
  process.env.KAREN_DATA_DIR = dir;
  vi.resetModules();
});

afterEach(async () => {
  try {
    const v = await import("./vector.js");
    v.closeVectorDb();
  } catch {
    // ignore
  }
  delete process.env.KAREN_DATA_DIR;
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("parseFactsJson", () => {
  it("解析正常 / ```json 包裹 / 带前后文本的 JSON", async () => {
    const { parseFactsJson } = await import("./user-facts.js");
    expect(parseFactsJson('{"facts":[{"key":"name","value":"林哲","category":"profile"}]}')).toEqual([
      { key: "name", value: "林哲", category: "profile" },
    ]);
    const fenced = '```json\n{"facts":[{"key":"pet","value":"猫，叫团子","category":"pet"}]}\n```';
    expect(parseFactsJson(fenced)).toEqual([{ key: "pet", value: "猫，叫团子", category: "pet" }]);
    const noisy = '结果如下：{"facts":[{"key":"city","value":"杭州","category":"profile"}]} 完毕';
    expect(parseFactsJson(noisy)[0].value).toBe("杭州");
  });

  it("非法/空内容返回空，同 key 去重", async () => {
    const { parseFactsJson } = await import("./user-facts.js");
    expect(parseFactsJson("")).toEqual([]);
    expect(parseFactsJson("not json")).toEqual([]);
    const dup = '{"facts":[{"key":"job","value":"设计师"},{"key":"job","value":"产品设计师","category":"work"}]}';
    expect(parseFactsJson(dup)).toEqual([{ key: "job", value: "产品设计师", category: "work" }]);
  });
});

describe("user_facts 存储与注入", () => {
  it("按 owner 隔离，同 key 覆盖，格式化注入", async () => {
    const facts = await import("./user-facts.js");
    facts.upsertUserFacts("cli:local", [
      { key: "name", value: "林哲", category: "profile" },
      { key: "job", value: "产品设计", category: "work" },
      { key: "pet", value: "猫，叫团子（橘猫）", category: "pet" },
    ]);
    facts.upsertUserFacts("cli:local", [
      { key: "job", value: "高级产品设计师", category: "work" },
    ]);
    facts.upsertUserFacts("qq:222", [{ key: "name", value: "别人", category: "profile" }]);

    const mine = facts.listUserFacts("cli:local");
    expect(mine.find((f) => f.key === "job")!.value).toBe("高级产品设计师");
    expect(mine).toHaveLength(3);
    expect(facts.listUserFacts("qq:222")).toHaveLength(1);

    const text = facts.getUserFactsContext("cli:local");
    expect(text).toContain("你确定记得的关于对方的事");
    expect(text).toContain("林哲");
    expect(text).toContain("高级产品设计师");
    expect(text).toContain("团子");
    expect(text).not.toContain("别人");
    expect(facts.getUserFactsContext("qq:333")).toBe("");
  });

  it("跨模块重载后仍能读到（持久化）", async () => {
    const first = await import("./user-facts.js");
    first.upsertUserFacts("cli:local", [{ key: "city", value: "杭州", category: "profile" }]);
    (await import("./vector.js")).closeVectorDb();

    vi.resetModules();
    const second = await import("./user-facts.js");
    expect(second.getUserFactsContext("cli:local")).toContain("杭州");
  });
});

describe("user_facts 变更历史（时间维度）", () => {
  it("同 key 值变化时记录旧值；值没变不记录", async () => {
    const facts = await import("./user-facts.js");
    facts.upsertUserFacts("cli:local", [{ key: "job", value: "产品设计师", category: "work" }]);
    // 同值重复写入：不应产生历史
    facts.upsertUserFacts("cli:local", [{ key: "job", value: "产品设计师", category: "work" }]);
    expect(facts.listFactHistory("cli:local")).toHaveLength(0);

    // 换工作：旧值入历史
    facts.upsertUserFacts("cli:local", [{ key: "job", value: "高级产品设计师", category: "work" }]);
    const history = facts.listFactHistory("cli:local");
    expect(history).toHaveLength(1);
    expect(history[0]).toMatchObject({ key: "job", oldValue: "产品设计师" });
    expect(history[0].changedAt).toBeGreaterThan(0);
  });

  it("注入块对最近变过的事实显示「（之前是：旧值）」", async () => {
    const facts = await import("./user-facts.js");
    facts.upsertUserFacts("cli:local", [{ key: "job", value: "产品设计师", category: "work" }]);
    facts.upsertUserFacts("cli:local", [{ key: "job", value: "高级产品设计师", category: "work" }]);

    const text = facts.getUserFactsContext("cli:local");
    expect(text).toContain("高级产品设计师（之前是：产品设计师）");

    // 180 天前的变更不展示
    const older = facts.getRecentFactChanges("cli:local", Date.now() + 1000);
    expect(older.size).toBe(0);
  });

  it("按 owner 隔离；每个 key 历史保留最近 20 条", async () => {
    const facts = await import("./user-facts.js");
    facts.upsertUserFacts("qq:1", [{ key: "city", value: "杭州", category: "profile" }]);
    facts.upsertUserFacts("qq:2", [{ key: "city", value: "上海", category: "profile" }]);
    for (let i = 0; i < 25; i++) {
      facts.upsertUserFacts("qq:1", [{ key: "city", value: `城市${i}`, category: "profile" }]);
    }
    expect(facts.listFactHistory("qq:2")).toHaveLength(0);
    expect(facts.listFactHistory("qq:1", 100).length).toBeLessThanOrEqual(20);
    expect(facts.listUserFacts("qq:1").find((f) => f.key === "city")?.value).toBe("城市24");
  });
});

describe("事实超过 20 条的上限压测", () => {
  it("profile 事实过多时不会挤掉工作/宠物/计划；注入行数 ≤20", async () => {
    const facts = await import("./user-facts.js");
    const now = Date.now();
    const items: Array<{ key: string; value: string; category: "profile" }> = [];
    // 25 条 profile（模拟用户翻来覆去说自己的基本信息）
    for (let i = 0; i < 25; i++) {
      items.push({ key: `profile_${i}`, value: `基本信息${i}`, category: "profile" });
    }
    facts.upsertUserFacts("stress:local", items);
    facts.upsertUserFacts("stress:local", [
      { key: "job", value: "产品设计师", category: "work" },
      { key: "pet", value: "橘猫团子", category: "pet" },
      { key: "plan", value: "下个月去云南", category: "plan" },
      { key: "pref", value: "喜欢美式咖啡", category: "preference" },
    ]);

    const all = facts.listUserFacts("stress:local");
    expect(all.length).toBe(29);

    const selected = facts.selectFactsForPrompt(all, 20);
    expect(selected).toHaveLength(20);
    // 核心分类保留；剩余名额按时间回填，profile 最多占满剩余（不会把核心分类挤掉）
    expect(selected.filter((f) => f.category === "profile").length).toBeLessThan(20);
    expect(selected.some((f) => f.key === "job")).toBe(true);
    expect(selected.some((f) => f.key === "pet")).toBe(true);
    expect(selected.some((f) => f.key === "plan")).toBe(true);

    const text = facts.getUserFactsContext("stress:local");
    const lineCount = text.split("\n").filter((line) => line.startsWith("- ")).length;
    expect(lineCount).toBe(20);
    expect(text).toContain("产品设计师");
    expect(text).toContain("团子");
    expect(text).toContain("云南");
  });

  it("事实少于上限时全部注入（行为与旧版一致）", async () => {
    const facts = await import("./user-facts.js");
    facts.upsertUserFacts("small:local", [
      { key: "name", value: "林哲", category: "profile" },
      { key: "job", value: "产品设计师", category: "work" },
    ]);
    const selected = facts.selectFactsForPrompt(facts.listUserFacts("small:local"), 20);
    expect(selected).toHaveLength(2);
  });
});

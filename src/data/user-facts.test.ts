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

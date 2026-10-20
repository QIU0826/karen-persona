/**
 * 回复守卫单测（纯函数）。
 */
import { describe, expect, it } from "vitest";
import { stripMemoryDeflection } from "./reply-guard.js";

describe("stripMemoryDeflection", () => {
  it("删除含「我记性没那么差」的分句，保留同句其他内容", () => {
    const result = stripMemoryDeflection("接着 林哲啊，我记性没那么差");
    expect(result.changed).toBe(true);
    expect(result.text).toBe("接着 林哲啊");
    expect(result.fallback).toBe(false);
  });

  it("删除「考我/查岗/抽查/考考你」分句", () => {
    expect(stripMemoryDeflection("团子啊，你这是要考我吗").text).toBe("团子啊");
    expect(stripMemoryDeflection("我是那种会查岗的人吗，今天挺热").text).toBe("今天挺热");
    expect(stripMemoryDeflection("抽查一下，你昨天干嘛去了").text).toBe("你昨天干嘛去了");
    expect(stripMemoryDeflection("行吧，考考你").text).toBe("行吧");
  });

  it("嘲讽式记忆防御（才说的就忘/才两句就忘）也会被清掉", () => {
    expect(stripMemoryDeflection("才说的就忘啦").fallback).toBe(true);
    expect(stripMemoryDeflection("才两句就忘啦").fallback).toBe(true);
    expect(stripMemoryDeflection("这就忘了？我叫阿哲").text).toBe("我叫阿哲");
  });

  it("整条都是防御话术时退化为「嗯」", () => {
    const result = stripMemoryDeflection("你这是要考我吗");
    expect(result.fallback).toBe(true);
    expect(result.text).toBe("嗯");
  });

  it("多行回复逐行处理，空行与孤立标点被清理", () => {
    const result = stripMemoryDeflection("我记性没那么差\n真的\n，");
    expect(result.text).toBe("真的");
  });

  it("省略「我」的口语变体也会被清理（真实长跑出现过）", () => {
    const result = stripMemoryDeflection("林哲 杭州做产品设计\n才一个月 记性没那么差");
    expect(result.changed).toBe(true);
    expect(result.text).toBe("林哲 杭州做产品设计");
  });

  it("正常回复原样返回（changed=false）", () => {
    const reply = "今天好累啊\n早点睡吧";
    const result = stripMemoryDeflection(reply);
    expect(result.changed).toBe(false);
    expect(result.text).toBe(reply);
  });

  it("空字符串安全", () => {
    expect(stripMemoryDeflection("")).toEqual({ text: "", changed: false, fallback: false });
  });
});

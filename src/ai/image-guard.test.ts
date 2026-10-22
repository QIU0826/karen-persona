import { describe, expect, it } from "vitest";
import { parseAuditResponse } from "./image-guard.js";

describe("parseAuditResponse", () => {
  it("解析正常 JSON 并计算 pass", () => {
    const audit = parseAuditResponse(
      JSON.stringify({
        scene_match: true,
        character_match: true,
        anatomy_ok: true,
        hands_ok: true,
        artifacts: [],
        issues: [],
        reason: "场景和角色一致",
      }),
    );
    expect(audit?.pass).toBe(true);
    expect(audit?.reason).toContain("一致");
  });

  it("容忍 ```json 代码块", () => {
    const audit = parseAuditResponse(
      '```json\n{"scene_match":true,"character_match":true,"anatomy_ok":false,"hands_ok":false,"artifacts":["多余手指"],"issues":["手部畸形"],"reason":"手部异常"}\n```',
    );
    expect(audit?.pass).toBe(false);
    expect(audit?.hands_ok).toBe(false);
    expect(audit?.artifacts).toContain("多余手指");
  });

  it("artifacts 非空时 pass 为 false", () => {
    const audit = parseAuditResponse(
      '{"scene_match":true,"character_match":true,"anatomy_ok":true,"hands_ok":true,"artifacts":["水印"],"issues":[],"reason":""}',
    );
    expect(audit?.pass).toBe(false);
  });

  it("空内容/非 JSON 返回 null", () => {
    expect(parseAuditResponse("")).toBeNull();
    expect(parseAuditResponse("看起来不错")).toBeNull();
  });
});

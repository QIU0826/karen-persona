/**
 * 出站媒体落地校验（v0.9.24）。
 *
 * 只测纯解析：get_msg 的响应形状兼容数组 / CQ 字符串 / 畸形；
 * verifySentSegment 依赖网络调用，这里用 extractMsgSegments + 一个本地断言等价验证。
 */
import { describe, it, expect } from "vitest";
import { extractMsgSegments } from "./onebot.js";

describe("extractMsgSegments", () => {
  it("数组形状：保留 type，record 段带时长", () => {
    const segments = extractMsgSegments({
      message: [
        { type: "text", data: { text: "你好" } },
        { type: "record", data: { file: "x.silk", duration: 3.2 } },
      ],
    });
    expect(segments).toEqual([
      { type: "text", durationSeconds: null },
      { type: "record", durationSeconds: 3.2 },
    ]);
  });

  it("image 段没有 duration 时为 null", () => {
    expect(extractMsgSegments({ message: [{ type: "image", data: { file: "x.png" } }] }))
      .toEqual([{ type: "image", durationSeconds: null }]);
  });

  it("字符串 CQ 码：解析出段类型，不解析参数", () => {
    const segments = extractMsgSegments({
      message: "看这个[CQ:image,file=abc.png][CQ:record,file=base64://xx]",
    });
    expect(segments?.map((s) => s.type)).toEqual(["image", "record"]);
  });

  it("空数组返回空数组（调用方按 missing 处理），不是 null", () => {
    expect(extractMsgSegments({ message: [] })).toEqual([]);
  });

  it("缺失/畸形 message 返回 null", () => {
    expect(extractMsgSegments(null)).toBeNull();
    expect(extractMsgSegments({})).toBeNull();
    expect(extractMsgSegments({ message: 42 })).toBeNull();
  });

  it("非法段被跳过，但不抛异常", () => {
    expect(extractMsgSegments({ message: [null, {}, { type: 123 }, { type: "record" }] }))
      .toEqual([{ type: "record", durationSeconds: null }]);
  });

  it("不返回 file/url 字段（防止本机路径外泄）", () => {
    const segments = extractMsgSegments({
      message: [{ type: "record", data: { file: "D:\\\\secret\\\\a.mp3", duration: 2 } }],
    });
    expect(segments).toEqual([{ type: "record", durationSeconds: 2 }]);
    expect(JSON.stringify(segments)).not.toContain("secret");
  });
});

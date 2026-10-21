import { describe, expect, it } from "vitest";
import { hasOutboundMediaMarker, stripOutboundMediaMarkers } from "./outbound-markers.js";

describe("出站媒体占位符清理（v0.9.19）", () => {
  it("删掉常见占位标记，保留自然语言", () => {
    expect(stripOutboundMediaMarkers("我拍不出什么好看的 [图片]")).toBe("我拍不出什么好看的");
    expect(stripOutboundMediaMarkers("[图片] 店门口那张")).toBe("店门口那张");
    expect(stripOutboundMediaMarkers("等下\n[照片]\n翻翻相册")).toBe("等下\n翻翻相册");
  });

  it("带描述的标记也删（模型在模仿入站格式）", () => {
    expect(stripOutboundMediaMarkers("给你看[图片：窗台上的猫] 它又睡着了")).toBe("给你看 它又睡着了");
    expect(stripOutboundMediaMarkers("【书】在桌上 [表情包：猫猫点头]")).toBe("【书】在桌上");
  });

  it("语音/表情/视频标记同样清理", () => {
    expect(stripOutboundMediaMarkers("听一下 [语音]")).toBe("听一下");
    expect(stripOutboundMediaMarkers("[表情]")).toBe("");
    expect(stripOutboundMediaMarkers("刚拍的 [视频]")).toBe("刚拍的");
  });

  it("不误删普通方括号内容/全角括号", () => {
    expect(stripOutboundMediaMarkers("【图片】这个词不算标记")).toBe("【图片】这个词不算标记");
    expect(stripOutboundMediaMarkers("（图片）也不删")).toBe("（图片）也不删");
    expect(stripOutboundMediaMarkers("[引用] 也不删")).toBe("[引用] 也不删");
  });

  it("只有标记时返回空串（调用方据此不发文字）", () => {
    expect(stripOutboundMediaMarkers("[图片]")).toBe("");
    expect(stripOutboundMediaMarkers("[图片]\n[语音]")).toBe("");
    expect(stripOutboundMediaMarkers("   ")).toBe("");
    expect(stripOutboundMediaMarkers("")).toBe("");
  });

  it("轻度清洗：多空格/空行收敛", () => {
    expect(stripOutboundMediaMarkers("看这个   [图片]   好看吧")).toBe("看这个 好看吧");
    expect(stripOutboundMediaMarkers("第一句 [图片]\n\n第二句")).toBe("第一句\n第二句");
  });

  it("hasOutboundMediaMarker 判断与清理一致", () => {
    expect(hasOutboundMediaMarker("发你看 [图片]")).toBe(true);
    expect(hasOutboundMediaMarker("发你看【图片】")).toBe(false);
    expect(hasOutboundMediaMarker("普通回复")).toBe(false);
  });
});

/**
 * 群聊回复出站计划单测（纯函数，不连 QQ）。
 */
import { describe, expect, it } from "vitest";
import { buildGroupReplyPlan } from "./group-reply.js";

describe("buildGroupReplyPlan", () => {
  it("文字按换行拆成多条气泡，过滤空行", () => {
    const plan = buildGroupReplyPlan({ reply: "刚下班\n\n 累死了 \n你呢" });
    expect(plan.textLines).toEqual(["刚下班", "累死了", "你呢"]);
    expect(plan.photo).toBeNull();
  });

  it("QQ 表情单独一条；空白 qqFace 忽略", () => {
    expect(buildGroupReplyPlan({ reply: "嗯", qqFace: "[CQ:face,id=1]" }).qqFaceCq).toBe(
      "[CQ:face,id=1]",
    );
    expect(buildGroupReplyPlan({ reply: "嗯", qqFace: "  " }).qqFaceCq).toBeUndefined();
  });

  it("照片默认不发群（隐私默认）", () => {
    const plan = buildGroupReplyPlan({
      reply: "你看这个",
      imageFile: "/tmp/photo.jpg",
      imageCaption: "今天的晚霞",
    });
    expect(plan.photo).toBeNull();
  });

  it("显式开启群体发图时带上图片与配文；本地文件优先于 URL", () => {
    const local = buildGroupReplyPlan(
      {
        reply: "给你看",
        imageFile: "/tmp/photo.jpg",
        imageUrl: "https://example.com/p.jpg",
        imageCaption: "下午的云",
      },
      { photoEnabled: true },
    );
    expect(local.photo).toEqual({ file: "/tmp/photo.jpg", caption: "下午的云" });

    const remote = buildGroupReplyPlan(
      { reply: "给你看", imageUrl: "https://example.com/p.jpg" },
      { photoEnabled: true },
    );
    expect(remote.photo).toEqual({ url: "https://example.com/p.jpg" });
  });

  it("没有回复正文但有图/表情时不丢失（例如只发图）", () => {
    const plan = buildGroupReplyPlan(
      { reply: "", imageFile: "/tmp/a.png", qqFace: "[CQ:face,id=2]" },
      { photoEnabled: true },
    );
    expect(plan.textLines).toEqual([]);
    expect(plan.qqFaceCq).toBe("[CQ:face,id=2]");
    expect(plan.photo?.file).toBe("/tmp/a.png");
  });
});

import { describe, expect, it } from "vitest";
import {
  hasMeetingGrounding,
  isAskingHowWeMet,
  pickMeetingFallback,
  stripFabricatedMeeting,
} from "./meeting-guard.js";

describe("isAskingHowWeMet", () => {
  it("识别常见的「怎么认识的」问法", () => {
    for (const text of [
      "我们怎么认识的来着？",
      "你还记得咱俩第一次见面吗",
      "我们第一次在哪见的",
      "你跟我咋认识的",
      "我们认识多久了",
      "想想我们初识的时候",
    ]) {
      expect(isAskingHowWeMet(text), text).toBe(true);
    }
  });

  it("普通聊天不误判", () => {
    for (const text of [
      "今天店里忙不忙",
      "我认识一个做设计的朋友",
      "晚上吃什么",
      "你叫什么名字",
      "",
    ]) {
      expect(isAskingHowWeMet(text), text).toBe(false);
    }
  });

  it("CQ 码不影响判断", () => {
    expect(isAskingHowWeMet("[CQ:image,file=base64://xxxx] 我们怎么认识的")).toBe(true);
  });
});

describe("hasMeetingGrounding", () => {
  it("用户自己写过相识背景 → 有依据", () => {
    expect(hasMeetingGrounding({ userBackground: "朋友聚会上认识的" })).toBe(true);
  });

  it("人设包自带的相遇故事不算依据（18 轮验证翻车的原因）", () => {
    // 只传 facts/memory，不传用户背景：即使 personas/xiaoya 的 howWeMet 写着「下雨借伞」，也不算
    expect(hasMeetingGrounding({ factsText: "", memoryText: "" })).toBe(false);
  });

  it("占位文案不算依据", () => {
    expect(hasMeetingGrounding({ userBackground: "你们认识", factsText: "", memoryText: "" })).toBe(false);
  });

  it("事实/记忆里提到介绍、聚会等 → 有依据", () => {
    expect(hasMeetingGrounding({ factsText: "用户说：我们是通过朋友介绍认识的" })).toBe(true);
    expect(hasMeetingGrounding({ memoryText: "用户: 上次聚会那个..." })).toBe(true);
  });

  it("什么都没有 → 无依据", () => {
    expect(hasMeetingGrounding({ factsText: "用户叫阿哲，在上海做程序员", memoryText: "今天加班" })).toBe(false);
  });
});

describe("stripFabricatedMeeting", () => {
  it("未启用时原样返回", () => {
    const text = "你老坐吧台，下雨那天还借你伞了呢";
    const r = stripFabricatedMeeting(text, false);
    expect(r.text).toBe(text);
    expect(r.changed).toBe(false);
  });

  it("删掉编造场景的分句，保留其余内容", () => {
    const r = stripFabricatedMeeting("你每周来三四次，坐吧台。有次下雨没带伞，我借你的，后来就熟了呗", true);
    expect(r.text).not.toContain("吧台");
    expect(r.text).not.toContain("伞");
    expect(r.changed).toBe(true);
  });

  it("整条都是编造时标记 removedAll", () => {
    const r = stripFabricatedMeeting("你老坐吧台，下雨还借你伞", true);
    expect(r.text).toBe("");
    expect(r.removedAll).toBe(true);
  });

  it("不编造的回答不动（含糊/反问/转移）", () => {
    const text = "这个我还真记不清了，你提醒我一下？\n反正认识你之后挺好";
    const r = stripFabricatedMeeting(text, true);
    expect(r.text).toBe(text);
    expect(r.changed).toBe(false);
  });
});

describe("pickMeetingFallback", () => {
  it("同一个输入稳定返回同一句，且不同输入能覆盖到多句", () => {
    expect(pickMeetingFallback("我们怎么认识的")).toBe(pickMeetingFallback("我们怎么认识的"));
    const variants = new Set(
      ["我们怎么认识的", "第一次见面在哪", "认识多久了", "你还记得咱俩怎么认识的吗"].map(
        pickMeetingFallback,
      ),
    );
    expect(variants.size).toBeGreaterThan(1);
  });
});

describe("stripFabricatedMeeting：模糊词 + 具体场所也算编造（v0.8.9 真机回归）", () => {
  it("「好像是咖啡店吧」——加了模糊词仍然是断言具体场所，要删", () => {
    const result = stripFabricatedMeeting("我想想 好像是咖啡店吧 具体的我也记不太清了", true);
    expect(result.changed).toBe(true);
    expect(result.text).not.toContain("咖啡店");
  });

  it("酒吧/书店/餐厅/电影院 等场所同样处理", () => {
    for (const venue of ["酒吧", "书店", "餐厅", "电影院", "健身房"]) {
      const result = stripFabricatedMeeting(`好像是${venue}吧，记不太清了`, true);
      expect(result.text, `${venue} 应被删除`).not.toContain(venue);
    }
  });

  it("含糊到没有具体场所时不动（「记不清了，你提醒我」是真人式回应）", () => {
    const answer = "记不清了，你提醒我一下？";
    const result = stripFabricatedMeeting(answer, true);
    expect(result.changed).toBe(false);
    expect(result.text).toBe(answer);
  });

  it("有依据时（用户自己说过）不删除（避免误伤真实回忆）", () => {
    // 这里只测 strip 本身：它只删「场景断言」，依据判断在调用方用 hasMeetingGrounding
    const result = stripFabricatedMeeting("就是我们第一次见面那家咖啡店啊", true);
    expect(result.text).not.toContain("咖啡店");
  });
});

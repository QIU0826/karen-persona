import { describe, expect, it } from "vitest";
import {
  buildMediaRequestNote,
  detectMediaRequest,
  detectPhotoSceneTags,
  hasAnyMediaRequest,
} from "./media-request.js";

describe("detectMediaRequest 明确索要多媒体", () => {
  it("要照片的常见说法都能识别", () => {
    for (const text of [
      "拍张照片看看呗",
      "你那边现在啥样，拍张照片看看",
      "发张图给我看看",
      "能不能自拍一张",
      "看看你店里现在什么样",
      "来张你那边天空的图",
    ]) {
      expect(detectMediaRequest(text).photo, text).toBe(true);
    }
  });

  it("要表情包/贴纸", () => {
    for (const text of ["发个表情包给我看看", "来一个表情", "你会斗图吗", "发个贴纸嘛"]) {
      expect(detectMediaRequest(text).sticker, text).toBe(true);
    }
  });

  it("要语音", () => {
    for (const text of ["发条语音听听", "用语音说", "我想听听你的声音", "说句话听听嘛"]) {
      expect(detectMediaRequest(text).voice, text).toBe(true);
    }
  });

  it("普通聊天不误判", () => {
    for (const text of [
      "今天好累啊，被老板说了一顿",
      "我养了只猫叫年糕",
      "你那边天气怎么样",
      "晚上吃什么",
      "我们怎么认识的",
      "我先去洗澡了",
    ]) {
      const req = detectMediaRequest(text);
      expect(hasAnyMediaRequest(req), text).toBe(false);
    }
  });

  it("CQ 码和空白不会造成误判；空输入安全", () => {
    expect(detectMediaRequest("[CQ:image,file=base64://xxxx] 早上好").photo).toBe(false);
    expect(detectMediaRequest("   ").photo).toBe(false);
    expect(detectMediaRequest(null).photo).toBe(false);
    expect(detectMediaRequest(undefined).sticker).toBe(false);
    // 带图 + 点名要照片：只看文字部分
    expect(detectMediaRequest("[CQ:image,file=base64://xxxx] 再拍张照片看看").photo).toBe(true);
  });

  it("同时要多种也能分别识别", () => {
    const req = detectMediaRequest("拍张照片，再发条语音听听");
    expect(req.photo).toBe(true);
    expect(req.voice).toBe(true);
  });
});

describe("buildMediaRequestNote 让语气和动作对齐", () => {
  it("没有请求时不产生任何提示", () => {
    expect(buildMediaRequestNote({ photo: false, sticker: false, voice: false })).toBe("");
  });

  it("要照片时提示「现在拍」而不是推到改天", () => {
    const note = buildMediaRequestNote({ photo: true, sticker: false, voice: false });
    expect(note).toContain("照片");
    expect(note).toMatch(/现在|别推/);
    expect(note).not.toContain("改天再");
  });

  it("多种请求会合并成一段内部提示", () => {
    const note = buildMediaRequestNote({ photo: true, sticker: true, voice: true });
    expect(note).toContain("表情包");
    expect(note).toContain("语音");
    expect(note.startsWith("\n[")).toBe(true);
  });
});

describe("detectPhotoSceneTags 让照片内容对上他说的场景", () => {
  it("要晚霞 → sunset；要雪 → snow；要咖啡/店 → cafe", () => {
    expect(detectPhotoSceneTags("你那边晚霞好看吗，拍张看看")).toContain("sunset");
    expect(detectPhotoSceneTags("下雪了吗，拍一张")).toContain("snow");
    expect(detectPhotoSceneTags("店里现在什么样")).toEqual(
      expect.arrayContaining(["cafe"]),
    );
  });

  it("要猫/山/湖也能对上", () => {
    expect(detectPhotoSceneTags("你那只猫在干嘛，拍张")).toContain("animal");
    expect(detectPhotoSceneTags("你那边有山吗")).toContain("mountain");
    expect(detectPhotoSceneTags("湖边拍一张看看")).toContain("lake");
  });

  it("普通聊天不产生标签", () => {
    expect(detectPhotoSceneTags("今天好累啊")).toEqual([]);
    expect(detectPhotoSceneTags("")).toEqual([]);
    expect(detectPhotoSceneTags(null)).toEqual([]);
  });
});

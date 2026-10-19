import { describe, it, expect } from "vitest";
import {
  parseEvent,
  isPrivateMessage,
  isGroupMessage,
  detectMedia,
  getReplyContext,
  parseApiResponse,
  type PrivateMessageEvent,
} from "./onebot.js";

// ── parseEvent ──────────────────────────────

describe("parseEvent", () => {
  it("成功解析合法 JSON 事件", () => {
    const json = JSON.stringify({ post_type: "message", message_type: "private" });
    const event = parseEvent(json);
    expect(event).not.toBeNull();
    expect(event!.post_type).toBe("message");
  });

  it("无效 JSON 返回 null", () => {
    expect(parseEvent("not json")).toBeNull();
  });

  it("空字符串返回 null", () => {
    expect(parseEvent("")).toBeNull();
  });
});

// ── isPrivateMessage ────────────────────────

describe("isPrivateMessage", () => {
  it("识别私聊消息事件", () => {
    const event = JSON.parse(JSON.stringify({
      post_type: "message", message_type: "private", sub_type: "friend",
      message_id: 1, user_id: 123, message: "hi", raw_message: "hi",
      sender: { user_id: 123, nickname: "test", sex: "unknown", age: 0 },
    }));
    expect(isPrivateMessage(event)).toBe(true);
  });

  it("非 message 类型返回 false", () => {
    expect(isPrivateMessage({ post_type: "notice" } as any)).toBe(false);
  });

  it("群聊消息类型返回 false", () => {
    expect(isPrivateMessage({ post_type: "message", message_type: "group" } as any)).toBe(false);
  });
});

// ── isGroupMessage ──────────────────────────

describe("isGroupMessage", () => {
  it("识别群聊消息事件", () => {
    const event = JSON.parse(JSON.stringify({
      post_type: "message", message_type: "group", sub_type: "normal",
      message_id: 1, group_id: 456, user_id: 123,
      message: "hi", raw_message: "hi",
      sender: { user_id: 123, nickname: "test", card: "", sex: "unknown", age: 0, role: "member" },
    }));
    expect(isGroupMessage(event)).toBe(true);
  });
});

// ── detectMedia ─────────────────────────────

function makePrivateEvent(segments: { type: string; data: Record<string, string> }[]): PrivateMessageEvent {
  return {
    post_type: "message",
    message_type: "private",
    sub_type: "friend",
    message_id: 1,
    user_id: 123,
    message: segments,
    raw_message: segments.map(s => {
      if (s.type === "text") return s.data.text;
      return `[CQ:${s.type}]`;
    }).join(""),
    sender: { user_id: 123, nickname: "test", sex: "unknown", age: 0 },
  } as PrivateMessageEvent;
}

describe("detectMedia", () => {
  it("纯文本消息返回 null", () => {
    const event = makePrivateEvent([{ type: "text", data: { text: "你好" } }]);
    expect(detectMedia(event)).toBeNull();
  });

  it("检测图片消息", () => {
    const event = makePrivateEvent([
      { type: "image", data: { url: "http://example.com/img.jpg", file: "img.jpg" } },
    ]);
    const media = detectMedia(event);
    expect(media).not.toBeNull();
    expect(media!.type).toBe("image");
    expect(media!.syntheticText).toBe("[图片]");
    expect(media!.data?.url).toBe("http://example.com/img.jpg");
  });

  it("检测语音消息", () => {
    const event = makePrivateEvent([
      { type: "record", data: { url: "http://example.com/audio.amr" } },
    ]);
    const media = detectMedia(event);
    expect(media!.type).toBe("record");
    expect(media!.syntheticText).toBe("[语音]");
  });

  it("检测引用消息", () => {
    const event = makePrivateEvent([
      { type: "reply", data: { id: "123456", text: "原始消息内容" } },
      { type: "text", data: { text: "我的回复" } },
    ]);
    const media = detectMedia(event);
    expect(media).not.toBeNull();
    expect(media!.type).toBe("reply");
    expect(media!.data?.id).toBe("123456");
    expect(media!.data?.text).toBe("原始消息内容");
  });

  it("表情包返回空 syntheticText", () => {
    const event = makePrivateEvent([
      { type: "face", data: { id: "178" } },
    ]);
    const media = detectMedia(event);
    expect(media!.type).toBe("face");
    expect(media!.syntheticText).toBe("");
  });
});

// ── getReplyContext ─────────────────────────

describe("getReplyContext", () => {
  it("从 data.text 提取引用原文", () => {
    expect(getReplyContext({ id: "123", text: "你吃了吗" })).toBe("你吃了吗");
  });

  it("回退到 data.message", () => {
    expect(getReplyContext({ id: "123", message: "在吗" })).toBe("在吗");
  });

  it("无 text 或 message 时返回 null", () => {
    expect(getReplyContext({ id: "123" })).toBeNull();
  });

  it("null 输入返回 null", () => {
    expect(getReplyContext(null)).toBeNull();
  });
});

// ── parseApiResponse ────────────────────────

describe("parseApiResponse", () => {
  it("成功解析合法 API 响应", () => {
    const json = JSON.stringify({ status: "ok", retcode: 0 });
    const resp = parseApiResponse(json);
    expect(resp).not.toBeNull();
    expect(resp!.status).toBe("ok");
    expect(resp!.retcode).toBe(0);
  });

  it("失败响应正确解析", () => {
    const json = JSON.stringify({ status: "failed", retcode: 1404 });
    const resp = parseApiResponse(json);
    expect(resp!.status).toBe("failed");
  });

  it("非 API 响应返回 null", () => {
    expect(parseApiResponse("not api response")).toBeNull();
    expect(parseApiResponse(JSON.stringify({ post_type: "message" }))).toBeNull();
  });
});

// ── extractAtText ────────────────────────────

import { extractAtText, type GroupMessageEvent } from "./onebot.js";

function makeGroupEvent(message: string | { type: string; data: Record<string, string> }[], raw: string): GroupMessageEvent {
  return {
    time: Date.now(), self_id: 12345, post_type: "message", message_type: "group", sub_type: "normal",
    message_id: 1, group_id: 456, user_id: 789,
    message: message as GroupMessageEvent["message"],
    raw_message: raw,
    sender: { user_id: 789, nickname: "群友", card: "", sex: "unknown", age: 0, role: "member" },
  };
}

describe("extractAtText", () => {
  const SELF = 12345;

  it("字符串形式 @ 检测并提取文本", () => {
    const raw = `[CQ:at,qq=${SELF}] 你在干嘛`;
    const event = makeGroupEvent(raw, raw);
    const text = extractAtText(event, SELF);
    expect(text).toBe("你在干嘛");
  });

  it("结构化消息 @ 检测", () => {
    const event = makeGroupEvent([
      { type: "at", data: { qq: String(SELF) } },
      { type: "text", data: { text: " 今天有空吗" } },
    ], `[CQ:at,qq=${SELF}] 今天有空吗`);
    const text = extractAtText(event, SELF);
    expect(text).toContain("今天有空吗");
  });

  it("未被 @ 时返回 null", () => {
    const event = makeGroupEvent([
      { type: "at", data: { qq: "99999" } },
      { type: "text", data: { text: "在说别人" } },
    ], "[CQ:at,qq=99999] 在说别人");
    expect(extractAtText(event, SELF)).toBeNull();
  });

  it("无 at 的普通群消息返回 null", () => {
    const event = makeGroupEvent(
      [{ type: "text", data: { text: "大家好" } }],
      "大家好"
    );
    expect(extractAtText(event, SELF)).toBeNull();
  });
});

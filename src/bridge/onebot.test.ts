import { describe, it, expect } from "vitest";
import {
  parseEvent,
  isPrivateMessage,
  isGroupMessage,
  detectMedia,
  getReplyContext,
  parseApiResponse,
  extractAtText,
  escapeCqText,
  isAllowedCqCode,
  encodeOutbound,
  splitMessage,
  isUserAllowed,
  MessageIdDedup,
  verifyHandshake,
  getRequestPathname,
  getProvidedToken,
  addConnection,
  sendPrivateMsg,
  sendGroupMsg,
  QQ_MAX_MESSAGE_LENGTH,
  type PrivateMessageEvent,
  type GroupMessageEvent,
} from "./onebot.js";

// ── parseEvent ──────────────────────────────

function makeFullPrivateEvent(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    time: Date.now(),
    self_id: 12345,
    post_type: "message",
    message_type: "private",
    sub_type: "friend",
    message_id: 9001,
    user_id: 123456789,
    message: "你好",
    raw_message: "你好",
    sender: { user_id: 123456789, nickname: "test", sex: "unknown", age: 0 },
    ...overrides,
  };
}

describe("parseEvent", () => {
  it("成功解析合法 JSON 事件", () => {
    const json = JSON.stringify(makeFullPrivateEvent());
    const event = parseEvent(json);
    expect(event).not.toBeNull();
    expect(event!.post_type).toBe("message");
    expect((event as PrivateMessageEvent).user_id).toBe(123456789);
  });

  it("无效 JSON 返回 null", () => {
    expect(parseEvent("not json")).toBeNull();
  });

  it("空字符串返回 null", () => {
    expect(parseEvent("")).toBeNull();
  });
});

// ── 事件字段容错（畸形事件不崩、不误路由）──

describe("parseEvent 字段容错", () => {
  it("JSON 不是对象时返回 null", () => {
    expect(parseEvent("123")).toBeNull();
    expect(parseEvent("null")).toBeNull();
    expect(parseEvent('"message"')).toBeNull();
    expect(parseEvent("[]")).toBeNull();
  });

  it("未知 post_type 返回 null", () => {
    expect(parseEvent(JSON.stringify({ post_type: "unknown_event" }))).toBeNull();
  });

  it("message 事件缺 user_id 返回 null", () => {
    const event = makeFullPrivateEvent({ user_id: undefined });
    expect(parseEvent(JSON.stringify(event))).toBeNull();
  });

  it("message 事件缺 message_id 返回 null（无法去重）", () => {
    const event = makeFullPrivateEvent({ message_id: undefined });
    expect(parseEvent(JSON.stringify(event))).toBeNull();
  });

  it("群消息缺 group_id 返回 null", () => {
    const event = makeFullPrivateEvent({
      message_type: "group",
      sub_type: "normal",
      group_id: undefined,
    });
    expect(parseEvent(JSON.stringify(event))).toBeNull();
  });

  it("缺 raw_message 时从结构化 text 段还原", () => {
    const event = makeFullPrivateEvent({
      message: [
        { type: "text", data: { text: "在吗" } },
        { type: "face", data: { id: "178" } },
        { type: "text", data: { text: "？" } },
      ],
      raw_message: undefined,
    });
    const parsed = parseEvent(JSON.stringify(event)) as PrivateMessageEvent;
    expect(parsed).not.toBeNull();
    expect(parsed.raw_message).toBe("在吗？");
  });

  it("缺 sender 时补安全默认值", () => {
    const event = makeFullPrivateEvent({ sender: undefined });
    const parsed = parseEvent(JSON.stringify(event)) as PrivateMessageEvent;
    expect(parsed).not.toBeNull();
    expect(parsed.sender.nickname).toBe("");
    expect(parsed.sender.user_id).toBe(123456789);
  });

  it("缺 message 字段时归一化为空字符串", () => {
    const event = makeFullPrivateEvent({ message: undefined });
    const parsed = parseEvent(JSON.stringify(event)) as PrivateMessageEvent;
    expect(parsed).not.toBeNull();
    expect(parsed.message).toBe("");
    expect(parsed.raw_message).toBe("你好");
  });

  it("notice/meta_event 事件只需顶层合法", () => {
    const notice = parseEvent(JSON.stringify({ post_type: "notice", user_id: 1 }));
    expect(notice).not.toBeNull();
    const meta = parseEvent(JSON.stringify({ post_type: "meta_event", meta_event_type: "heartbeat" }));
    expect(meta).not.toBeNull();
  });

  it("isPrivateMessage / isGroupMessage 对空值不抛异常", () => {
    expect(isPrivateMessage(null)).toBe(false);
    expect(isPrivateMessage(undefined)).toBe(false);
    expect(isGroupMessage(null as any)).toBe(false);
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

  it("QQ 表情转成可理解的合成文本", () => {
    const event = makePrivateEvent([{ type: "face", data: { id: "14" } }]);
    const media = detectMedia(event);
    expect(media!.type).toBe("face");
    expect(media!.syntheticText).toBe("[表情：微笑]");
  });

  it("未知 QQ 表情回退为「表情」", () => {
    const event = makePrivateEvent([{ type: "face", data: { id: "9999" } }]);
    expect(detectMedia(event)!.syntheticText).toBe("[表情：表情]");
  });

  it("表情包（mface）转成合成文本", () => {
    const event = makePrivateEvent([
      { type: "mface", data: { summary: "[动画表情]", url: "http://example.com/a.gif" } },
    ]);
    const media = detectMedia(event);
    expect(media!.type).toBe("mface");
    expect(media!.syntheticText).toBe("[表情包：动画表情]");
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

  it("畸形消息段不抛异常", () => {
    const event = makeGroupEvent(
      [null, { type: "at" }] as unknown as { type: string; data: Record<string, string> }[],
      "[CQ:at,qq=12345] hi"
    );
    expect(() => extractAtText(event, SELF)).not.toThrow();
    // 缺少 data.qq，无法确认 @ 的是自己
    expect(extractAtText(event, SELF)).toBeNull();
  });
});

// ── 出站 CQ 注入防护 ────────────────────────

describe("escapeCqText", () => {
  it("转义 CQ 元字符 & [ ]", () => {
    expect(escapeCqText("[CQ:at,qq=all]")).toBe("&#91;CQ:at,qq=all&#93;");
    expect(escapeCqText("A&B")).toBe("A&amp;B");
  });

  it("普通文本保持不变", () => {
    const text = "今天下雨了，记得带伞～ 😊";
    expect(escapeCqText(text)).toBe(text);
  });

  it("先转义 & 再转义括号，避免二次转义错乱", () => {
    expect(escapeCqText("&[CQ:face,id=1]")).toBe("&amp;&#91;CQ:face,id=1&#93;");
  });

  it("空字符串安全", () => {
    expect(escapeCqText("")).toBe("");
  });
});

describe("isAllowedCqCode", () => {
  it("放行受控 QQ 表情", () => {
    expect(isAllowedCqCode("[CQ:face,id=178]")).toBe(true);
    expect(isAllowedCqCode("[CQ:face,id=0]")).toBe(true);
    expect(isAllowedCqCode("  [CQ:face,id=12]  ")).toBe(true);
  });

  it("放行内部生成的贴纸 base64 图片", () => {
    const b64 = "A".repeat(80);
    expect(isAllowedCqCode(`[CQ:image,file=base64://${b64}]`)).toBe(true);
    expect(isAllowedCqCode("[CQ:image,file=http://evil.com/a.png]")).toBe(false);
    expect(isAllowedCqCode("[CQ:image,file=base64://short]")).toBe(false);
  });

  it("放行内部合成的语音 SILK base64", () => {
    const silk = "B".repeat(120);
    expect(isAllowedCqCode(`[CQ:record,file=base64://${silk}]`)).toBe(true);
    // 只允许 base64，不接受外链/本地路径/过短内容/额外参数
    expect(isAllowedCqCode("[CQ:record,file=http://evil.com/a.silk]")).toBe(false);
    expect(isAllowedCqCode("[CQ:record,file=/etc/passwd]")).toBe(false);
    expect(isAllowedCqCode("[CQ:record,file=base64://short]")).toBe(false);
    expect(isAllowedCqCode(`[CQ:record,file=base64://${silk},magic=false]`)).toBe(false);
  });

  it("拒绝其它 CQ 码", () => {
    expect(isAllowedCqCode("[CQ:at,qq=all]")).toBe(false);
    expect(isAllowedCqCode("[CQ:image,file=a.jpg]")).toBe(false);
    expect(isAllowedCqCode("[CQ:face,id=178,extra=1]")).toBe(false);
    expect(isAllowedCqCode("[CQ:face,id=abc]")).toBe(false);
    expect(isAllowedCqCode("[CQ:face,id=12345]")).toBe(false);
    expect(isAllowedCqCode("CQ:face,id=178")).toBe(false);
  });
});

describe("encodeOutbound", () => {
  it("模型输出中的 CQ 码被转义为普通文本", () => {
    const encoded = encodeOutbound("好的 [CQ:at,qq=all] 我来了");
    expect(encoded.droppedCq).toBe(false);
    expect(encoded.parts).toHaveLength(1);
    expect(encoded.parts[0]).not.toContain("[CQ:");
    expect(encoded.parts[0]).toContain("&#91;CQ:at,qq=all&#93;");
  });

  it("受控 qqFace 原样放行", () => {
    const encoded = encodeOutbound({ type: "cqcode", cq: "[CQ:face,id=178]" });
    expect(encoded.droppedCq).toBe(false);
    expect(encoded.parts).toEqual(["[CQ:face,id=178]"]);
  });

  it("未受控 CqCode 直接丢弃", () => {
    expect(encodeOutbound({ type: "cqcode", cq: "[CQ:at,qq=all]" })).toEqual({
      parts: [],
      droppedCq: true,
    });
    expect(encodeOutbound({ type: "cqcode", cq: "[CQ:image,file=http://x/a.jpg]" }).parts).toEqual([]);
  });

  it("超长文本按上限切分且每段都已转义", () => {
    const long = "[CQ:at,qq=all]" + "好".repeat(3000);
    const encoded = encodeOutbound(long, 500);
    expect(encoded.parts.length).toBeGreaterThan(1);
    for (const part of encoded.parts) {
      expect(part.length).toBeLessThanOrEqual(500);
      expect(part.includes("[CQ:")).toBe(false);
    }
    // 内容没有丢失
    expect(encoded.parts.join("")).toBe(escapeCqText(long));
  });

  it("空字符串不产生待发送分段", () => {
    expect(encodeOutbound("").parts).toEqual([]);
  });
});

describe("splitMessage", () => {
  it("短消息不切分", () => {
    expect(splitMessage("在吗", 100)).toEqual(["在吗"]);
  });

  it("优先在换行/句末标点处切分", () => {
    const text = "第一句。第二句。第三句。";
    const parts = splitMessage(text, 7);
    expect(parts.length).toBeGreaterThan(1);
    expect(parts[0]).toBe("第一句。");
    expect(parts.join("")).toBe(text);
  });

  it("无自然断点时硬切，且不切坏 emoji 代理对", () => {
    const text = "😊".repeat(100);
    const parts = splitMessage(text, 50);
    expect(parts.join("")).toBe(text);
    for (const part of parts) {
      const last = part.charCodeAt(part.length - 1);
      expect(last >= 0xd800 && last <= 0xdbff).toBe(false);
      // eslint-disable-next-line no-control-regex
      expect(part.length % 2).toBe(0);
    }
  });

  it("空文本返回空数组；默认上限为 QQ_MAX_MESSAGE_LENGTH", () => {
    expect(splitMessage("")).toEqual([]);
    expect(splitMessage("a".repeat(QQ_MAX_MESSAGE_LENGTH + 1)).length).toBe(2);
  });

  it("非法上限回退默认值", () => {
    expect(splitMessage("abc", Number.NaN)).toEqual(["abc"]);
  });
});

// ── 白名单判断 ──────────────────────────────

describe("isUserAllowed", () => {
  it("空白名单 = 允许全部（当前单用户阶段）", () => {
    expect(isUserAllowed(123, [])).toBe(true);
    expect(isUserAllowed(999999, [])).toBe(true);
  });

  it("命中白名单放行", () => {
    expect(isUserAllowed(123, [123, 456])).toBe(true);
    expect(isUserAllowed(456, [123, 456])).toBe(true);
  });

  it("不在白名单内拒绝", () => {
    expect(isUserAllowed(789, [123, 456])).toBe(false);
    expect(isUserAllowed(0, [123])).toBe(false);
  });

  it("非法 userId 在非空白名单下拒绝", () => {
    expect(isUserAllowed(Number.NaN, [123])).toBe(false);
    expect(isUserAllowed(undefined, [123])).toBe(false);
  });
});

// ── message_id 去重（LRU） ──────────────────

describe("MessageIdDedup", () => {
  it("首次出现返回 false，重复返回 true", () => {
    const dedup = new MessageIdDedup(10);
    expect(dedup.hasSeen(1001)).toBe(false);
    expect(dedup.hasSeen(1001)).toBe(true);
    expect(dedup.hasSeen(1002)).toBe(false);
  });

  it("超过容量后淘汰最久未使用的 id（断线重连仍可重投）", () => {
    const dedup = new MessageIdDedup(2);
    expect(dedup.hasSeen(1)).toBe(false);
    expect(dedup.hasSeen(2)).toBe(false);
    // 刷新 1 的 LRU 位置
    expect(dedup.hasSeen(1)).toBe(true);
    expect(dedup.hasSeen(3)).toBe(false);
    expect(dedup.size).toBe(2);
    // 2 最久未用，已淘汰；再次出现会被当作新消息并淘汰 1
    expect(dedup.hasSeen(2)).toBe(false);
    expect(dedup.size).toBe(2);
    expect(dedup.hasSeen(3)).toBe(true);
  });

  it("非法 message_id 不参与去重", () => {
    const dedup = new MessageIdDedup(10);
    expect(dedup.hasSeen(0)).toBe(false);
    expect(dedup.hasSeen(0)).toBe(false);
    expect(dedup.hasSeen(Number.NaN)).toBe(false);
    expect(dedup.hasSeen(null)).toBe(false);
    expect(dedup.size).toBe(0);
  });

  it("clear 清空缓存", () => {
    const dedup = new MessageIdDedup(10);
    dedup.hasSeen(1);
    dedup.clear();
    expect(dedup.hasSeen(1)).toBe(false);
  });
});

// ── 反向 WS 握手校验（绑定 path / token）──────

function makeRequest(url: string, headers: Record<string, string> = {}): any {
  return { url, headers };
}

describe("verifyHandshake", () => {
  const PATH = "/onebot/v11/ws";
  const TOKEN = "a-very-long-random-token";

  it("path 匹配且未配置 token 时放行", () => {
    const decision = verifyHandshake(makeRequest(PATH), PATH, undefined);
    expect(decision.ok).toBe(true);
    expect(decision.statusCode).toBe(101);
  });

  it("path 不匹配拒绝（404），不误放行任意路径", () => {
    const decision = verifyHandshake(makeRequest("/"), PATH, undefined);
    expect(decision.ok).toBe(false);
    expect(decision.statusCode).toBe(404);
    expect(decision.reason).toContain("路径");
  });

  it("配置 token 但请求未携带 → 401", () => {
    const decision = verifyHandshake(makeRequest(PATH), PATH, TOKEN);
    expect(decision.ok).toBe(false);
    expect(decision.statusCode).toBe(401);
  });

  it("query access_token 正确时放行", () => {
    const decision = verifyHandshake(makeRequest(`${PATH}?access_token=${TOKEN}`), PATH, TOKEN);
    expect(decision.ok).toBe(true);
  });

  it("Authorization: Bearer 正确时放行", () => {
    const decision = verifyHandshake(
      makeRequest(PATH, { authorization: `Bearer ${TOKEN}` }),
      PATH,
      TOKEN,
    );
    expect(decision.ok).toBe(true);
  });

  it("token 错误时拒绝", () => {
    expect(verifyHandshake(makeRequest(`${PATH}?access_token=wrong`), PATH, TOKEN).statusCode).toBe(401);
    expect(
      verifyHandshake(makeRequest(PATH, { authorization: "Bearer wrong-token" }), PATH, TOKEN).statusCode,
    ).toBe(401);
  });

  it("pathname 提取不包含 query 里的 token（避免日志泄露）", () => {
    expect(getRequestPathname(makeRequest(`${PATH}?access_token=${TOKEN}`))).toBe(PATH);
    expect(getRequestPathname(makeRequest("/foo?access_token=secret"))).toBe("/foo");
  });

  it("getProvidedToken 优先 query，其次 Bearer", () => {
    expect(getProvidedToken(makeRequest(`${PATH}?access_token=q1`))).toBe("q1");
    expect(getProvidedToken(makeRequest(PATH, { authorization: `Bearer h1` }))).toBe("h1");
    expect(getProvidedToken(makeRequest(PATH))).toBeNull();
  });
});

// ── 出站协议线格式（假 WS 连接）──────────────

interface FakeConnection {
  frames: Array<{ action: string; params: Record<string, unknown> }>;
  close: () => void;
}

function createFakeConnection(): FakeConnection {
  const frames: FakeConnection["frames"] = [];
  let closeHandler: (() => void) | null = null;
  const ws = {
    readyState: 1,
    OPEN: 1,
    on(event: string, cb: () => void) {
      if (event === "close") closeHandler = cb;
    },
    send(data: string) {
      frames.push(JSON.parse(data));
    },
  };
  addConnection(ws as any);
  return {
    frames,
    close: () => {
      closeHandler?.();
    },
  };
}

describe("出站消息协议线格式", () => {
  it("普通文本在协议线上做 CQ 转义（[CQ: 不会被执行）", () => {
    const conn = createFakeConnection();
    try {
      const ok = sendPrivateMsg(123, "好的[CQ:at,qq=all]");
      expect(ok).toBe(true);
      expect(conn.frames).toHaveLength(1);
      expect(conn.frames[0].action).toBe("send_private_msg");
      expect(conn.frames[0].params.user_id).toBe(123);
      expect(conn.frames[0].params.auto_escape).toBe(false);
      expect(conn.frames[0].params.message).toBe("好的&#91;CQ:at,qq=all&#93;");
    } finally {
      conn.close();
    }
  });

  it("受控 qqFace 以 CQ 码原样发送", () => {
    const conn = createFakeConnection();
    try {
      sendGroupMsg(456, { type: "cqcode", cq: "[CQ:face,id=178]" });
      expect(conn.frames[0].action).toBe("send_group_msg");
      expect(conn.frames[0].params.group_id).toBe(456);
      expect(conn.frames[0].params.message).toBe("[CQ:face,id=178]");
    } finally {
      conn.close();
    }
  });

  it("未受控 CQ 码被丢弃，不会发送", () => {
    const conn = createFakeConnection();
    try {
      const ok = sendPrivateMsg(123, { type: "cqcode", cq: "[CQ:at,qq=all]" });
      expect(ok).toBe(false);
      expect(conn.frames).toHaveLength(0);
    } finally {
      conn.close();
    }
  });

  it("超长文本按上限切分为多条发送", () => {
    const conn = createFakeConnection();
    try {
      sendPrivateMsg(123, "好".repeat(QQ_MAX_MESSAGE_LENGTH * 2 + 100));
      expect(conn.frames.length).toBeGreaterThanOrEqual(3);
      for (const frame of conn.frames) {
        expect((frame.params.message as string).length).toBeLessThanOrEqual(QQ_MAX_MESSAGE_LENGTH);
      }
    } finally {
      conn.close();
    }
  });
});

// ── 消息解析对畸形输入容错 ──────────────────

describe("detectMedia 畸形输入容错", () => {
  it("message 缺失/非数组/非字符串时返回 null", () => {
    const base = { user_id: 1, raw_message: "hi" } as unknown as PrivateMessageEvent;
    expect(detectMedia({ ...base, message: undefined } as any)).toBeNull();
    expect(detectMedia({ ...base, message: null } as any)).toBeNull();
    expect(detectMedia({ ...base, message: 42 } as any)).toBeNull();
    expect(detectMedia({ ...base, message: [] } as any)).toBeNull();
  });

  it("消息段缺 data 时返回 null 而非抛异常", () => {
    const event = makePrivateEvent([] as any);
    (event as any).message = [{ type: "image" }];
    expect(() => detectMedia(event)).not.toThrow();
    expect(detectMedia(event)?.type).toBe("image");
    expect(detectMedia(event)?.data).toBeNull();
  });
});

describe("getReplyContext 畸形输入容错", () => {
  it("非对象输入返回 null", () => {
    expect(getReplyContext(undefined as any)).toBeNull();
    expect(getReplyContext("text" as any)).toBeNull();
  });
});


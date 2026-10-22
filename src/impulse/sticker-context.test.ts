import { describe, expect, it } from "vitest";
import {
  buildStickerContextHint,
  isStickerQuestion,
  rememberStickerMemory,
  type StickerMemory,
} from "./sticker-context.js";

const NOW = 1_700_000_000_000;

function mem(over: Partial<StickerMemory> = {}): StickerMemory {
  return {
    note: "安慰累了的对方",
    tags: ["安慰", "好累"],
    direction: "sent",
    at: NOW,
    ...over,
  };
}

describe("sticker-context", () => {
  it("识别表情包问句", () => {
    expect(isStickerQuestion("这个小狗表情包到底是什么意思啊")).toBe(true);
    expect(isStickerQuestion("这个什么意思")).toBe(true);
    expect(isStickerQuestion("今天吃什么")).toBe(false);
  });

  it("命中 sent/received 备注", () => {
    const hint = buildStickerContextHint({
      userText: "这个表情什么意思",
      memories: [
        mem({ direction: "sent", note: "嘲讽对方装逼", tags: ["嘲讽"] }),
        mem({ direction: "received", note: "安慰累了的对方", tags: ["安慰"], at: NOW - 1000 }),
      ],
      now: NOW,
    });
    expect(hint).toContain("嘲讽对方装逼");
    expect(hint).toContain("安慰累了的对方");
    expect(hint).toContain("仅内部可见");
  });

  it("过期/空 note/非问句返回 null", () => {
    expect(
      buildStickerContextHint({
        userText: "这个表情什么意思",
        memories: [mem({ at: NOW - 31 * 60 * 1000 })],
        now: NOW,
      }),
    ).toBeNull();
    expect(
      buildStickerContextHint({ userText: "这个表情什么意思", memories: [mem({ note: "" })], now: NOW }),
    ).toBeNull();
    expect(
      buildStickerContextHint({ userText: "今天吃什么", memories: [mem()], now: NOW }),
    ).toBeNull();
  });

  it("remember 去重并保留最近 5 条", () => {
    let list: StickerMemory[] = [];
    for (let i = 0; i < 8; i++) list = rememberStickerMemory(list, mem({ note: `note-${i}`, at: NOW + i }), NOW + i);
    expect(list).toHaveLength(5);
    expect(list.at(-1)?.note).toBe("note-7");
    list = rememberStickerMemory(list, mem({ note: "note-7", at: NOW + 100 }), NOW + 100);
    expect(list.filter((m) => m.note === "note-7")).toHaveLength(1);
  });
});

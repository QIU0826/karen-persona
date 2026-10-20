/**
 * 打错字 → 撤回 → 重发修正：决策纯函数 + onebot 受控撤回测试。
 *
 * 不依赖真实 QQ/网络：撤回链路用 fake WebSocket 扮演 NapCat，
 * 直接驱动 `tryResolveApiResponse` 完成 send_private_msg / delete_msg 的 echo 匹配。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WebSocket } from "ws";
import {
  DEFAULT_TYPO_RECALL_SETTINGS,
  introduceTypo,
  isTypoEligibleText,
  planTypoRecall,
  resolveTypoRecallSettings,
  type TypoRecallSettings,
} from "./typo-recall.js";
import {
  addConnection,
  evaluateRecallAllowed,
  recallMessage,
  sendPrivateMsgAsync,
  tryResolveApiResponse,
} from "../bridge/onebot.js";

function settings(overrides: Partial<TypoRecallSettings> = {}): TypoRecallSettings {
  return { ...DEFAULT_TYPO_RECALL_SETTINGS, ...overrides };
}

// ── 配置解析 ─────────────────────────────────────

describe("resolveTypoRecallSettings", () => {
  it("空配置返回默认值（低频开启）", () => {
    const resolved = resolveTypoRecallSettings(undefined);
    expect(resolved).toEqual(DEFAULT_TYPO_RECALL_SETTINGS);
    expect(resolved.enabled).toBe(true);
    expect(resolved.probability).toBeCloseTo(0.04, 6);
  });

  it("读取四个扁平配置键（含字符串兼容）", () => {
    const resolved = resolveTypoRecallSettings({
      typo_recall_enabled: "true",
      typo_recall_probability: "0.2",
      typo_recall_delay_ms: "1800",
      typo_recall_cooldown_minutes: "5",
    });
    expect(resolved.enabled).toBe(true);
    expect(resolved.probability).toBeCloseTo(0.2, 6);
    expect(resolved.delayMs).toBe(1800);
    expect(resolved.cooldownMinutes).toBe(5);
  });

  it("非法值回退默认并 clamp 到安全范围", () => {
    const resolved = resolveTypoRecallSettings({
      typo_recall_probability: 9,
      typo_recall_delay_ms: 10,
      typo_recall_cooldown_minutes: -3,
      typo_recall_enabled: "maybe",
    });
    expect(resolved.enabled).toBe(DEFAULT_TYPO_RECALL_SETTINGS.enabled);
    expect(resolved.probability).toBe(1);
    expect(resolved.delayMs).toBe(500);
    expect(resolved.cooldownMinutes).toBe(0);
  });

  it("defaults 参数可覆盖默认值；delay 上界 clamp 到 5000", () => {
    const resolved = resolveTypoRecallSettings(undefined, { enabled: false, delayMs: 99999 });
    expect(resolved.enabled).toBe(false);
    expect(resolved.delayMs).toBe(5000);
  });
});

// ── 文本资格 / 错字生成 ──────────────────────────

describe("isTypoEligibleText", () => {
  it("正常单句可演", () => {
    expect(isTypoEligibleText("今天天气不错，出去走走吗")).toBe(true);
  });

  it("过短/过长/换行/CQ/URL 不可演", () => {
    expect(isTypoEligibleText("嗯")).toBe(false);
    expect(isTypoEligibleText("好".repeat(41))).toBe(false);
    expect(isTypoEligibleText("第一行\n第二行")).toBe(false);
    expect(isTypoEligibleText("看[CQ:face,id=1]这个")).toBe(false);
    expect(isTypoEligibleText("看 https://example.com 吧")).toBe(false);
  });
});

describe("introduceTypo", () => {
  it("重复字策略（random=0）", () => {
    const typo = introduceTypo("今天天气不错", () => 0);
    expect(typo).not.toBeNull();
    expect(typo).not.toBe("今天天气不错");
    expect(Array.from(typo!).length).toBe(7); // 多了一个重复字
  });

  it("相邻字互换策略（random=0.3）", () => {
    const typo = introduceTypo("今天天气不错", () => 0.3);
    expect(typo).not.toBeNull();
    expect(typo).not.toBe("今天天气不错");
  });

  it("同音字替换策略（random=0.55，文本含「在」）", () => {
    const typo = introduceTypo("我在家里等你回来", () => 0.55);
    expect(typo).toContain("再"); // 在 → 再
    expect(typo).not.toBe("我在家里等你回来");
  });

  it("标点策略：有句末标点则删掉（random=0.8）", () => {
    expect(introduceTypo("今天天气不错。", () => 0.8)).toBe("今天天气不错");
  });

  it("无标点时补语气词（random=0.8）", () => {
    const typo = introduceTypo("今天天气不错", () => 0.8);
    expect(typo).not.toBe("今天天气不错");
    expect(typo!.length).toBe(7);
  });

  it("不符合资格的文本返回 null", () => {
    expect(introduceTypo("嗯", () => 0)).toBeNull();
    expect(introduceTypo("[CQ:face,id=1] 你好呀", () => 0)).toBeNull();
  });
});

// ── 决策 ─────────────────────────────────────────

describe("planTypoRecall", () => {
  const ctx = { text: "今天天气不错，要不要出去走走", now: 1_000_000 };

  it("disabled：关闭时永不触发", () => {
    const plan = planTypoRecall(ctx, settings({ enabled: false }));
    expect(plan).toEqual({ recall: false, reason: "disabled" });
  });

  it("group_unsupported：群聊不演", () => {
    const plan = planTypoRecall({ ...ctx, isGroup: true }, settings());
    expect(plan.reason).toBe("group_unsupported");
  });

  it("crisis：危机轮 / 安全资源轮不演", () => {
    expect(planTypoRecall({ ...ctx, isCrisis: true }, settings()).reason).toBe("crisis");
    expect(planTypoRecall({ ...ctx, safetySent: true }, settings()).reason).toBe("crisis");
  });

  it("unsupported_text：CQ/URL/过短/过长都不演", () => {
    for (const text of ["嗯", "[CQ:face,id=1] 你好呀", "看 https://a.com 吧", "好".repeat(41)]) {
      expect(planTypoRecall({ ...ctx, text }, settings()).reason).toBe("unsupported_text");
    }
  });

  it("cooldown：冷却内不演，冷却边界之外可演", () => {
    const cooled = planTypoRecall(ctx, settings({ cooldownMinutes: 20 }), {
      lastRecallAt: ctx.now - 19 * 60_000,
      random: () => 0,
    });
    expect(cooled.reason).toBe("cooldown");

    const ready = planTypoRecall(ctx, settings({ cooldownMinutes: 20 }), {
      lastRecallAt: ctx.now - 20 * 60_000,
      random: () => 0,
    });
    expect(ready.reason).toBe("ok");
  });

  it("cooldownMinutes=0 时不冷却", () => {
    const plan = planTypoRecall(ctx, settings({ cooldownMinutes: 0 }), {
      lastRecallAt: ctx.now - 1000,
      random: () => 0,
    });
    expect(plan.reason).toBe("ok");
  });

  it("probability_miss：随机值未命中", () => {
    const plan = planTypoRecall(ctx, settings({ probability: 0.04 }), { random: () => 0.5 });
    expect(plan).toEqual({ recall: false, reason: "probability_miss" });
  });

  it("probability=0 永远不演", () => {
    expect(planTypoRecall(ctx, settings({ probability: 0 }), { random: () => 0 }).reason).toBe(
      "probability_miss"
    );
  });

  it("ok：返回错字版 + 正确原文 + 撤回延迟", () => {
    const plan = planTypoRecall(ctx, settings({ probability: 1, delayMs: 1200 }), {
      random: () => 0,
    });
    expect(plan.recall).toBe(true);
    expect(plan.reason).toBe("ok");
    expect(plan.typoText).toBeTruthy();
    expect(plan.typoText).not.toBe(ctx.text);
    expect(plan.correctedText).toBe(ctx.text);
    expect(plan.delayMs).toBe(1200);
  });
});

// ── onebot 受控撤回（fake WebSocket 扮演 NapCat）────

describe("onebot 受控撤回 delete_msg", () => {
  const sentRequests: Array<Record<string, unknown>> = [];
  let messageIdCounter = 7000;
  let deleteShouldFail = false;
  let now = 1_000_000;

  const fakeWs = {
    readyState: 1,
    OPEN: 1,
    on: () => {},
    send: (data: string): void => {
      const request = JSON.parse(data) as {
        action?: string;
        echo?: string;
        params?: Record<string, unknown>;
      };
      sentRequests.push(request);
      if (typeof request.echo !== "string") return;
      let response: Record<string, unknown>;
      if (request.action === "send_private_msg") {
        response = { retcode: 0, data: { message_id: ++messageIdCounter } };
      } else if (request.action === "delete_msg") {
        response = deleteShouldFail
          ? { retcode: 1, data: null }
          : { retcode: 0, data: null };
      } else {
        response = { retcode: 1404, data: null };
      }
      tryResolveApiResponse(JSON.stringify({ echo: request.echo, ...response }));
    },
  };

  beforeEach(() => {
    vi.spyOn(Date, "now").mockImplementation(() => now);
    deleteShouldFail = false;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("evaluateRecallAllowed 纯函数守卫", () => {
    expect(
      evaluateRecallAllowed({ messageId: 0, sentAt: undefined, lastRecallAt: 0, now }).reason
    ).toBe("invalid_id");
    expect(
      evaluateRecallAllowed({ messageId: 1, sentAt: undefined, lastRecallAt: 0, now }).reason
    ).toBe("not_recently_sent");
    expect(
      evaluateRecallAllowed({ messageId: 1, sentAt: now - 20_000, lastRecallAt: 0, now }).reason
    ).toBe("too_old");
    expect(
      evaluateRecallAllowed({ messageId: 1, sentAt: now - 1_000, lastRecallAt: now - 1_000, now })
        .reason
    ).toBe("rate_limited");
    expect(
      evaluateRecallAllowed({ messageId: 1, sentAt: now - 1_000, lastRecallAt: 0, now })
    ).toEqual({ ok: true, reason: "ok" });
  });

  it("发送拿到 message_id 后可以撤回（成功链路）", async () => {
    addConnection(fakeWs as unknown as WebSocket);
    now = 1_000_000;
    const messageId = await sendPrivateMsgAsync(123456, "今天天气不错，出去走走吗");
    expect(messageId).toBe(7001);
    expect(sentRequests[0]?.action).toBe("send_private_msg");

    expect(await recallMessage(messageId!)).toBe(true);
    expect(sentRequests[1]?.action).toBe("delete_msg");
    expect((sentRequests[1]?.params as { message_id?: number }).message_id).toBe(messageId);
  });

  it("5s 内第二次撤回被限频拒绝", async () => {
    now = 1_000_001; // 与上一条成功撤回相差 1ms
    const messageId = await sendPrivateMsgAsync(123456, "再发一条试试看");
    expect(await recallMessage(messageId!)).toBe(false);
  });

  it("delete_msg 失败返回 false（不抛异常）", async () => {
    now = 2_000_000;
    deleteShouldFail = true;
    const messageId = await sendPrivateMsgAsync(123456, "这条撤回会失败");
    expect(await recallMessage(messageId!)).toBe(false);
  });

  it("超过 15s 的消息不允许撤回；非本进程消息不允许撤回", async () => {
    now = 3_000_000;
    const messageId = await sendPrivateMsgAsync(123456, "放久一点再撤回");
    now = 3_020_000;
    expect(await recallMessage(messageId!)).toBe(false);

    expect(await recallMessage(999_999)).toBe(false);
    expect(await recallMessage(Number.NaN)).toBe(false);
  });
});

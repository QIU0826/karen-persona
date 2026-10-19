/**
 * M1 BUG-2：延迟补发队列持久化测试。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "karen-pending-"));
  process.env.KAREN_DATA_DIR = dir;
  vi.resetModules();
});

afterEach(async () => {
  try {
    const v = await import("./vector.js");
    v.closeVectorDb();
  } catch {
    // ignore
  }
  delete process.env.KAREN_DATA_DIR;
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    // ignore
  }
});

const baseInput = {
  platform: "qq-private",
  userId: "2889386774",
  userName: "测试",
  personaId: "小雅",
  text: "晚上好呀",
};

describe("pending-queue 持久化延迟队列", () => {
  it("入队后可按到期时间列出", async () => {
    const q = await import("./pending-queue.js");
    const id1 = q.enqueuePendingReply({ ...baseInput, dueAt: Date.now() + 60_000 });
    const id2 = q.enqueuePendingReply({
      ...baseInput,
      userId: "10001",
      dueAt: Date.now() + 5_000,
    });

    const rows = q.listPendingReplies("qq-private");
    expect(rows).toHaveLength(2);
    expect(rows[0].id).toBe(id2); // 先到期
    expect(rows[1].id).toBe(id1);
    expect(q.countPendingReplies()).toBe(2);
  });

  it("新消息到达时取消该用户 pending，不影响其他用户", async () => {
    const q = await import("./pending-queue.js");
    q.enqueuePendingReply({ ...baseInput, dueAt: Date.now() + 60_000 });
    q.enqueuePendingReply({ ...baseInput, userId: "10001", dueAt: Date.now() + 60_000 });

    const cancelled = q.cancelPendingReplies("qq-private", "2889386774", "用户发来新消息");
    expect(cancelled).toBe(1);
    expect(q.listPendingReplies().map((r) => r.userId)).toEqual(["10001"]);
  });

  it("完成/取消后不再出现在 pending 列表", async () => {
    const q = await import("./pending-queue.js");
    const id = q.enqueuePendingReply({ ...baseInput, dueAt: Date.now() + 60_000 });
    q.markPendingDone(id);
    expect(q.listPendingReplies()).toHaveLength(0);
    expect(q.countPendingReplies()).toBe(0);
  });

  it("失败重试按 60s × attempts 退避（上限 10 分钟）", async () => {
    const q = await import("./pending-queue.js");
    const id = q.enqueuePendingReply({ ...baseInput, dueAt: Date.now() + 1_000 });

    const first = q.markPendingAttempt(id, "NapCat 未连接");
    expect(first.attempts).toBe(1);
    expect(first.dueAt - Date.now()).toBeGreaterThan(50_000);
    expect(first.dueAt - Date.now()).toBeLessThanOrEqual(61_000);

    const second = q.markPendingAttempt(id, "再次失败");
    expect(second.attempts).toBe(2);
    expect(second.dueAt - Date.now()).toBeGreaterThan(110_000);

    const row = q.listPendingReplies()[0];
    expect(row.attempts).toBe(2);
    expect(row.lastError).toContain("再次失败");
  });

  it("清理 7 天前的完成记录", async () => {
    const q = await import("./pending-queue.js");
    const v = await import("./vector.js");
    const id = q.enqueuePendingReply({ ...baseInput, dueAt: Date.now() + 60_000 });
    q.markPendingDone(id);

    const db = v.getVectorDb();
    db.prepare(`UPDATE pending_replies SET created_at = ? WHERE id = ?`).run(
      Date.now() - 8 * 24 * 60 * 60 * 1000,
      id,
    );
    expect(q.purgeFinishedReplies()).toBe(1);
  });

  it("队列记录跨模块重新加载（模拟进程重启）", async () => {
    const q1 = await import("./pending-queue.js");
    q1.enqueuePendingReply({ ...baseInput, dueAt: Date.now() + 60_000 });
    (await import("./vector.js")).closeVectorDb();

    vi.resetModules();
    const q2 = await import("./pending-queue.js");
    const rows = q2.listPendingReplies("qq-private");
    expect(rows).toHaveLength(1);
    expect(rows[0].text).toBe("晚上好呀");
  });
});

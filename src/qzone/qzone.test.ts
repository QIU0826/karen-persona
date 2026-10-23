import { describe, expect, it, vi } from "vitest";
import { isQzoneEnabled, publishQzonePost, qzoneUgcRight } from "./qzone.js";

describe("qzone", () => {
  it("默认关闭；权限默认仅自己可见", () => {
    expect(isQzoneEnabled({})).toBe(false);
    expect(qzoneUgcRight({})).toBe(64);
    expect(qzoneUgcRight({ KAREN_QZONE_UGC_RIGHT: "1" })).toBe(1);
    expect(qzoneUgcRight({ KAREN_QZONE_UGC_RIGHT: "bad" })).toBe(64);
  });

  it("关闭时不调用 API", async () => {
    const callApi = vi.fn();
    const result = await publishQzonePost({ content: "测试", callApi });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("disabled");
    expect(callApi).not.toHaveBeenCalled();
  });

  it("开启后调用 send_qzone_msg 并返回 tid", async () => {
    process.env.KAREN_QZONE = "on";
    const callApi = vi.fn(async () => ({ tid: "abc123" }));
    const result = await publishQzonePost({
      content: "今天天气不错",
      ugcRight: 64,
      callApi,
    });
    expect(result).toMatchObject({ ok: true, tid: "abc123" });
    expect(callApi).toHaveBeenCalledWith(
      "send_qzone_msg",
      expect.objectContaining({ content: "今天天气不错", ugc_right: 64 }),
      20_000,
    );
    delete process.env.KAREN_QZONE;
  });

  it("支持图片数组（base64）", async () => {
    process.env.KAREN_QZONE = "on";
    const callApi = vi.fn(async () => ({ tid: "img" }));
    await publishQzonePost({ content: "配图", images: ["base64://abc"], callApi });
    expect(callApi).toHaveBeenCalledWith(
      "send_qzone_msg",
      expect.objectContaining({ images: ["base64://abc"] }),
      20_000,
    );
    delete process.env.KAREN_QZONE;
  });

  it("API 失败返回 ok:false", async () => {
    process.env.KAREN_QZONE = "on";
    const result = await publishQzonePost({
      content: "x",
      callApi: vi.fn(async () => {
        throw new Error("unsupported");
      }),
    });
    expect(result.ok).toBe(false);
    delete process.env.KAREN_QZONE;
  });
});

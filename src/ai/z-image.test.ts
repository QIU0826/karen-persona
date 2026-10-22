import { describe, expect, it, vi } from "vitest";
import { generateZImage, isZImageEnabled, zImageBaseUrl } from "./z-image.js";

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]);

describe("z-image", () => {
  it("识别 backend/URL", () => {
    expect(isZImageEnabled({ KAREN_IMAGE_BACKEND: "z-image" })).toBe(true);
    expect(isZImageEnabled({ ZIMAGE_URL: "http://x" })).toBe(true);
    expect(isZImageEnabled({ KAREN_IMAGE_BACKEND: "service" })).toBe(false);
    expect(zImageBaseUrl({ ZIMAGE_URL: "http://127.0.0.1:19111/" })).toBe("http://127.0.0.1:19111");
  });

  it("成功返回 PNG 和尺寸", async () => {
    const fetchFn = vi.fn(async () =>
      new Response(PNG, {
        status: 200,
        headers: { "x-image-width": "832", "x-image-height": "1216" },
      }),
    ) as unknown as typeof fetch;
    const result = await generateZImage("傍晚屋顶", {
      fetchFn,
      width: 832,
      height: 1216,
      steps: 9,
      seed: 3,
    });
    expect(result?.png.equals(PNG)).toBe(true);
    expect(result?.width).toBe(832);
    expect(result?.height).toBe(1216);
    const init = (fetchFn as unknown as ReturnType<typeof vi.fn>).mock.calls[0][1] as RequestInit;
    expect(JSON.parse(String(init.body))).toMatchObject({ prompt: "傍晚屋顶", steps: 9, seed: 3 });
  });

  it("非 PNG/HTTP 失败/异常返回 null", async () => {
    const bad = vi.fn(async () => new Response("no", { status: 200 })) as unknown as typeof fetch;
    await expect(generateZImage("x", { fetchFn: bad })).resolves.toBeNull();
    const fail = vi.fn(async () => new Response("", { status: 500 })) as unknown as typeof fetch;
    await expect(generateZImage("x", { fetchFn: fail })).resolves.toBeNull();
    const thrown = vi.fn(async () => {
      throw new Error("boom");
    }) as unknown as typeof fetch;
    await expect(generateZImage("x", { fetchFn: thrown })).resolves.toBeNull();
  });
});

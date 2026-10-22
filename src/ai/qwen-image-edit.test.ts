import { describe, expect, it, vi } from "vitest";
import {
  generateQwenImageEdit,
  isQwenImageEditEnabled,
  qwenImageEditBaseUrl,
} from "./qwen-image-edit.js";

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00]);

describe("qwen-image-edit", () => {
  it("识别 backend 和 URL", () => {
    expect(isQwenImageEditEnabled({ KAREN_IMAGE_BACKEND: "qwen-image-edit" })).toBe(true);
    expect(isQwenImageEditEnabled({ QWEN_IMAGE_EDIT_URL: "http://x" })).toBe(true);
    expect(isQwenImageEditEnabled({ KAREN_IMAGE_BACKEND: "service" })).toBe(false);
    expect(qwenImageEditBaseUrl({ QWEN_IMAGE_EDIT_URL: "http://127.0.0.1:19110/" })).toBe(
      "http://127.0.0.1:19110",
    );
  });

  it("成功返回 PNG 和尺寸", async () => {
    const fetchFn = vi.fn(async () =>
      new Response(PNG, {
        status: 200,
        headers: { "x-image-width": "832", "x-image-height": "1280" },
      }),
    ) as unknown as typeof fetch;
    const result = await generateQwenImageEdit("咖啡馆窗边", {
      fetchFn,
      baseUrl: "http://127.0.0.1:19110",
      simple: true,
      steps: 20,
      seed: 7,
    });
    expect(result?.png.equals(PNG)).toBe(true);
    expect(result?.width).toBe(832);
    expect(result?.height).toBe(1280);
    const call = (fetchFn as unknown as ReturnType<typeof vi.fn>).mock.calls[0] as unknown[];
    const init = call[1] as RequestInit;
    expect(JSON.parse(String(init.body))).toMatchObject({
      prompt: "咖啡馆窗边",
      simple: true,
      num_inference_steps: 20,
      seed: 7,
    });
  });

  it("可覆盖参考图（自拍统一画风）", async () => {
    const fetchFn = vi.fn(async () =>
      new Response(PNG, { status: 200 }),
    ) as unknown as typeof fetch;
    await generateQwenImageEdit("自拍", {
      fetchFn,
      imagePaths: ["/workspace/data/karen-ref-selfie/karen-selfie-cafe.jpg"],
    });
    const init = (fetchFn as unknown as ReturnType<typeof vi.fn>).mock.calls[0][1] as RequestInit;
    expect(JSON.parse(String(init.body))).toMatchObject({
      image_paths: ["/workspace/data/karen-ref-selfie/karen-selfie-cafe.jpg"],
    });
  });

  it("非 PNG 返回 null", async () => {
    const fetchFn = vi.fn(async () => new Response("not png", { status: 200 })) as unknown as typeof fetch;
    await expect(generateQwenImageEdit("x", { fetchFn })).resolves.toBeNull();
  });

  it("HTTP 失败/网络异常返回 null", async () => {
    const fail = vi.fn(async () => new Response("", { status: 500 })) as unknown as typeof fetch;
    await expect(generateQwenImageEdit("x", { fetchFn: fail })).resolves.toBeNull();
    const thrown = vi.fn(async () => {
      throw new Error("boom");
    }) as unknown as typeof fetch;
    await expect(generateQwenImageEdit("x", { fetchFn: thrown })).resolves.toBeNull();
  });
});

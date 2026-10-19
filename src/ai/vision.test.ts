/**
 * 视觉识别（DeepSeek Flash）测试。
 * 全部 mock：不联网、不读真实 Key；验证 base64 下载、URL 回退、无 Key、异常降级。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { createMock, openAiCtor } = vi.hoisted(() => {
  const createMock = vi.fn();
  /** mock OpenAI 构造函数（new OpenAI(...) 返回带 chat.completions.create 的对象）。 */
  const openAiCtor = vi.fn(function (this: unknown) {
    return { chat: { completions: { create: createMock } } };
  });
  return { createMock, openAiCtor };
});

vi.mock("openai", () => ({ default: openAiCtor }));

import { describeImage } from "./vision.js";

/** 最小 PNG 头 + 填充字节，足够用于文件头识别。 */
const PNG_BYTES = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
  ...new Array(64).fill(0x42),
]);

function imageResponse(bytes: Uint8Array, contentType = "image/png"): Response {
  return {
    ok: true,
    status: 200,
    headers: new Headers({
      "content-type": contentType,
      "content-length": String(bytes.length),
    }),
    arrayBuffer: async () => bytes.slice().buffer,
  } as unknown as Response;
}

function completion(content: string | null) {
  return {
    choices: [{ message: { content } }],
    usage: { prompt_tokens: 100, completion_tokens: 8, total_tokens: 108 },
  };
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.clearAllMocks();
  process.env.DEEPSEEK_API_KEY = "sk-test-key";
  delete process.env.DEEPSEEK_BASE_URL;
  delete process.env.DEEPSEEK_VISION_MODEL;
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.DEEPSEEK_API_KEY;
  delete process.env.DEEPSEEK_BASE_URL;
  delete process.env.DEEPSEEK_VISION_MODEL;
});

describe("describeImage：DeepSeek Flash 视觉", () => {
  it("下载图片成功 → 以 base64 data URL + detail high 请求，返回可用的详细描述", async () => {
    fetchMock.mockResolvedValue(imageResponse(PNG_BYTES));
    createMock.mockResolvedValue(completion("蓝天白云下有一座小房子"));

    const desc = await describeImage("http://qq.example.com/private/image.png");

    expect(desc).toBe("蓝天白云下有一座小房子");
    expect(Array.from(desc ?? "").length).toBeLessThanOrEqual(220);

    // 先下载再请求（QQ 图片 URL 常为私有地址，服务端无法访问）
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe("http://qq.example.com/private/image.png");

    expect(openAiCtor).toHaveBeenCalledTimes(1);
    const ctorArg = openAiCtor.mock.calls[0][0] as Record<string, unknown>;
    expect(ctorArg.apiKey).toBe("sk-test-key");
    expect(ctorArg.baseURL).toBe("https://api.deepseek.com");
    expect(ctorArg.maxRetries).toBe(0);

    const request = createMock.mock.calls[0][0] as {
      model: string;
      max_tokens: number;
      thinking: { type: string };
      messages: Array<{ content: Array<{ type: string; image_url?: { url: string; detail?: string } }> }>;
    };
    expect(request.model).toBe("deepseek-flash");
    expect(request.max_tokens).toBe(600);
    expect(request.thinking).toEqual({ type: "disabled" });

    const imagePart = request.messages[0].content.find((part) => part.type === "image_url");
    expect(imagePart?.image_url?.detail).toBe("high");
    expect(imagePart?.image_url?.url).toMatch(/^data:image\/png;base64,/);
  });

  it("下载失败 → 回退直接传原 URL", async () => {
    fetchMock.mockRejectedValue(new Error("network unreachable"));
    createMock.mockResolvedValue(completion("一只橘猫"));

    const desc = await describeImage("https://public.example.com/cat.jpg");

    expect(desc).toBe("一只橘猫");
    const request = createMock.mock.calls[0][0] as {
      messages: Array<{ content: Array<{ type: string; image_url?: { url: string } }> }>;
    };
    const imagePart = request.messages[0].content.find((part) => part.type === "image_url");
    expect(imagePart?.image_url?.url).toBe("https://public.example.com/cat.jpg");
  });

  it("下载返回非 2xx → 同样回退 URL", async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 404 } as unknown as Response);
    createMock.mockResolvedValue(completion("一张截图"));

    const desc = await describeImage("https://private.example.com/404.png");

    expect(desc).toBe("一张截图");
    const request = createMock.mock.calls[0][0] as {
      messages: Array<{ content: Array<{ type: string; image_url?: { url: string } }> }>;
    };
    const imagePart = request.messages[0].content.find((part) => part.type === "image_url");
    expect(imagePart?.image_url?.url).toBe("https://private.example.com/404.png");
  });

  it("无 DEEPSEEK_API_KEY → 返回 null，不构造客户端、不下载", async () => {
    delete process.env.DEEPSEEK_API_KEY;

    const desc = await describeImage("http://qq.example.com/a.png");

    expect(desc).toBeNull();
    expect(openAiCtor).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("视觉请求抛错 → 返回 null（不阻塞主流程）", async () => {
    fetchMock.mockResolvedValue(imageResponse(PNG_BYTES));
    createMock.mockRejectedValue(new Error("API 500"));

    const desc = await describeImage("http://qq.example.com/a.png");

    expect(desc).toBeNull();
  });

  it("模型返回空内容 → 返回 null", async () => {
    fetchMock.mockResolvedValue(imageResponse(PNG_BYTES));
    createMock.mockResolvedValue(completion(null));

    expect(await describeImage("http://qq.example.com/a.png")).toBeNull();
  });

  it("模型返回超长描述 → 截断到 220 字", async () => {
    fetchMock.mockResolvedValue(imageResponse(PNG_BYTES));
    createMock.mockResolvedValue(completion("很".repeat(300)));

    const desc = await describeImage("http://qq.example.com/a.png");

    expect(Array.from(desc ?? "").length).toBe(220);
  });

  it("data URL 输入 → 跳过下载直接请求", async () => {
    createMock.mockResolvedValue(completion("一张图"));

    const desc = await describeImage("data:image/png;base64,AAAA");

    expect(desc).toBe("一张图");
    expect(fetchMock).not.toHaveBeenCalled();
    const request = createMock.mock.calls[0][0] as {
      messages: Array<{ content: Array<{ type: string; image_url?: { url: string } }> }>;
    };
    const imagePart = request.messages[0].content.find((part) => part.type === "image_url");
    expect(imagePart?.image_url?.url).toBe("data:image/png;base64,AAAA");
  });

  it("DEEPSEEK_VISION_MODEL 可覆盖视觉模型名", async () => {
    process.env.DEEPSEEK_VISION_MODEL = "custom-vision";
    fetchMock.mockResolvedValue(imageResponse(PNG_BYTES));
    createMock.mockResolvedValue(completion("一张图"));

    await describeImage("http://qq.example.com/a.png");

    const request = createMock.mock.calls[0][0] as { model: string };
    expect(request.model).toBe("custom-vision");
  });
});

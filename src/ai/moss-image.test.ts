import { describe, expect, it, vi } from "vitest";
import {
  DEFAULT_MOSS_CHARACTER_URL,
  DEFAULT_MOSS_HYBRID_URL,
  DEFAULT_MOSS_IMAGE_EDIT_URL,
  DEFAULT_MOSS_IMAGE_URL,
  MOSS_DEFAULT_SKIP_LAYERS,
  editMossImage,
  generateMossCharacterImage,
  generateMossHybridImage,
  generateMossImage,
  isMossCharacterEnabled,
  isMossHybridEnabled,
  isMossImageEditEnabled,
  isMossImageEnabled,
  mossCharacterBaseUrl,
  mossEditSelfieBackend,
  mossHybridBaseUrl,
  mossImageBaseUrl,
  mossImageEditBaseUrl,
  mossTimeoutMs,
  normalizeMossSize,
} from "./moss-image.js";

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]);

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function pngResponse(): Response {
  return new Response(PNG, {
    status: 200,
    headers: {
      "x-image-width": "832",
      "x-image-height": "1216",
      "x-image-steps": "50",
      "x-image-seed": "42",
      "x-elapsed-ms": "24500",
      "x-gpu-peak-gb": "38.5",
    },
  });
}

describe("moss-image 配置", () => {
  it("默认 shadow：只有 backend 或显式 URL 才启用", () => {
    expect(isMossImageEnabled({})).toBe(false);
    expect(isMossImageEnabled({ KAREN_IMAGE_BACKEND: "service" })).toBe(false);
    expect(isMossImageEnabled({ KAREN_IMAGE_BACKEND: "moss-image" })).toBe(true);
    expect(isMossImageEnabled({ KAREN_IMAGE_BACKEND: "MOSS" })).toBe(true);
    expect(isMossImageEnabled({ MOSS_IMAGE_URL: "http://127.0.0.1:19114" })).toBe(true);
  });

  it("URL 默认值与尾斜杠归一化", () => {
    expect(DEFAULT_MOSS_IMAGE_URL).toBe("http://127.0.0.1:19114");
    expect(DEFAULT_MOSS_IMAGE_EDIT_URL).toBe("http://127.0.0.1:19115");
    expect(mossImageBaseUrl({})).toBe("http://127.0.0.1:19114");
    expect(mossImageBaseUrl({ MOSS_IMAGE_URL: "http://10.0.0.2:9000///" })).toBe(
      "http://10.0.0.2:9000",
    );
    expect(mossImageEditBaseUrl({})).toBe("http://127.0.0.1:19115");
  });

  it("自拍 moss-edit 需显式开启；默认 qwen 路径不受影响", () => {
    expect(mossEditSelfieBackend({})).toBe(false);
    expect(mossEditSelfieBackend({ KAREN_SELFIE_BACKEND: "moss-edit" })).toBe(true);
    expect(isMossImageEditEnabled({})).toBe(false);
    expect(isMossImageEditEnabled({ KAREN_SELFIE_BACKEND: "moss-edit" })).toBe(true);
    expect(isMossImageEditEnabled({ MOSS_IMAGE_EDIT_URL: "http://127.0.0.1:19115" })).toBe(true);
  });

  it("尺寸收敛到 16 的倍数与合法区间", () => {
    expect(normalizeMossSize(832, 1216)).toEqual({ width: 832, height: 1216 });
    expect(normalizeMossSize(1000, 900)).toEqual({ width: 1008, height: 896 });
    expect(normalizeMossSize(100, 100)).toEqual({ width: 256, height: 256 });
    expect(normalizeMossSize(9999, 9999)).toEqual({ width: 1536, height: 1536 });
    expect(normalizeMossSize(Number.NaN, Number.NaN)).toEqual({ width: 1024, height: 1024 });
  });

  it("超时：参数 > env > 默认，收敛到 30s–600s", () => {
    expect(mossTimeoutMs({})).toBe(300_000);
    expect(mossTimeoutMs({ MOSS_IMAGE_TIMEOUT_MS: "45000" })).toBe(45_000);
    expect(mossTimeoutMs({ MOSS_IMAGE_TIMEOUT_MS: "1" })).toBe(30_000);
    expect(mossTimeoutMs({ MOSS_IMAGE_TIMEOUT_MS: "9999999" })).toBe(600_000);
    expect(mossTimeoutMs({ MOSS_IMAGE_TIMEOUT_MS: "45000" }, 60_000)).toBe(60_000);
    expect(mossTimeoutMs({ MOSS_IMAGE_TIMEOUT_MS: "abc" })).toBe(300_000);
  });

  it("人物 LoRA 服务（moss-t2i）需显式开启；默认 qwen 不受影响", () => {
    expect(DEFAULT_MOSS_CHARACTER_URL).toBe("http://127.0.0.1:19116");
    expect(isMossCharacterEnabled({})).toBe(false);
    expect(isMossCharacterEnabled({ KAREN_SELFIE_BACKEND: "qwen" })).toBe(false);
    expect(isMossCharacterEnabled({ KAREN_SELFIE_BACKEND: "moss-t2i" })).toBe(true);
    expect(isMossCharacterEnabled({ KAREN_SELFIE_BACKEND: "MOSS-T2I-SHADOW" })).toBe(true);
    expect(isMossCharacterEnabled({ MOSS_CHARACTER_URL: "http://127.0.0.1:19116" })).toBe(true);
    expect(mossCharacterBaseUrl({})).toBe("http://127.0.0.1:19116");
    expect(mossCharacterBaseUrl({ MOSS_CHARACTER_URL: "http://10.0.0.9:9000/" })).toBe(
      "http://10.0.0.9:9000",
    );
  });
});

describe("generateMossImage", () => {
  it("成功返回 PNG 与响应头指标；默认按官方参数提交", async () => {
    const fetchFn = vi.fn(async () => pngResponse()) as unknown as typeof fetch;
    const result = await generateMossImage("傍晚的城市屋顶，暖色天空，手机随手拍", { fetchFn });
    expect(result).not.toBeNull();
    expect(result?.png.equals(PNG)).toBe(true);
    expect(result?.width).toBe(832);
    expect(result?.height).toBe(1216);
    expect(result?.steps).toBe(50);
    expect(result?.seed).toBe(42);
    expect(result?.serverElapsedMs).toBe(24500);
    expect(result?.gpuPeakGb).toBe(38.5);
    const init = (fetchFn as unknown as ReturnType<typeof vi.fn>).mock.calls[0][1] as RequestInit;
    expect(String((fetchFn as unknown as ReturnType<typeof vi.fn>).mock.calls[0][0])).toBe(
      "http://127.0.0.1:19114/generate",
    );
    expect(JSON.parse(String(init.body))).toMatchObject({
      prompt: "傍晚的城市屋顶，暖色天空，手机随手拍",
      width: 832,
      height: 1216,
      steps: 50,
      guidance_scale: 3,
      negative_prompt: "",
      uncond_skip_layers: [...MOSS_DEFAULT_SKIP_LAYERS],
    });
  });

  it("自定义尺寸/步数/guidance/seed 会提交给服务端", async () => {
    const fetchFn = vi.fn(async () => pngResponse()) as unknown as typeof fetch;
    await generateMossImage("下雨的窗边", {
      fetchFn,
      width: 1024,
      height: 1024,
      steps: 30,
      seed: 7,
      guidanceScale: 4.5,
      negativePrompt: "text",
      uncondSkipLayers: [],
    });
    const init = (fetchFn as unknown as ReturnType<typeof vi.fn>).mock.calls[0][1] as RequestInit;
    expect(JSON.parse(String(init.body))).toMatchObject({
      width: 1024,
      height: 1024,
      steps: 30,
      seed: 7,
      guidance_scale: 4.5,
      negative_prompt: "text",
      uncond_skip_layers: [],
    });
  });

  it("超时（AbortSignal）返回 null", async () => {
    const fetchFn = vi.fn(async () => {
      const err = new Error("The operation was aborted due to timeout");
      err.name = "TimeoutError";
      throw err;
    }) as unknown as typeof fetch;
    await expect(generateMossImage("x", { fetchFn, timeoutMs: 30_000 })).resolves.toBeNull();
  });

  it("非 PNG / HTTP 失败 / 网络异常都返回 null（调用方回退）", async () => {
    const notPng = vi.fn(async () => new Response("not an image")) as unknown as typeof fetch;
    await expect(generateMossImage("x", { fetchFn: notPng })).resolves.toBeNull();

    const fail = vi.fn(async () => jsonResponse({ detail: "generate failed" }, 500)) as unknown as typeof fetch;
    await expect(generateMossImage("x", { fetchFn: fail })).resolves.toBeNull();

    const thrown = vi.fn(async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof fetch;
    await expect(generateMossImage("x", { fetchFn: thrown })).resolves.toBeNull();
  });

  it("空 prompt 不发请求", async () => {
    const fetchFn = vi.fn() as unknown as typeof fetch;
    await expect(generateMossImage("   ", { fetchFn })).resolves.toBeNull();
    expect((fetchFn as unknown as ReturnType<typeof vi.fn>).mock.calls.length).toBe(0);
  });
});

describe("generateMossCharacterImage", () => {
  it("成功返回 PNG；默认提交到人物服务 19116，带触发词/负向词", async () => {
    const fetchFn = vi.fn(async () => pngResponse()) as unknown as typeof fetch;
    const prompt = "karen_style, a 24-year-old Chinese woman with shoulder-length medium-blue bob hair";
    const result = await generateMossCharacterImage(prompt, {
      fetchFn,
      negativePrompt: "text, watermark",
      seed: 4242,
    });
    expect(result?.png.equals(PNG)).toBe(true);
    const url = String((fetchFn as unknown as ReturnType<typeof vi.fn>).mock.calls[0][0]);
    const init = (fetchFn as unknown as ReturnType<typeof vi.fn>).mock.calls[0][1] as RequestInit;
    expect(url).toBe("http://127.0.0.1:19116/generate");
    expect(JSON.parse(String(init.body))).toMatchObject({
      prompt,
      width: 832,
      height: 1216,
      steps: 50,
      seed: 4242,
      negative_prompt: "text, watermark",
      uncond_skip_layers: [...MOSS_DEFAULT_SKIP_LAYERS],
    });
  });

  it("失败/超时/非 PNG 都返回 null（由 selfie 回退 Qwen/图库）", async () => {
    const fail = vi.fn(async () => jsonResponse({ detail: "generate failed" }, 500)) as unknown as typeof fetch;
    await expect(generateMossCharacterImage("karen_style", { fetchFn: fail })).resolves.toBeNull();

    const thrown = vi.fn(async () => {
      const err = new Error("timeout");
      err.name = "TimeoutError";
      throw err;
    }) as unknown as typeof fetch;
    await expect(generateMossCharacterImage("karen_style", { fetchFn: thrown })).resolves.toBeNull();

    const notPng = vi.fn(async () => new Response("busy")) as unknown as typeof fetch;
    await expect(generateMossCharacterImage("karen_style", { fetchFn: notPng })).resolves.toBeNull();
  });

  it("空 prompt 不发请求", async () => {
    const fetchFn = vi.fn() as unknown as typeof fetch;
    await expect(generateMossCharacterImage("  ", { fetchFn })).resolves.toBeNull();
    expect((fetchFn as unknown as ReturnType<typeof vi.fn>).mock.calls.length).toBe(0);
  });
});

describe("moss-hybrid wrapper 客户端", () => {
  function hybridPngResponse(): Response {
    return new Response(PNG, {
      status: 200,
      headers: {
        "x-image-width": "832",
        "x-image-height": "1280",
        "x-total-ms": "110405",
        "x-moss-ms": "39342",
        "x-fix-ms": "71061",
        "x-qwen-attempts": "1",
      },
    });
  }

  it("默认关；KAREN_SELFIE_BACKEND=moss-hybrid 或显式 URL 才启用", () => {
    expect(DEFAULT_MOSS_HYBRID_URL).toBe("http://127.0.0.1:19118");
    expect(isMossHybridEnabled({})).toBe(false);
    expect(isMossHybridEnabled({ KAREN_SELFIE_BACKEND: "qwen" })).toBe(false);
    expect(isMossHybridEnabled({ KAREN_SELFIE_BACKEND: "moss-hybrid" })).toBe(true);
    expect(isMossHybridEnabled({ KAREN_SELFIE_BACKEND: "MOSS-HYBRID-SHADOW" })).toBe(true);
    expect(isMossHybridEnabled({ MOSS_HYBRID_URL: "http://127.0.0.1:19118" })).toBe(true);
    expect(mossHybridBaseUrl({})).toBe("http://127.0.0.1:19118");
    expect(mossHybridBaseUrl({ MOSS_HYBRID_URL: "http://10.0.0.5:9000/" })).toBe("http://10.0.0.5:9000");
  });

  it("成功返回 PNG + 两段耗时响应头", async () => {
    const fetchFn = vi.fn(async () => hybridPngResponse()) as unknown as typeof fetch;
    const result = await generateMossHybridImage("咖啡馆窗边自拍", { fetchFn, fixSteps: 15, seed: 4242 });
    expect(result?.png.equals(PNG)).toBe(true);
    expect(result?.serverElapsedMs).toBe(110405);
    expect(result?.mossMs).toBe(39342);
    expect(result?.fixMs).toBe(71061);
    const url = String((fetchFn as unknown as ReturnType<typeof vi.fn>).mock.calls[0][0]);
    const init = (fetchFn as unknown as ReturnType<typeof vi.fn>).mock.calls[0][1] as RequestInit;
    expect(url).toBe("http://127.0.0.1:19118/selfie");
    expect(JSON.parse(String(init.body))).toMatchObject({
      prompt: "咖啡馆窗边自拍",
      width: 832,
      height: 1216,
      seed: 4242,
      fix_steps: 15,
    });
  });

  it("失败/超时/非 PNG 返回 null（selfie 回退 Qwen/图库）", async () => {
    const fail = vi.fn(async () => jsonResponse({ detail: "busy" }, 503)) as unknown as typeof fetch;
    await expect(generateMossHybridImage("自拍", { fetchFn: fail })).resolves.toBeNull();
    const thrown = vi.fn(async () => {
      const err = new Error("timeout");
      err.name = "TimeoutError";
      throw err;
    }) as unknown as typeof fetch;
    await expect(generateMossHybridImage("自拍", { fetchFn: thrown })).resolves.toBeNull();
    const notPng = vi.fn(async () => new Response("busy")) as unknown as typeof fetch;
    await expect(generateMossHybridImage("自拍", { fetchFn: notPng })).resolves.toBeNull();
  });
});

describe("editMossImage", () => {
  it("成功返回 PNG，提交参考图路径", async () => {
    const fetchFn = vi.fn(async () => pngResponse()) as unknown as typeof fetch;
    const result = await editMossImage("把背景换成咖啡馆", ["/workspace/data/ref/cafe.jpg"], {
      fetchFn,
      width: 960,
      height: 960,
      steps: 20,
      seed: 1,
    });
    expect(result?.png.equals(PNG)).toBe(true);
    const url = String((fetchFn as unknown as ReturnType<typeof vi.fn>).mock.calls[0][0]);
    const init = (fetchFn as unknown as ReturnType<typeof vi.fn>).mock.calls[0][1] as RequestInit;
    expect(url).toBe("http://127.0.0.1:19115/edit");
    expect(JSON.parse(String(init.body))).toMatchObject({
      prompt: "把背景换成咖啡馆",
      image_paths: ["/workspace/data/ref/cafe.jpg"],
      width: 960,
      height: 960,
      steps: 20,
      seed: 1,
    });
  });

  it("服务端 501 / 无参考图 / 异常都返回 null（自拍回退图库）", async () => {
    const notImplemented = vi.fn(async () =>
      jsonResponse({ detail: "requires Moss-Image-Edit" }, 501),
    ) as unknown as typeof fetch;
    await expect(
      editMossImage("自拍", ["/ref.jpg"], { fetchFn: notImplemented }),
    ).resolves.toBeNull();

    const fetchFn = vi.fn() as unknown as typeof fetch;
    await expect(editMossImage("自拍", [], { fetchFn })).resolves.toBeNull();
    expect((fetchFn as unknown as ReturnType<typeof vi.fn>).mock.calls.length).toBe(0);

    const thrown = vi.fn(async () => {
      throw new Error("boom");
    }) as unknown as typeof fetch;
    await expect(editMossImage("自拍", ["/ref.jpg"], { fetchFn: thrown })).resolves.toBeNull();
  });
});

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  GENERATED_RETENTION_DAYS,
  MAX_GENERATED_BYTES,
  NEGATIVE_PROMPT,
  buildComfyWorkflow,
  buildScenePrompt,
  comfyBaseUrl,
  generateImage,
  isImageGenEnabled,
} from "./comfyui.js";
import { generatedRoot, pruneGenerated, purgeGenerated, saveGeneratedImage, generatedStats } from "./generated-store.js";

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "karen-gen-"));
  process.env.KAREN_DATA_DIR = dir;
  delete process.env.KAREN_IMAGE_GEN;
  delete process.env.KAREN_COMFY_URL;
  vi.resetModules();
});

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.KAREN_DATA_DIR;
  delete process.env.KAREN_IMAGE_GEN;
  delete process.env.KAREN_COMFY_URL;
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("开关与地址", () => {
  it("默认关闭；KAREN_IMAGE_GEN=on 才开", () => {
    expect(isImageGenEnabled()).toBe(false);
    process.env.KAREN_IMAGE_GEN = "on";
    expect(isImageGenEnabled()).toBe(true);
  });

  it("ComfyUI 地址可覆盖，默认 127.0.0.1:8188", () => {
    expect(comfyBaseUrl()).toBe("http://127.0.0.1:8188");
    process.env.KAREN_COMFY_URL = "http://10.0.0.5:9000/";
    expect(comfyBaseUrl()).toBe("http://10.0.0.5:9000");
  });
});

describe("buildScenePrompt", () => {
  it("场景标签映射到具体画面（晚霞/咖啡/雨/猫）", () => {
    expect(buildScenePrompt({ tags: ["sunset"], hour: 18 })).toContain("sunset");
    expect(buildScenePrompt({ tags: ["cafe"], hour: 15 })).toContain("coffee");
    expect(buildScenePrompt({ tags: ["rain"], hour: 20 })).toContain("rainy window");
    expect(buildScenePrompt({ tags: ["cat"], hour: 14 })).toContain("cat");
  });

  it("时段影响光线描述", () => {
    expect(buildScenePrompt({ hour: 7 })).toContain("morning light");
    expect(buildScenePrompt({ hour: 12 })).toContain("daylight");
    expect(buildScenePrompt({ hour: 17 })).toContain("golden hour");
    expect(buildScenePrompt({ hour: 23 })).toContain("dim evening");
  });

  it("情绪影响色调（低落不给艳照）", () => {
    expect(buildScenePrompt({ hour: 14, emotionVector: 0.8 })).toContain("warm");
    expect(buildScenePrompt({ hour: 14, emotionVector: -0.6 })).toContain("muted");
  });

  it("始终带手机随手拍的质感提示，且不含 AI 味词", () => {
    const prompt = buildScenePrompt({ hour: 14, tags: ["city"] });
    expect(prompt).toContain("smartphone photo");
    expect(prompt).not.toContain("masterpiece");
    expect(prompt).not.toContain("best quality");
  });

  it("未知标签走兜底场景", () => {
    expect(buildScenePrompt({ tags: ["unknown_tag"], hour: 14 })).toContain("casual everyday scene");
  });
});

describe("buildComfyWorkflow", () => {
  it("包含必要节点，默认单步、832×1216、带负面提示词", () => {
    const wf = buildComfyWorkflow({ prompt: "a cat", seed: 42 }) as Record<string, { class_type: string; inputs: Record<string, unknown> }>;
    expect(Object.keys(wf)).toHaveLength(7);
    expect(wf["1"].class_type).toBe("CheckpointLoaderSimple");
    expect(wf["5"].inputs.steps).toBe(1);
    expect(wf["5"].inputs.seed).toBe(42);
    expect(wf["4"].inputs.width).toBe(832);
    expect(wf["4"].inputs.height).toBe(1216);
    expect(String(wf["3"].inputs.text)).toContain("watermark");
    expect(NEGATIVE_PROMPT).toContain("extra fingers");
  });
});

describe("generateImage：失败一律返回 ok:false（调用方回退图库）", () => {
  it("未开启时不发任何请求", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const result = await generateImage({ prompt: "x" });
    expect(result).toMatchObject({ ok: false, reason: "disabled" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("提交失败返回 submit_状态码", async () => {
    process.env.KAREN_IMAGE_GEN = "on";
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: false, status: 500 }) as unknown as Response),
    );
    expect(await generateImage({ prompt: "x" })).toMatchObject({ ok: false, reason: "submit_500" });
  });

  it("拿不到 prompt_id 立即失败", async () => {
    process.env.KAREN_IMAGE_GEN = "on";
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: true, status: 200, json: async () => ({}) }) as unknown as Response),
    );
    expect(await generateImage({ prompt: "x" })).toMatchObject({ ok: false, reason: "no_prompt_id" });
  });

  it("成功链路：提交 → 轮询 → 下载图片", async () => {
    process.env.KAREN_IMAGE_GEN = "on";
    const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (String(url).endsWith("/prompt")) {
          return { ok: true, status: 200, json: async () => ({ prompt_id: "p1" }) } as unknown as Response;
        }
        if (String(url).includes("/history/")) {
          return {
            ok: true,
            status: 200,
            json: async () => ({ p1: { outputs: { "7": { images: [{ filename: "karen_0001.png" }] } } } }),
          } as unknown as Response;
        }
        return { ok: true, status: 200, arrayBuffer: async () => bytes } as unknown as Response;
      }),
    );
    const result = await generateImage({ prompt: "x", seed: 1 }, { timeoutMs: 5_000 });
    expect(result.ok).toBe(true);
    expect(result.bytes?.length).toBe(bytes.length);
  });

  it("超大图被拒（避免把 4MB+ 塞进 QQ）", async () => {
    process.env.KAREN_IMAGE_GEN = "on";
    const huge = Buffer.alloc(MAX_GENERATED_BYTES + 1);
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (String(url).endsWith("/prompt")) {
          return { ok: true, status: 200, json: async () => ({ prompt_id: "p1" }) } as unknown as Response;
        }
        if (String(url).includes("/history/")) {
          return {
            ok: true,
            status: 200,
            json: async () => ({ p1: { outputs: { "7": { images: [{ filename: "a.png" }] } } } }),
          } as unknown as Response;
        }
        return { ok: true, status: 200, arrayBuffer: async () => huge } as unknown as Response;
      }),
    );
    expect(await generateImage({ prompt: "x" }, { timeoutMs: 5_000 })).toMatchObject({
      ok: false,
      reason: "too_large",
    });
  });
});

describe("生成物存储", () => {
  it("保存到 KAREN_DATA_DIR/generated/日期/，可统计", () => {
    const file = saveGeneratedImage(Buffer.from("abc"), { now: new Date(2026, 9, 20, 12).getTime() });
    expect(file).not.toBeNull();
    expect(file!).toContain(path.join("generated", "2026-10-20"));
    expect(fs.existsSync(file!)).toBe(true);
    const stats = generatedStats();
    expect(stats.files).toBe(1);
    expect(stats.bytes).toBe(3);
    expect(generatedRoot().startsWith(dir)).toBe(true);
  });

  it("清理超过保留期的日期目录，保留最近的和非日期目录", () => {
    // 保留期 30 天：2026-08-01 明显早于 recent-30d（2026-09-20），会被清掉
    const old = new Date(2026, 7, 1, 12).getTime();
    const recent = new Date(2026, 9, 20, 12).getTime();
    saveGeneratedImage(Buffer.from("old"), { now: old });
    saveGeneratedImage(Buffer.from("new"), { now: recent });
    fs.mkdirSync(path.join(generatedRoot(), "manual-keep"), { recursive: true });

    const result = pruneGenerated(recent);
    expect(result.removedDirs).toBeGreaterThanOrEqual(1);
    const left = fs.readdirSync(generatedRoot());
    expect(left).toContain("manual-keep");
    expect(left).toContain("2026-10-20");
    expect(GENERATED_RETENTION_DAYS).toBe(30);
  });

  it("purge 清空所有生成物（保留根目录）", () => {
    saveGeneratedImage(Buffer.from("a"));
    saveGeneratedImage(Buffer.from("b"));
    const result = purgeGenerated();
    expect(result.removedFiles).toBe(2);
    expect(fs.readdirSync(generatedRoot())).toHaveLength(0);
  });
});

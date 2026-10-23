import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  collectDependencies,
  formatDependencySnapshot,
  getLastDependencySnapshot,
  probeDependencies,
  resetDependencySnapshotForTest,
  startDependencyMonitor,
  type DependencySnapshot,
  type DependencyStatus,
} from "./dependency-health.js";

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function spec(overrides: Partial<DependencyStatus> = {}): DependencyStatus {
  return {
    name: "tts-voxcpm2",
    role: "tts",
    label: "VoxCPM2 语音合成",
    url: "http://127.0.0.1:19102",
    checkLoaded: true,
    up: true,
    latencyMs: 1,
    ...overrides,
  };
}

beforeEach(() => {
  resetDependencySnapshotForTest();
});

describe("collectDependencies", () => {
  it("按 .env 的实际后端推导依赖，不把未启用的服务算进来", () => {
    const specs = collectDependencies({
      KAREN_TTS_BACKEND: "voxcpm2",
      VOXCPM2_TTS_URL: "http://127.0.0.1:19102/",
      KAREN_ASR: "on",
      KAREN_ASR_BACKEND: "qwen-omni",
      QWEN_OMNI_URL: "http://127.0.0.1:19113",
      KAREN_EMBED: "on",
      KAREN_EMBED_URL: "http://127.0.0.1:18083",
      KAREN_IMAGE_GEN: "on",
      KAREN_IMAGE_BACKEND: "z-image",
      ZIMAGE_URL: "http://127.0.0.1:19111",
      KAREN_SELFIE_GEN: "on",
      QWEN_IMAGE_EDIT_URL: "http://127.0.0.1:19110",
    });

    expect(specs.map((item) => item.name)).toEqual([
      "tts-voxcpm2",
      "asr-qwen-omni",
      "embed-local",
      "image-z-image",
      "selfie-qwen-edit",
    ]);
    expect(specs[0]?.url).toBe("http://127.0.0.1:19102");
    expect(specs[0]?.checkLoaded).toBe(true);
    expect(specs[3]?.label).toContain("Z-Image");
    expect(specs[4]).toMatchObject({
      name: "selfie-qwen-edit",
      url: "http://127.0.0.1:19110",
      checkLoaded: true,
    });
  });

  it("全部关闭时返回空清单（say 后端没有网络依赖）", () => {
    const specs = collectDependencies({
      KAREN_TTS_BACKEND: "say",
      KAREN_ASR: "off",
      KAREN_EMBED: "off",
      KAREN_IMAGE_GEN: "off",
    });
    expect(specs).toEqual([]);
  });

  it("默认端口兜底：indextts2 / sensevoice / qwen-image-edit", () => {
    const specs = collectDependencies({
      KAREN_TTS_BACKEND: "indextts2",
      KAREN_ASR: "on",
      KAREN_ASR_BACKEND: "sensevoice",
      KAREN_IMAGE_GEN: "on",
      KAREN_IMAGE_BACKEND: "qwen-image-edit",
    });
    expect(specs.find((item) => item.name === "tts-indextts2")?.url).toBe("http://127.0.0.1:18088");
    expect(specs.find((item) => item.name === "asr-sensevoice")?.url).toBe(
      "http://127.0.0.1:19112",
    );
    expect(specs.find((item) => item.name === "image-qwen-edit")?.url).toBe(
      "http://127.0.0.1:19110",
    );
  });
});

describe("probeDependencies", () => {
  it("区分可达、loaded=false、HTTP 错误与超时/异常", async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("19102")) return response({ ok: true, loaded: true });
      if (url.includes("19113")) return response({ ok: true, loaded: false });
      if (url.includes("18083")) return response({ error: "boom" }, 500);
      throw Object.assign(new Error("connect ECONNREFUSED"), { name: "TypeError" });
    }) as unknown as typeof fetch;

    const specs = [
      spec({ name: "tts-voxcpm2", url: "http://127.0.0.1:19102" }),
      spec({ name: "asr-qwen-omni", role: "asr", url: "http://127.0.0.1:19113" }),
      spec({ name: "embed-local", role: "embed", url: "http://127.0.0.1:18083", checkLoaded: false }),
      spec({ name: "image-z-image", role: "image", url: "http://127.0.0.1:19111" }),
    ];

    const snapshot = await probeDependencies(specs, { fetchImpl, now: () => 12345 });

    expect(snapshot.checkedAt).toBe(12345);
    expect(snapshot.statuses.find((item) => item.name === "tts-voxcpm2")?.up).toBe(true);
    expect(snapshot.statuses.find((item) => item.name === "asr-qwen-omni")).toMatchObject({
      up: false,
      error: "loaded=false",
    });
    expect(snapshot.statuses.find((item) => item.name === "embed-local")).toMatchObject({
      up: false,
      httpStatus: 500,
      error: "http_500",
    });
    expect(snapshot.statuses.find((item) => item.name === "image-z-image")?.up).toBe(false);
    expect(snapshot.degraded.map((item) => item.name)).toEqual([
      "asr-qwen-omni",
      "embed-local",
      "image-z-image",
    ]);
  });

  it("单个依赖失败不拖垮其它（并发探活）", async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      if (String(input).includes("19102")) return response({ loaded: true });
      await new Promise((resolve) => setTimeout(resolve, 20));
      return response({ loaded: true });
    }) as unknown as typeof fetch;

    const snapshot = await probeDependencies(
      [
        spec({ name: "tts-voxcpm2", url: "http://127.0.0.1:19102" }),
        spec({ name: "asr-qwen-omni", role: "asr", url: "http://127.0.0.1:19113" }),
      ],
      { fetchImpl },
    );
    expect(snapshot.degraded).toEqual([]);
    expect(snapshot.statuses).toHaveLength(2);
  });
});

describe("formatDependencySnapshot", () => {
  it("输出人类可读的 ✅/❌ 行，不包含响应正文", () => {
    const snapshot: DependencySnapshot = {
      checkedAt: 1,
      statuses: [
        spec({ name: "tts-voxcpm2", up: true, latencyMs: 12 }),
        spec({ name: "asr-qwen-omni", role: "asr", up: false, latencyMs: 800, error: "timeout" }),
      ],
      degraded: [],
    };
    snapshot.degraded = [snapshot.statuses[1]!];
    const lines = formatDependencySnapshot(snapshot);
    expect(lines[0]).toContain("✅");
    expect(lines[0]).toContain("12ms");
    expect(lines[1]).toContain("❌");
    expect(lines[1]).toContain("timeout");
  });

  it("空清单时给出明确说明", () => {
    expect(formatDependencySnapshot({ checkedAt: 1, statuses: [], degraded: [] })[0]).toContain(
      "未启用",
    );
  });
});

describe("startDependencyMonitor", () => {
  it("首次 tick 写入快照并回调 previous=null；stop 后不再更新", async () => {
    const fetchImpl = vi.fn(async () => response({ loaded: true })) as unknown as typeof fetch;
    const calls: Array<{ snapshot: DependencySnapshot; previous: DependencySnapshot | null }> = [];
    const handle = startDependencyMonitor({
      intervalMs: 5_000,
      env: {
        KAREN_TTS_BACKEND: "voxcpm2",
        VOXCPM2_TTS_URL: "http://127.0.0.1:19102",
      },
      probe: { fetchImpl },
      onSnapshot: (snapshot, previous) => calls.push({ snapshot, previous }),
    });

    await vi.waitFor(() => expect(calls.length).toBe(1));
    expect(calls[0]?.previous).toBeNull();
    expect(getLastDependencySnapshot()?.statuses).toHaveLength(1);

    handle.stop();
    const before = getLastDependencySnapshot();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(getLastDependencySnapshot()).toBe(before);
  });
});

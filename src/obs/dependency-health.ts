/**
 * 依赖服务健康聚合（P0-2）。
 *
 * 为什么需要：桥接的 `/health` 以前只查 SQLite 和 WS 连接数，于是出现
 * 「VoxCPM2 / Qwen-Image-Edit / ASR 隧道全断，`/health` 仍 `ok:true`」的情况——
 * 她静默降级成系统 `say` + 旧图库 + `[语音]`，用户只能靠体感猜。
 *
 * 本模块按 `.env` 里**实际配置的后端**推导出依赖清单（TTS/ASR/嵌入/生图），
 * 并发探活各自的 `/health`，产出可缓存快照；桥接进程用它填充 `/health`，
 * CLI 用它做一次性体检（`npm run health`）。
 *
 * 安全：只探测本机回环/隧道地址，不读 Key、不打印请求正文；错误只保留类型/状态码。
 */
import { createLogger } from "./logger.js";

const log = createLogger("deps");

export type ServiceRole = "tts" | "asr" | "embed" | "image" | "cloud";

export interface DependencySpec {
  /** 稳定 id，例如 `tts-voxcpm2`。 */
  name: string;
  role: ServiceRole;
  /** 人类可读名称。 */
  label: string;
  /** 基础 URL（不带尾斜杠）。 */
  url: string;
  /** `/health` 返回 `loaded:false` 时算未就绪（模型还在加载）。 */
  checkLoaded: boolean;
  /** 探活路径，默认 `/health`；云服务用 `/models` 等。 */
  probePath?: string;
  /** 云服务未带 Key 时 401/403 也说明“可达”，按 up 处理。 */
  treatAuthAsUp?: boolean;
}

export interface DependencyStatus extends DependencySpec {
  up: boolean;
  latencyMs: number;
  httpStatus?: number;
  error?: string;
}

export interface DependencySnapshot {
  checkedAt: number;
  statuses: DependencyStatus[];
  /** 不可达的依赖（顺序与 statuses 一致）。 */
  degraded: DependencyStatus[];
}

export interface ProbeOptions {
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
  now?: () => number;
}

/** 单次探活超时（毫秒）；可用 KAREN_HEALTH_PROBE_TIMEOUT_MS 覆盖。 */
export const DEFAULT_PROBE_TIMEOUT_MS = 800;

const ROLE_ORDER: Record<ServiceRole, number> = { tts: 0, asr: 1, embed: 2, image: 3, cloud: 4 };

function trimUrl(value: string | undefined, fallback: string): string {
  const raw = (value ?? "").trim();
  return (raw || fallback).replace(/\/+$/, "");
}

function envValue(env: NodeJS.ProcessEnv, key: string): string | undefined {
  const value = env[key];
  return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
}

/**
 * 按当前 env 推导需要探活的依赖清单；未启用的能力不会出现在清单里。
 * 纯函数，测试直接传 env。
 */
export function collectDependencies(env: NodeJS.ProcessEnv = process.env): DependencySpec[] {
  const specs: DependencySpec[] = [];
  const imageBackend = (envValue(env, "KAREN_IMAGE_BACKEND") ?? "service").toLowerCase();

  // TTS：只探当前后端，避免把没启用的服务也算进“降级”。
  const ttsBackend = (envValue(env, "KAREN_TTS_BACKEND") ?? "kokoro").toLowerCase();
  if (ttsBackend === "voxcpm2") {
    specs.push({
      name: "tts-voxcpm2",
      role: "tts",
      label: "VoxCPM2 语音合成",
      url: trimUrl(envValue(env, "VOXCPM2_TTS_URL"), "http://127.0.0.1:19102"),
      checkLoaded: true,
    });
  } else if (ttsBackend === "indextts2") {
    specs.push({
      name: "tts-indextts2",
      role: "tts",
      label: "IndexTTS-2.5 语音合成",
      url: trimUrl(envValue(env, "INDEXTTS_TTS_URL"), "http://127.0.0.1:18088"),
      checkLoaded: true,
    });
  } else if (ttsBackend === "cosyvoice") {
    specs.push({
      name: "tts-cosyvoice",
      role: "tts",
      label: "CosyVoice 语音克隆",
      url: trimUrl(envValue(env, "COSYVOICE_URL"), "http://127.0.0.1:18087"),
      checkLoaded: true,
    });
  } else if (ttsBackend === "kokoro") {
    specs.push({
      name: "tts-kokoro",
      role: "tts",
      label: "Kokoro 语音合成",
      url: trimUrl(envValue(env, "KOKORO_TTS_URL"), "http://127.0.0.1:18086"),
      checkLoaded: false,
    });
  }
  // say 后端是本机系统能力，没有可探活的网络端点。

  // ASR：开总开关才探。
  if ((envValue(env, "KAREN_ASR") ?? "off").toLowerCase() === "on") {
    const asrBackend = (envValue(env, "KAREN_ASR_BACKEND") ?? "faster-whisper").toLowerCase();
    if (asrBackend === "qwen-omni") {
      specs.push({
        name: "asr-qwen-omni",
        role: "asr",
        label: "Qwen-Omni 语音理解",
        url: trimUrl(envValue(env, "QWEN_OMNI_URL"), "http://127.0.0.1:19113"),
        checkLoaded: true,
      });
    } else if (asrBackend === "sensevoice") {
      specs.push({
        name: "asr-sensevoice",
        role: "asr",
        label: "SenseVoice 语音识别",
        url: trimUrl(envValue(env, "SENSEVOICE_URL"), "http://127.0.0.1:19112"),
        checkLoaded: true,
      });
    } else {
      specs.push({
        name: "asr-faster-whisper",
        role: "asr",
        label: "faster-whisper 语音识别",
        url: trimUrl(envValue(env, "KAREN_ASR_URL"), "http://127.0.0.1:18085"),
        checkLoaded: false,
      });
    }
  }

  // 本地语义嵌入。
  if ((envValue(env, "KAREN_EMBED") ?? "off").toLowerCase() === "on") {
    specs.push({
      name: "embed-local",
      role: "embed",
      label: "本地语义嵌入",
      url: trimUrl(envValue(env, "KAREN_EMBED_URL"), "http://127.0.0.1:18083"),
      checkLoaded: true,
    });
  }

  // 生图：只探当前后端。
  if ((envValue(env, "KAREN_IMAGE_GEN") ?? "off").toLowerCase() === "on") {
    if (imageBackend === "z-image" || imageBackend === "zimage") {
      specs.push({
        name: "image-z-image",
        role: "image",
        label: "Z-Image 生图",
        url: trimUrl(envValue(env, "ZIMAGE_URL"), "http://127.0.0.1:19111"),
        checkLoaded: true,
      });
    } else if (imageBackend === "qwen-image-edit" || imageBackend === "qwen") {
      specs.push({
        name: "image-qwen-edit",
        role: "image",
        label: "Qwen-Image-Edit 生图",
        url: trimUrl(envValue(env, "QWEN_IMAGE_EDIT_URL"), "http://127.0.0.1:19110"),
        checkLoaded: true,
      });
    } else if (
      imageBackend === "moss-image" ||
      imageBackend === "moss" ||
      imageBackend === "moss-image-sft"
    ) {
      specs.push({
        name: "image-moss-image",
        role: "image",
        label: "MOSS-Image 生图",
        url: trimUrl(envValue(env, "MOSS_IMAGE_URL"), "http://127.0.0.1:19114"),
        checkLoaded: true,
      });
    } else if (imageBackend === "comfyui") {
      specs.push({
        name: "image-comfyui",
        role: "image",
        label: "ComfyUI 生图",
        url: trimUrl(envValue(env, "KAREN_COMFY_URL"), "http://127.0.0.1:8188"),
        checkLoaded: false,
      });
    } else {
      specs.push({
        name: "image-service",
        role: "image",
        label: "本地生图服务",
        url: trimUrl(envValue(env, "KAREN_IMAGE_URL"), "http://127.0.0.1:18084"),
        checkLoaded: true,
      });
    }
  }

  // 运行时自拍独立于 KAREN_IMAGE_BACKEND（用 Qwen-Image-Edit + cafe 参考图），
  // 所以即便生图默认走 z-image，也要单独探活自拍服务，避免它挂了没人知道。
  // MOSS-Edit 分支（KAREN_SELFIE_BACKEND=moss-edit）则探 18115。
  const selfieOn = (envValue(env, "KAREN_SELFIE_GEN") ?? "on").toLowerCase() !== "off";
  const selfieBackend = (envValue(env, "KAREN_SELFIE_BACKEND") ?? "qwen").toLowerCase();
  if (selfieOn && selfieBackend === "moss-edit") {
    specs.push({
      name: "selfie-moss-edit",
      role: "image",
      label: "MOSS-Image 自拍编辑",
      url: trimUrl(envValue(env, "MOSS_IMAGE_EDIT_URL"), "http://127.0.0.1:19115"),
      checkLoaded: true,
    });
  } else if (selfieOn && (selfieBackend === "moss-t2i" || selfieBackend === "moss-t2i-shadow" || selfieBackend === "moss-character")) {
    // GPU6 人物专用服务（MOSS-Image-SFT + Karen identity LoRA merged，18116/19116）
    specs.push({
      name: "selfie-moss-character",
      role: "image",
      label: "MOSS 人物 LoRA 自拍",
      url: trimUrl(envValue(env, "MOSS_CHARACTER_URL"), "http://127.0.0.1:19116"),
      checkLoaded: true,
    });
  } else if (selfieOn && (selfieBackend === "moss-hybrid" || selfieBackend === "moss-hybrid-shadow" || selfieBackend === "hybrid")) {
    // GPU 服务端 hybrid wrapper（MOSS v2 生成 + Qwen 修脸，18118/19118）
    specs.push({
      name: "selfie-moss-hybrid",
      role: "image",
      label: "MOSS+Qwen 混合自拍",
      url: trimUrl(envValue(env, "MOSS_HYBRID_URL"), "http://127.0.0.1:19118"),
      checkLoaded: true,
    });
  }
  const selfieUrl = envValue(env, "QWEN_IMAGE_EDIT_URL");
  if (
    selfieOn &&
    selfieUrl &&
    selfieBackend !== "moss-edit" &&
    selfieBackend !== "moss-t2i" &&
    selfieBackend !== "moss-hybrid" &&
    imageBackend !== "qwen-image-edit" &&
    imageBackend !== "qwen"
  ) {
    specs.push({
      name: "selfie-qwen-edit",
      role: "image",
      label: "Qwen-Image-Edit 自拍",
      url: trimUrl(selfieUrl, "http://127.0.0.1:19110"),
      checkLoaded: true,
    });
  }

  // 云服务（可选）：只验证网络可达，不发送 Key/不消耗 token；
  // 未带 Key 的 401/403 视为可达（DeepSeek 正常响应）。
  if ((envValue(env, "KAREN_HEALTH_CLOUD") ?? "off").toLowerCase() === "on") {
    specs.push({
      name: "cloud-deepseek",
      role: "cloud",
      label: "DeepSeek API",
      url: "https://api.deepseek.com",
      checkLoaded: false,
      probePath: "/models",
      treatAuthAsUp: true,
    });
  }

  return specs.sort(
    (a, b) => ROLE_ORDER[a.role] - ROLE_ORDER[b.role] || a.name.localeCompare(b.name),
  );
}

function safeErrorName(err: unknown): string {
  if (err instanceof Error) {
    if (err.name === "TimeoutError" || err.name === "AbortError") return "timeout";
    return err.message.slice(0, 80);
  }
  return "unknown";
}

/** 并发探活所有依赖；单个失败不影响其它。 */
export async function probeDependencies(
  specs: DependencySpec[],
  options: ProbeOptions = {},
): Promise<DependencySnapshot> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const now = options.now ?? (() => Date.now());
  const configured = Number(process.env.KAREN_HEALTH_PROBE_TIMEOUT_MS);
  const timeoutMs = Math.max(
    100,
    Math.min(10_000, options.timeoutMs ?? (Number.isFinite(configured) ? configured : DEFAULT_PROBE_TIMEOUT_MS)),
  );

  const statuses = await Promise.all(
    specs.map(async (spec): Promise<DependencyStatus> => {
      const startedAt = Date.now();
      try {
        const response = await fetchImpl(`${spec.url}${spec.probePath ?? "/health"}`, {
          method: "GET",
          signal: AbortSignal.timeout(timeoutMs),
        });
        const text = await response.text();
        let loaded: boolean | undefined;
        try {
          const body = JSON.parse(text) as { loaded?: unknown };
          if (typeof body.loaded === "boolean") loaded = body.loaded;
        } catch {
          // 非 JSON 的 /health 也允许：只看 HTTP 状态码。
        }
        const authOk =
          spec.treatAuthAsUp === true &&
          (response.status === 401 || response.status === 403);
        const up = (response.ok || authOk) && (!spec.checkLoaded || loaded !== false);
        return {
          ...spec,
          up,
          latencyMs: Date.now() - startedAt,
          httpStatus: response.status,
          ...(up ? {} : { error: loaded === false ? "loaded=false" : `http_${response.status}` }),
        };
      } catch (err) {
        return {
          ...spec,
          up: false,
          latencyMs: Date.now() - startedAt,
          error: safeErrorName(err),
        };
      }
    }),
  );

  return {
    checkedAt: now(),
    statuses,
    degraded: statuses.filter((status) => !status.up),
  };
}

/** 供 `/health` 同步读取的最近一次快照（由 monitor 更新）。 */
let lastSnapshot: DependencySnapshot | null = null;

export function getLastDependencySnapshot(): DependencySnapshot | null {
  return lastSnapshot;
}

/** 测试用：清空模块级快照。 */
export function resetDependencySnapshotForTest(): void {
  lastSnapshot = null;
}

export interface DependencyMonitorOptions {
  intervalMs?: number;
  env?: NodeJS.ProcessEnv;
  probe?: ProbeOptions;
  /** 每次探活完成时回调（桥接用来告警；测试用来断言）。 */
  onSnapshot?: (snapshot: DependencySnapshot, previous: DependencySnapshot | null) => void;
}

export interface DependencyMonitorHandle {
  stop(): void;
}

/**
 * 启动后台探活（默认 60s 一次）。单次探活不重入；返回 handle 供测试/桥接关闭。
 * 首次探活立即执行，但 `onSnapshot` 的 previous 为 null，调用方可用它区分“启动时就不通”。
 */
export function startDependencyMonitor(
  options: DependencyMonitorOptions = {},
): DependencyMonitorHandle {
  let stopped = false;
  let running = false;
  let previous: DependencySnapshot | null = lastSnapshot;
  const intervalMs = Math.max(5_000, Math.min(10 * 60_000, options.intervalMs ?? 60_000));

  const tick = async (): Promise<void> => {
    if (stopped || running) return;
    running = true;
    try {
      const specs = collectDependencies(options.env ?? process.env);
      if (specs.length === 0) {
        previous = lastSnapshot;
        return;
      }
      const next = await probeDependencies(specs, options.probe ?? {});
      lastSnapshot = next;
      try {
        options.onSnapshot?.(next, previous);
      } catch (err) {
        log.warn("deps.callback_failed", {
          error: err instanceof Error ? err.message.slice(0, 80) : "unknown",
        });
      }
      previous = next;
    } catch (err) {
      log.warn("deps.probe_failed", {
        error: err instanceof Error ? err.message.slice(0, 80) : "unknown",
      });
    } finally {
      running = false;
    }
  };

  void tick();
  const timer = setInterval(() => void tick(), intervalMs);
  timer.unref?.();

  return {
    stop(): void {
      if (stopped) return;
      stopped = true;
      clearInterval(timer);
    },
  };
}

/** 把快照压成 CLI 可打印的几行（不打印响应正文）。 */
export function formatDependencySnapshot(snapshot: DependencySnapshot): string[] {
  if (snapshot.statuses.length === 0) return ["（当前 .env 未启用需要网络探活的依赖）"];
  return [...snapshot.statuses]
    .sort((a, b) => ROLE_ORDER[a.role] - ROLE_ORDER[b.role] || a.name.localeCompare(b.name))
    .map((status) => {
      const icon = status.up ? "✅" : "❌";
      const error = status.error ? `  (${status.error})` : "";
      return `${icon} ${status.label}  ${status.url}  ${status.latencyMs}ms${error}`;
    });
}

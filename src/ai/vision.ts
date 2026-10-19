/**
 * 图片识别 — DeepSeek Flash 视觉（2026-10 起替代 Qwen-VL）。
 * 将图片 URL 转成简短中文描述，让 Karen 能自然地"看到"图片。
 *
 * 关键设计：
 * - 模型：deepseek-flash（官方唯一支持图像理解的模型；deepseek-v4-pro 不支持）。
 * - 先把图片下载为 base64 data URL 再请求：QQ/NapCat 的图片 URL 常为私有/临时地址，
 *   DeepSeek 服务端无法访问（实测直传私有 URL 返回 400 Failed to download image）；
 *   下载失败再回退直接传 URL（兼容公网可访问地址）。
 * - detail:"low"（缩放到 512×512）：实测一张 2000×1500 图 prompt tokens 从 1015 降到 208。
 * - 关闭思考模式：视觉描述不需要思维链，避免 max_tokens 被 reasoning 吃光。
 * - 描述长度 30–60 字（15 字版本会让她的回应泛化成"好看"）。
 * - 无 Key / 下载失败 / 请求失败一律静默返回 null（调用方降级为 [图片]，不阻塞聊天）。
 * - Qwen / DashScope Key 不再用于视觉，仅保留给语义嵌入（见 router.getEmbeddingConfig）。
 */
import OpenAI from "openai";

/** 官方推荐模型名（2026-10）；旧名 deepseek-v4-flash-vision-exp 已下线，服务端会映射到该模型。 */
const DEFAULT_VISION_MODEL = "deepseek-flash";
const DEFAULT_BASE_URL = "https://api.deepseek.com";
/** 视觉请求超时：15s（图片识别不能阻塞 QQ 主流程太久）。 */
const VISION_TIMEOUT_MS = 15_000;
/** 图片下载超时：10s。 */
const DOWNLOAD_TIMEOUT_MS = 10_000;
/** 图片大小上限：10MB（base64 后约 13.3MB，远小于官方 48MiB 请求体限制）。 */
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
/**
 * 输出预算：目标 30–50 字（约 60–100 tokens），留足余量避免截断；
 * 关闭思考后 reasoning 不占预算。
 */
const VISION_MAX_TOKENS = 240;
/** 描述最大字数（超过才截断；默认目标 30–50 字，给"她"足够细节可回应）。 */
const VISION_MAX_DESC_CHARS = 60;
/**
 * 视觉提示词：要求 30–50 字、有细节、可带氛围、有文字优先转述。
 * 15 字版本在真机复盘中导致她只能"还挺好看"，看不到主体/场景细节。
 */
const VISION_PROMPT =
  '用 30-50 个中文字描述这张图片：先说画面主体和场景，再补充氛围或细节；图里有文字请优先转述。不要加前缀如"图中是"，不要分点，不要评价。';
/** 支持的图片 MIME（官方：JPEG、PNG、GIF、WebP，按文件内容判断）。 */
const SUPPORTED_IMAGE_MIME = new Set(["image/jpeg", "image/png", "image/gif", "image/webp"]);

/** 返回可用的 DeepSeek Key；未配置/占位符返回 null。 */
function getDeepSeekApiKey(): string | null {
  const apiKey = process.env.DEEPSEEK_API_KEY;
  if (!apiKey || apiKey === "sk-your-key-here") return null;
  return apiKey;
}

/** 按 Unicode 码点截断，避免把 emoji / 代理对切成乱码。 */
function truncateDescription(text: string): string {
  const chars = Array.from(text);
  return chars.length > VISION_MAX_DESC_CHARS
    ? chars.slice(0, VISION_MAX_DESC_CHARS).join("")
    : text;
}

/** 去掉模型可能加上的引号/换行/多余空白。 */
function cleanDescription(content: string): string {
  return content
    .replace(/^[\s"'“”‘’「」『』]+|[\s"'“”‘’「」『』]+$/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * 根据响应头 / 文件头判断图片真实 MIME。
 * 官方按文件内容而非文件名判断格式；data URL 的 media type 也必须正确。
 */
function detectImageMime(bytes: Uint8Array, contentType: string | null): string {
  const declared = (contentType ?? "").split(";")[0].trim().toLowerCase();
  if (SUPPORTED_IMAGE_MIME.has(declared)) return declared;

  if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) {
    return "image/png";
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return "image/jpeg";
  }
  if (bytes.length >= 6 && bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46) {
    return "image/gif";
  }
  if (
    bytes.length >= 12 &&
    bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 &&
    bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50
  ) {
    return "image/webp";
  }
  // 无法识别时按 JPEG 兜底（服务端仍会按内容再判断）
  return "image/jpeg";
}

/**
 * 下载图片并转成 data URL。
 * 失败（网络错误 / 非 2xx / 空图 / 超过 10MB）返回 null，调用方回退为直传 URL。
 */
async function downloadAsDataUrl(imageUrl: string): Promise<string | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DOWNLOAD_TIMEOUT_MS);
  try {
    const response = await fetch(imageUrl, { signal: controller.signal });
    if (!response.ok) return null;

    // 先看声明大小，避免把超大文件读进内存
    const contentLength = Number(response.headers.get("content-length"));
    if (Number.isFinite(contentLength) && contentLength > MAX_IMAGE_BYTES) return null;

    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.byteLength === 0 || buffer.byteLength > MAX_IMAGE_BYTES) return null;

    const mime = detectImageMime(buffer, response.headers.get("content-type"));
    return `data:${mime};base64,${buffer.toString("base64")}`;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 用 DeepSeek Flash 识别图片内容，返回 30–60 字中文描述（主体+场景+氛围/细节）。
 * 失败时返回 null，调用方应降级为 [图片] 占位符。
 */
export async function describeImage(imageUrl: string): Promise<string | null> {
  const apiKey = getDeepSeekApiKey();
  if (!apiKey) return null;

  const baseURL = process.env.DEEPSEEK_BASE_URL || DEFAULT_BASE_URL;
  const model = process.env.DEEPSEEK_VISION_MODEL || DEFAULT_VISION_MODEL;

  const client = new OpenAI({
    apiKey,
    baseURL,
    timeout: VISION_TIMEOUT_MS,
    maxRetries: 0,
  });

  try {
    // QQ/NapCat 图片 URL 常为私有地址 → 先在本地下载转 base64；data URL 直接使用
    const dataUrl = imageUrl.startsWith("data:")
      ? imageUrl
      : await downloadAsDataUrl(imageUrl);
    const imagePayload = dataUrl ?? imageUrl;

    const response = await client.chat.completions.create({
      model,
      messages: [
        {
          role: "user",
          content: [
            {
              type: "image_url",
              // detail:"low" 会先缩放到 512×512，更快更省 token
              image_url: { url: imagePayload, detail: "low" },
            },
            { type: "text", text: VISION_PROMPT },
          ],
        },
      ],
      max_tokens: VISION_MAX_TOKENS,
      temperature: 0.3,
      // DeepSeek 扩展字段：关闭思考模式（视觉描述不需要思维链）
      thinking: { type: "disabled" },
    } as unknown as OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming);

    const content = response.choices[0]?.message?.content;
    if (!content) return null;

    const cleaned = cleanDescription(content);
    if (!cleaned) return null;

    return truncateDescription(cleaned);
  } catch (err: unknown) {
    console.log(`[Vision] 识别失败: ${err instanceof Error ? err.message : "未知错误"}`);
    return null;
  }
}

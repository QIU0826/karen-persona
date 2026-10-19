/**
 * 图片识别 — Qwen-VL（P2-e）。
 * 将图片 URL 转成简短中文描述，让 Karen 能自然地"看到"图片。
 *
 * 健壮性（M0）：15s 超时；无 Key / 失败静默返回 null（调用方降级为 [图片]）；
 * 描述统一截断到 ≤15 字，避免脏数据污染 prompt。
 */
import OpenAI from "openai";

const VISION_MODEL = "qwen-vl-max";
const VISION_BASE_URL = "https://dashscope.aliyuncs.com/compatible-mode/v1";
/** 图片识别最多等 15s，超时视为失败（不阻塞主流程）。 */
const VISION_TIMEOUT_MS = 15_000;
/** 描述最大字数。 */
const VISION_MAX_DESC_CHARS = 15;

/** 按 Unicode 码点截断，避免把 emoji / 代理对切成乱码。 */
function truncateDescription(text: string): string {
  const chars = Array.from(text);
  return chars.length > VISION_MAX_DESC_CHARS
    ? chars.slice(0, VISION_MAX_DESC_CHARS).join("")
    : text;
}

/**
 * 用 Qwen-VL 识别图片内容，返回一句简短中文描述（≤15 字）。
 * 失败时返回 null，调用方应降级为 [图片] 占位符。
 */
export async function describeImage(imageUrl: string): Promise<string | null> {
  const apiKey = process.env.QWEN_VL_API_KEY;
  if (!apiKey || apiKey === "your-key-here") return null;

  const client = new OpenAI({
    apiKey,
    baseURL: VISION_BASE_URL,
    timeout: VISION_TIMEOUT_MS,
    maxRetries: 0,
  });

  try {
    const response = await client.chat.completions.create({
      model: VISION_MODEL,
      messages: [
        {
          role: "user",
          content: [
            {
              type: "image_url",
              image_url: { url: imageUrl },
            },
            {
              type: "text",
              text: "用一句简短的中文描述这张图片的内容（不超过15个字）。如果图里有文字，优先转述文字内容。不要加前缀如\"图中是\"。",
            },
          ],
        },
      ],
      max_tokens: 30,
      temperature: 0.3,
    });

    const content = response.choices[0]?.message?.content;
    if (!content) return null;

    // 去掉模型可能加上的引号/换行，再截断到 15 字
    const cleaned = content
      .replace(/^[\s"'“”‘’「」『』]+|[\s"'“”‘’「」『』]+$/g, "")
      .replace(/\s+/g, " ")
      .trim();
    if (!cleaned) return null;

    return truncateDescription(cleaned);
  } catch (err: unknown) {
    console.log(`[Vision] 识别失败: ${err instanceof Error ? err.message : "未知错误"}`);
    return null;
  }
}

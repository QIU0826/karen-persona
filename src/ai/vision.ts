/**
 * 图片识别 — Qwen-VL（P2-e）。
 * 将图片 URL 转成简短中文描述，让 Karen 能自然地"看到"图片。
 */
import OpenAI from "openai";

const VISION_MODEL = "qwen-vl-max";
const VISION_BASE_URL = "https://dashscope.aliyuncs.com/compatible-mode/v1";

/**
 * 用 Qwen-VL 识别图片内容，返回一句简短中文描述。
 * 失败时返回 null，调用方应降级为 [图片] 占位符。
 */
export async function describeImage(imageUrl: string): Promise<string | null> {
  const apiKey = process.env.QWEN_VL_API_KEY;
  if (!apiKey || apiKey === "your-key-here") return null;

  const client = new OpenAI({ apiKey, baseURL: VISION_BASE_URL });

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
    if (!content || content.trim().length === 0) return null;
    return content.trim();
  } catch (err: unknown) {
    console.log(`[Vision] 识别失败: ${err instanceof Error ? err.message : "未知错误"}`);
    return null;
  }
}

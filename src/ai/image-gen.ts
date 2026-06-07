/**
 * 图片生成（域八）。
 * Phase 5: Unsplash（风景）+ 即梦/Flux（人物）接口。
 */

import axios from "axios";

export type ImageCategory = "scenery" | "portrait" | "food" | "mood";

export interface GeneratedImage {
  url: string;
  thumbnail?: string;
  description: string;
  category: ImageCategory;
  source: "unsplash" | "jimeng" | "local";
}

/**
 * 从 Unsplash 获取风景/场景照片。
 * 使用 Unsplash 免费 API（演示模式，限速 50 次/小时）。
 */
export async function fetchUnsplashPhoto(
  query: string
): Promise<string | null> {
  const accessKey = process.env.UNSPLASH_ACCESS_KEY;
  if (!accessKey || accessKey === "your-key-here") {
    // 无 API Key 时返回 Unsplash 的公开随机图
    return `https://source.unsplash.com/800x600/?${encodeURIComponent(query)}`;
  }

  try {
    const resp = await axios.get("https://api.unsplash.com/photos/random", {
      params: { query, count: 1, orientation: "squarish" },
      headers: { Authorization: `Client-ID ${accessKey}` },
      timeout: 5000,
    });
    return resp.data[0]?.urls?.regular || null;
  } catch {
    return null;
  }
}

/**
 * 根据人设场景生成照片描述文字。
 * Phase 5: 先返回描述文字（无 API 时的降级方案），Phase 6 接入即梦 API。
 */
export function generatePhotoDescription(
  category: ImageCategory,
  persona: {
    name: string;
    appearance: { style: string; features: string[] };
    location: string;
  }
): string {
  switch (category) {
    case "portrait":
      return `[自拍] ${persona.name}的照片——${persona.appearance.style}，${persona.appearance.features.slice(0, 2).join("，")}`;
    case "scenery":
      return `[风景] 在${persona.location}随手拍的——今天天气的街头一角`;
    case "food":
      return `[美食] 今天吃的东西——${persona.name}觉得值得分享`;
    case "mood":
      return `[心情图] 一个表情包或随手涂鸦——表达${persona.name}此刻的情绪`;
  }
}

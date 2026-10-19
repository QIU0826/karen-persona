/** 域二：消息类型识别 */
export type MessageType = "text" | "image" | "voice" | "video" | "file" | "call";

export function classifyMessage(rawType: unknown): MessageType {
  // Phase 6: 简单类型映射。Phase 7 接入 wechaty/Gewechat 后扩展。
  const typeMap: Record<string, MessageType> = {
    text: "text", image: "image", voice: "voice",
    video: "video", file: "file", call: "call",
  };
  return typeMap[String(rawType)] || "text";
}

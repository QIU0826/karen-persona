/**
 * 出站媒体占位符清理（v0.9.19）。
 *
 * 问题（用户反馈「回复很人机」+ 评测复现）：用户要照片时，模型会在回复正文里
 * 自己写 `[图片]` / `[照片]` / `[表情包]` 这类标记——她以为这是"发送媒体"的写法，
 * 但真实的照片/表情是程序另发的，于是用户会看到「我拍不出什么好看的 [图片]」这种
 * 机器人式残留文本。
 *
 * 处理：**assistant 出站文本**里，凡是 `[图片]`、`[图片：描述]`、`[照片]`、`[语音]`、
 * `[表情]`、`[表情包]`、`[视频]` 一律删掉（连同标记内的描述），只保留自然语言；
 * 删除后若为空，调用方不应再发这条文字（媒体本身仍由程序发送）。
 *
 * 注意：只用于**出站**（模型输出）；入站的 `[图片：…]` 是用户媒体描述，不能误删。
 * 用户可能真的在文字里发方括号（如「【书】」），全角括号/普通方括号不在清理范围。
 */

const MEDIA_MARKER = /\[(?:图片|照片|图|语音|表情包|表情|视频)(?:[：:][^\]]*)?\]/g;

/** assistant 文本里是否含媒体占位符（用于日志/测试）。 */
export function hasOutboundMediaMarker(text: string): boolean {
  return /\[(?:图片|照片|图|语音|表情包|表情|视频)(?:[：:][^\]]*)?\]/.test(text ?? "");
}

/**
 * 删除出站文本里的媒体占位符，并做轻度清洗（去行尾空白、丢空行、压缩多余空格）。
 * 返回空字符串表示「这条文本没有可发的内容」。
 */
export function stripOutboundMediaMarkers(text: string): string {
  const raw = typeof text === "string" ? text : "";
  if (!raw) return "";
  const stripped = raw.replace(MEDIA_MARKER, " ");
  const lines = stripped
    .split("\n")
    .map((line) => line.replace(/[ \t\u3000]+/g, " ").trim())
    .filter((line) => line.length > 0);
  return lines.join("\n").trim();
}

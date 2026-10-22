/**
 * 本轮媒体上下文提示（v0.9.32）。
 *
 * 目的：解决三个真实对话问题：
 * 1) 用户同时发图片和文字时，她只评图、漏掉文字里的信息；
 * 2) 用户随后问“这个不是你拍的照片吗”，她会把用户发的图认领成自己的；
 * 3) 上一轮图片仍在语境里，但新一轮只有文字时，她可能只回图不接话。
 *
 * 这里只生成“仅内部可见”的 system prompt 片段，不写 session、不发给用户。
 */
import type { ConversationSession } from "../data/history.js";

/** 用户消息里的图片/表情/语音合成标记。 */
const MEDIA_MARKER_RE = /\[(?:图片|表情包|表情|语音)[^\]]*\]/g;
/** 纯媒体标记，没有文字。 */
const ONLY_MEDIA_RE = /^\s*(?:\[(?:图片|表情包|表情|语音)[^\]]*\]\s*)+$/;
/** 最近用户消息里的图片标记。 */
const IMAGE_MARKER_RE = /\[图片/;

/** 去掉 CQ 码和媒体合成标记，只留用户真正打出来的文字。 */
export function stripMediaMarkers(text: string): string {
  return (text ?? "")
    .replace(/\[CQ:[^\]]*\]/gi, " ")
    .replace(MEDIA_MARKER_RE, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** 用户消息是否包含媒体标记。 */
export function hasMediaMarker(text: string): boolean {
  return IMAGE_MARKER_RE.test(text ?? "") || /\[(?:表情包|表情)/.test(text ?? "");
}

/**
 * 当前消息是否只有媒体（没有可接的文字）。
 * 注意：`[引用：...]` 不当作媒体；这里只判断纯媒体占位。
 */
export function isMediaOnly(text: string): boolean {
  return ONLY_MEDIA_RE.test(text ?? "");
}

/**
 * 会话里最近几轮用户消息是否带过图片（排除当前这一条）。
 * 用于“上一轮图还在语境里，但这一轮只有文字”的场景。
 */
export function hasRecentUserImage(
  session: ConversationSession,
  currentInput: string,
  lookback = 4,
): boolean {
  const users = session.messages.filter((m) => m.role === "user").slice(-lookback);
  return users.some((m) => m.content !== currentInput && IMAGE_MARKER_RE.test(m.content));
}

export interface MediaContextInput {
  /** 当前用户消息（可能含 [图片] 标记 + 文字） */
  userInput: string;
  /** 当前轮是否实际附了图片 data URL */
  hasImages: boolean;
  /** 上一轮/最近用户消息里是否有图片 */
  previousUserImage?: boolean;
  /** 表情包 note 提示（可选） */
  stickerHint?: string;
}

/**
 * 生成本轮媒体内部提示；没有媒体也没有 sticker hint 时返回空字符串。
 */
export function buildMediaContextNote(input: MediaContextInput): string {
  const userInput = input.userInput ?? "";
  const plainText = stripMediaMarkers(userInput);
  const hasImage = input.hasImages || hasMediaMarker(userInput);
  const notes: string[] = [];

  if (hasImage) {
    notes.push(
      "对方发来的图片/表情是他发来的，不是你的作品；不要说是你拍的/你发的。",
    );
  }

  if (hasImage && plainText.length >= 2) {
    notes.push(
      "这轮他同时发了图和文字。先回应文字里的信息（他说的吃饭/近况等），再自然接一句图；不要只评图。",
    );
  } else if (!hasImage && input.previousUserImage && plainText.length >= 2) {
    notes.push(
      "上一轮他发的图还在语境里。这一轮他发的是文字，先接这句文字，不要只回上一轮的图。",
    );
  }

  if (input.stickerHint) notes.push(input.stickerHint);

  if (notes.length === 0) return "";
  return `\n[媒体上下文，仅内部可见] ${notes.join(" ")}`;
}

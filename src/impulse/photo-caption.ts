/**
 * 发图配文是否要单独发（v0.9.19）。
 *
 * 用户反馈「问照片的事情，每次回复内容差不多」。排查发现：一次发图会发三条——
 *   1. 模型写的文字（例如「等等我拍一下」）
 *   2. 固定池里的配文（例如「喏」「随手拍的」）
 *   3. 图片
 * 文字已经在说照片时，第 2 条配文就是重复；而配文池按场景/照片复用，更容易撞同一句。
 *
 * 策略（纯函数，便于调参与测试）：
 * - 没有配文 → 不发；
 * - 15% 概率「干发一张」（真人也会只丢图不说话）；
 * - 文字里已经在说拍照/照片 → 70% 概率不再补配文（避免连着两条都在说同一件事）；
 * - 其余情况保留配文（有些场景配文是信息量，比如「刚出锅」）。
 */
export interface PhotoCaptionDecisionInput {
  /** 本轮已发出的文字（可能为空） */
  replyText: string;
  /** 候选配文 */
  caption?: string | null;
  /** 可注入随机源（0..1） */
  random?: () => number;
}

const PHOTO_TALK = /(拍|照片|相册|给你看|给你发|看这|瞧瞧|翻翻|发你|快门|镜头)/;

export function shouldSendPhotoCaption(input: PhotoCaptionDecisionInput): boolean {
  const caption = (input.caption ?? "").trim();
  if (!caption) return false;
  const random = input.random ?? Math.random;
  // 偶尔干发：只发图，不配文
  if (random() < 0.15) return false;
  const reply = (input.replyText ?? "").trim();
  if (reply && PHOTO_TALK.test(reply) && random() < 0.7) return false;
  return true;
}

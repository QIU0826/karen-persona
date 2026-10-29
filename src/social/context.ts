/**
 * 把「她最近在网上做了什么」压成一小段聊天上下文。
 * 只读审计表；不超过 200 字；不包含用户私聊或 Cookie。
 */
import type { SocialActionRecord } from "./types.js";

const LABELS: Partial<Record<SocialActionRecord["action"], string>> = {
  comment: "在 B 站评论了",
  reply: "回复了 B 站评论",
  dynamic: "发了动态",
  like: "点赞了",
  favorite: "收藏了",
  follow: "关注了",
  share: "转发了",
};

function short(text: string, n: number): string {
  const chars = Array.from(text.trim());
  return chars.length > n ? `${chars.slice(0, n).join("")}…` : chars.join("");
}

export function buildSocialContext(
  actions: SocialActionRecord[],
  now = Date.now(),
  maxChars = 200,
): string {
  const recent = actions
    .filter((a) => a.status === "sent" && a.executedAt !== undefined && now - a.executedAt < 24 * 60 * 60 * 1000)
    .sort((a, b) => (b.executedAt ?? 0) - (a.executedAt ?? 0))
    .slice(0, 3);
  if (recent.length === 0) return "";
  const lines = recent.map((a) => {
    const label = LABELS[a.action] ?? a.action;
    const target = a.target.title ? `「${short(a.target.title, 24)}」` : a.target.targetId;
    return `- ${label}${target}`;
  });
  const text = `\n## 她最近在网上\n${lines.join("\n")}\n（这些是她自己刷 B 站/发动态做的事，可以自然聊起，不要一次全说完。）`;
  return text.length > maxChars ? `${text.slice(0, maxChars)}…` : text;
}

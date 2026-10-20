/**
 * 记忆「时间感」：把记忆的绝对时间戳转成人类聊天里会说的相对时间。
 *
 * 解决的问题（docs/MEMORY_AI_TONE_AUDIT.md P1-7）：注入的 T2 记忆此前只有
 * `[对话] 用户: …`，没有「多久以前」。她无法自然地说「你上次说」「三天前」，
 * 用户也会觉得她记性没有时间层次。
 *
 * 纯函数、可注入 now（便于测试），按本地日历日判断「今天/昨天/前天」，
 * 更久远用天/周/月/年；未来时间/非法值回退空串，由调用方决定不展示。
 */

const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

function startOfLocalDay(timestampMs: number): number {
  const date = new Date(timestampMs);
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
}

/**
 * 相对时间标签（中文口语化）。
 *
 * @param timestampMs 记忆发生时间（ms）；空/非法/≤0 返回 ""
 * @param nowMs 当前时间（ms），默认 Date.now()（测试注入）
 */
export function formatMemoryTime(
  timestampMs: number | null | undefined,
  nowMs: number = Date.now(),
): string {
  if (typeof timestampMs !== "number" || !Number.isFinite(timestampMs) || timestampMs <= 0) {
    return "";
  }
  const diff = nowMs - timestampMs;
  if (diff < 0) return "刚刚";

  // 同一天：给到分钟/小时级（聊天里最常见的是"刚才/十分钟前"）
  if (startOfLocalDay(nowMs) === startOfLocalDay(timestampMs)) {
    if (diff < 5 * MINUTE_MS) return "刚刚";
    if (diff < HOUR_MS) return `${Math.max(1, Math.floor(diff / MINUTE_MS))}分钟前`;
    return `${Math.max(1, Math.floor(diff / HOUR_MS))}小时前`;
  }

  const dayDiff = Math.round((startOfLocalDay(nowMs) - startOfLocalDay(timestampMs)) / DAY_MS);
  if (dayDiff <= 0) return "今天";
  if (dayDiff === 1) return "昨天";
  if (dayDiff === 2) return "前天";
  if (dayDiff <= 7) return `${dayDiff}天前`;
  if (dayDiff <= 14) return "上周";
  if (dayDiff <= 60) return `${Math.max(2, Math.round(dayDiff / 7))}周前`;
  if (dayDiff <= 365) return `${Math.max(2, Math.round(dayDiff / 30))}个月前`;
  return `${Math.max(1, Math.floor(dayDiff / 365))}年前`;
}

/** 给 prompt 用的展示形式：`[3天前]`；没有时间标签时返回空串。 */
export function formatMemoryTimeTag(timestampMs: number | null | undefined, nowMs?: number): string {
  const label = formatMemoryTime(timestampMs, nowMs);
  return label ? `[${label}]` : "";
}

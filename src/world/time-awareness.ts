/**
 * 时间感知模块（域七）。
 * 将 persona 的 dailyRhythm 与真实时间/日期匹配。
 *
 * 双重输出：
 * - label: 结构化简码（注入 prompt，~10 tokens）
 * - awareness: 自然语言（冲动引擎素材，存在 state 里）
 */
import type { PersonalWorld } from "../persona/loader.js";

export interface TimeContext {
  /** 结构化标签（注入 prompt） */
  label: string;
  /** 自然语言感知（冲动引擎素材） */
  awareness: string;
  period: "morning" | "work" | "afternoon" | "evening" | "night";
  isRestDay: boolean;
}

const WEEKDAY_NAMES = ["日", "一", "二", "三", "四", "五", "六"];

function getPeriod(hour: number): TimeContext["period"] {
  if (hour < 8) return "morning";
  if (hour < 12) return "work";
  if (hour < 17) return "afternoon";
  if (hour < 21) return "evening";
  return "night";
}

function matchActivity(
  hour: number,
  weekday: number,
  rhythm: PersonalWorld["dailyRhythm"],
): string | null {
  const dayLabel = `周${WEEKDAY_NAMES[weekday]}`;

  for (const entry of rhythm) {
    const dayPart = entry.day;
    if (dayPart !== "每天" && !dayPart.includes(dayLabel)) continue;

    const timeRange = entry.time;
    if (timeRange === "全天") return entry.activity;

    const match = timeRange.match(/(\d{1,2}):(\d{2})\s*-\s*(\d{1,2}):(\d{2})/);
    if (match) {
      const startH = parseInt(match[1]);
      const startM = parseInt(match[2]);
      const endH = parseInt(match[3]);
      const endM = parseInt(match[4]);
      const startMin = startH * 60 + startM;
      const endMin = endH * 60 + endM;
      const nowMin = hour * 60 + new Date().getMinutes();

      if (nowMin >= startMin && nowMin <= endMin) return entry.activity;
      if (Math.abs(nowMin - startMin) <= 30) return `马上${entry.activity}`;
      if (nowMin > endMin && nowMin - endMin <= 30) return `刚${entry.activity}`;
    }

    const pointMatch = timeRange.match(/(\d{1,2}):(\d{2})/);
    if (pointMatch && !timeRange.includes("-")) {
      const tH = parseInt(pointMatch[1]);
      const tM = parseInt(pointMatch[2]);
      const tMin = tH * 60 + tM;
      const nowMin = hour * 60 + new Date().getMinutes();

      if (Math.abs(nowMin - tMin) <= 15) return `正在${entry.activity}`;
      if (nowMin > tMin && nowMin - tMin <= 30) return `刚${entry.activity}`;
    }
  }
  return null;
}

function compressActivity(
  activity: string | null,
  isRestDay: boolean,
  period: string,
): string {
  if (isRestDay) return "休息";
  if (activity) {
    let compressed = activity.replace(/^马上|^刚|^正在/, "");
    // 取分隔符第一段（最短且最有辨识度）
    compressed = compressed.split(/[——、，,]/)[0];
    if (compressed.length > 6) compressed = compressed.slice(0, 6);
    return compressed;
  }
  if (period === "work" || period === "afternoon") return "工作中";
  return "";
}

export function perceiveTime(world: PersonalWorld): TimeContext {
  const now = new Date();
  const hour = now.getHours();
  const weekday = now.getDay();
  const period = getPeriod(hour);
  const dayLabel = `周${WEEKDAY_NAMES[weekday]}`;

  const activity = matchActivity(hour, weekday, world.dailyRhythm);
  const isRestDay = world.dailyRhythm.some(
    e => (e.day.includes("休息日") || e.time === "全天") && e.day.includes(dayLabel),
  );

  // 结构化标签（极简，~8-12 tokens）
  const hourStr = `${String(hour).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;
  const activityLabel = compressActivity(activity, isRestDay, period);
  const label = `${dayLabel}${hourStr}${activityLabel ? ` ${activityLabel}` : ""}`;

  // 自然语言感知（冲动引擎素材）
  const periodDesc: Record<string, string> = {
    morning: `${dayLabel}早上，新的一天`,
    work: `${dayLabel}上午，咖啡店应该正忙`,
    afternoon: `${dayLabel}下午，${activity || "日常"}`,
    evening: `${dayLabel}傍晚，${activity || "放松时间"}`,
    night: `${dayLabel}晚上，安静的时刻`,
  };
  const awareness = activity
    ? `${dayLabel}${hour}点，${activity}`
    : periodDesc[period];

  return { label, awareness, period, isRestDay };
}

/**
 * 合并时间 + 天气 → prompt 注入用的结构化标签。
 * "现在是"开头，强调这是事实而非叙事建议。
 */
export function buildMomentTag(
  timeCtx: TimeContext,
  weather: { condition: string; temp: number },
): string {
  const parts = [timeCtx.label];
  if (weather.condition && weather.condition !== "未知") {
    parts.push(`${weather.condition}${weather.temp}°C`);
  }
  return `[现在是${parts.join("，")}]`;
}

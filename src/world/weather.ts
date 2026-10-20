/**
 * 天气感知（域七 P0）。
 * Phase 5: 觉察时刻 + 个人解释层 + 社交解释维度。
 *
 * 注意：OpenWeatherMap 的 `weather[0].main` 是英文枚举
 * （Clear / Clouds / Rain / Snow / Drizzle / Thunderstorm / Mist ...），
 * 而本文件下游（perceiveWeather 的雨天/晴天判断、orchestrator 的天气主动触发、
 * time-awareness 的 moment tag）全部按中文匹配。因此必须在入口统一映射成中文
 * condition，否则配了真实 Key 反而会让天气情绪与主动触发失效。
 */

import axios from "axios";
import type { StanceType } from "./stance.js";

export interface WeatherInfo {
  condition: string; // 中文，如 "晴", "多云", "小雨", "大雨"
  temp: number;
  humidity: number;
  description: string;
  city: string;
}

export interface WeatherPerception {
  raw: WeatherInfo;
  /** 觉察时刻的描述 */
  awarenessMoment: string;
  /** 个人解释：天气 → 情绪影响 */
  personalInterpretation: string;
  /** 社交解释：想到了谁 */
  socialInterpretation: string | null;
  /** 情绪偏移建议 */
  moodOffset: number;
}

/** 同一城市的天气缓存有效期：30 分钟（省 OpenWeatherMap 免费额度）。 */
export const WEATHER_CACHE_TTL_MS = 30 * 60 * 1000;
/** 单次 HTTP 请求超时。 */
const WEATHER_REQUEST_TIMEOUT_MS = 5_000;

/** OpenWeatherMap `weather[0].main` → 中文 condition 映射。 */
const OWM_MAIN_TO_ZH: Record<string, string> = {
  clear: "晴",
  clouds: "多云",
  rain: "雨",
  drizzle: "小雨",
  snow: "雪",
  thunderstorm: "雷阵雨",
  mist: "雾",
  fog: "雾",
  haze: "霾",
  smoke: "霾",
  dust: "沙尘",
  sand: "沙尘",
  ash: "雾",
  squall: "大风",
  tornado: "龙卷风",
};

interface OwmWeatherEntry {
  main?: string;
  description?: string;
}

interface OwmResponse {
  weather?: OwmWeatherEntry[];
  main?: { temp?: number; humidity?: number };
  name?: string;
}

interface WeatherCacheEntry {
  weather: WeatherInfo;
  expiresAt: number;
}

const weatherCache = new Map<string, WeatherCacheEntry>();

/** 清空天气缓存（测试 / 手动刷新用）。 */
export function clearWeatherCache(): void {
  weatherCache.clear();
}

function cacheKey(city: string): string {
  return city.trim().toLowerCase();
}

function hasChinese(text: string): boolean {
  return /[\u4e00-\u9fff]/.test(text);
}

/**
 * 把 OpenWeatherMap 的英文 main 映射成中文 condition。
 * 纯函数，便于单测；已返回中文的 provider / 数据直接透传。
 * 主字段缺失或无法识别时，退回中文 description；仍无中文则返回 "未知"。
 */
export function mapOwCondition(
  main?: string | null,
  description?: string | null
): string {
  const rawMain = (main ?? "").trim();
  const rawDesc = (description ?? "").trim();

  if (!rawMain) {
    return hasChinese(rawDesc) ? rawDesc : "未知";
  }
  // 兼容已经返回中文 condition 的数据源
  if (hasChinese(rawMain)) return rawMain;

  const mapped = OWM_MAIN_TO_ZH[rawMain.toLowerCase()];
  if (mapped) return mapped;

  // 未知英文枚举：优先用中文 description 兜底
  if (hasChinese(rawDesc)) return rawDesc;
  return "未知";
}

/** description 兜底：provider 未按 lang=zh_cn 返回中文时，用中文 condition 替代。 */
function normalizeDescription(description: string | undefined, condition: string): string {
  const raw = (description ?? "").trim();
  if (!raw) return condition;
  return hasChinese(raw) ? raw : condition;
}

/** 从 OpenWeatherMap 获取天气（按城市 30 分钟内存缓存，失败返回 null）。 */
export async function fetchWeather(
  city: string,
  apiKey?: string
): Promise<WeatherInfo | null> {
  const key = apiKey || process.env.OPENWEATHER_API_KEY;
  if (!key || key === "your-key-here") return null;

  const keyOfCity = cacheKey(city);
  const cached = weatherCache.get(keyOfCity);
  if (cached && cached.expiresAt > Date.now()) {
    // 返回副本，避免调用方修改污染缓存
    return { ...cached.weather };
  }

  try {
    const resp = await axios.get<OwmResponse>(
      `https://api.openweathermap.org/data/2.5/weather`,
      {
        params: { q: city, appid: key, units: "metric", lang: "zh_cn" },
        timeout: WEATHER_REQUEST_TIMEOUT_MS,
      }
    );
    const d = resp.data ?? {};
    const ow = Array.isArray(d.weather) ? d.weather[0] : undefined;

    // 结构不合法（无天气字段 / 无温度）视为失败，不写缓存
    if (!ow || typeof d.main?.temp !== "number") {
      console.log(`[天气] 响应结构异常，忽略本次结果: ${city}`);
      return null;
    }

    const condition = mapOwCondition(ow.main, ow.description);
    const weather: WeatherInfo = {
      condition,
      temp: Math.round(d.main.temp),
      humidity: typeof d.main.humidity === "number" ? d.main.humidity : 0,
      description: normalizeDescription(ow.description, condition),
      city: typeof d.name === "string" && d.name.trim() ? d.name : city,
    };

    weatherCache.set(keyOfCity, {
      weather,
      expiresAt: Date.now() + WEATHER_CACHE_TTL_MS,
    });
    return { ...weather };
  } catch (err: unknown) {
    console.log(`[天气] 获取失败(${city}): ${err instanceof Error ? err.message : "未知错误"}`);
    return null;
  }
}

/**
 * 生成模拟天气（无 API Key 时使用）。
 * 基于当前月份和随机因素生成合理天气。
 */
export function mockWeather(city: string): WeatherInfo {
  const now = new Date();
  const month = now.getMonth() + 1;

  // 基于季节的天气概率
  const isSummer = month >= 6 && month <= 8;
  const isWinter = month === 12 || month <= 2;

  const conditions = isSummer
    ? ["晴", "晴", "多云", "多云", "小雨", "雷阵雨"]
    : isWinter
    ? ["多云", "多云", "阴", "小雨", "晴", "晴"]
    : ["晴", "多云", "多云", "阴", "小雨", "晴"];

  const condition = conditions[Math.floor(Math.random() * conditions.length)];
  const temp = isSummer
    ? 28 + Math.floor(Math.random() * 10)
    : isWinter
    ? Math.floor(Math.random() * 10)
    : 15 + Math.floor(Math.random() * 15);

  return {
    condition,
    temp,
    humidity: 40 + Math.floor(Math.random() * 50),
    description: condition,
    city,
  };
}

/**
 * 天气觉察 + 解释层。
 * 感知姿态决定觉察方式，人设状态决定解释方式。
 */
export function perceiveWeather(
  weather: WeatherInfo,
  stance: StanceType,
  emotionBaseline: number,
  dayPlan: string | null
): WeatherPerception {
  // 觉察时刻
  const awareness =
    stance === "active"
      ? `醒来时看了手机天气——今天${weather.description}，${weather.temp}°C`
      : stance === "passive"
      ? `出门时才发现——"啊，${weather.description}了"`
      : `知道今天${weather.description}，但没当回事`;

  // 个人解释层
  let moodOffset = 0;
  let personalInterpretation = "";

  const isBadWeather = ["雨", "小雨", "大雨", "暴雨", "雷阵雨", "阴"].some(
    (w) => weather.condition.includes(w)
  );
  const isGoodWeather = ["晴"].some((w) => weather.condition.includes(w));

  if (isBadWeather) {
    if (emotionBaseline < 0) {
      personalInterpretation = "连天气都跟我作对……";
      moodOffset = -0.05;
    } else if (dayPlan?.includes("出门") || dayPlan?.includes("去")) {
      personalInterpretation = `${weather.description}了，本来要去${dayPlan}的……算了在家吧`;
      moodOffset = -0.1;
    } else {
      personalInterpretation = `${weather.description}天，正好窝在家里`;
      moodOffset = 0.05; // 反而觉得舒服
    }
  } else if (isGoodWeather) {
    personalInterpretation = "天气不错，心情也跟着好了点";
    moodOffset = 0.05;
  } else {
    personalInterpretation = `${weather.description}，就那样吧`;
  }

  // 社交解释
  const socialInterpretation =
    Math.random() > 0.6
      ? `想到了——"你那边也${weather.description}吗"`
      : null;

  return {
    raw: weather,
    awarenessMoment: awareness,
    personalInterpretation,
    socialInterpretation,
    moodOffset,
  };
}

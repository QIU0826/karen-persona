/**
 * 天气感知（域七 P0）。
 * Phase 5: 觉察时刻 + 个人解释层 + 社交解释维度。
 */

import axios from "axios";
import type { StanceType } from "./stance.js";

export interface WeatherInfo {
  condition: string; // 如 "晴", "多云", "小雨", "大雨"
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

/** 从 OpenWeatherMap 获取天气 */
export async function fetchWeather(
  city: string,
  apiKey?: string
): Promise<WeatherInfo | null> {
  const key = apiKey || process.env.OPENWEATHER_API_KEY;
  if (!key || key === "your-key-here") return null;

  try {
    const resp = await axios.get(
      `https://api.openweathermap.org/data/2.5/weather`,
      {
        params: { q: city, appid: key, units: "metric", lang: "zh_cn" },
        timeout: 5000,
      }
    );
    const d = resp.data;
    return {
      condition: d.weather[0]?.main || "未知",
      temp: Math.round(d.main?.temp),
      humidity: d.main?.humidity,
      description: d.weather[0]?.description || "",
      city: d.name || city,
    };
  } catch {
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
  const hour = now.getHours();

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

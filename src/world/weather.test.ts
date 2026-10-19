import { describe, it, expect, vi, beforeEach, afterEach, type MockInstance } from "vitest";
import axios from "axios";

// 全部单测走 mock，绝不真实联网。
vi.mock("axios", () => ({
  default: {
    get: vi.fn(),
  },
}));

import {
  fetchWeather,
  mapOwCondition,
  clearWeatherCache,
  mockWeather,
  perceiveWeather,
  WEATHER_CACHE_TTL_MS,
  type WeatherInfo,
} from "./weather.js";

const mockedGet = vi.mocked(axios.get);

type MockOwmPayload = {
  weather?: Array<{ main?: string; description?: string }>;
  main?: { temp?: number; humidity?: number };
  name?: string;
};

function owmPayload(overrides: MockOwmPayload = {}): MockOwmPayload {
  return {
    weather: [{ main: "Clear", description: "晴" }],
    main: { temp: 25.4, humidity: 60 },
    name: "Shanghai",
    ...overrides,
  };
}

function mockOwmOnce(data: MockOwmPayload): void {
  mockedGet.mockResolvedValueOnce({ data } as never);
}

function weatherInfo(overrides: Partial<WeatherInfo> = {}): WeatherInfo {
  return {
    condition: "雨",
    temp: 18,
    humidity: 90,
    description: "小雨",
    city: "上海",
    ...overrides,
  };
}

let logSpy: MockInstance;

beforeEach(() => {
  vi.resetAllMocks();
  clearWeatherCache();
  process.env.OPENWEATHER_API_KEY = "test-owm-key";
  // 失败降级会打印日志，测试里静音，保持输出干净
  logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
});

afterEach(() => {
  logSpy.mockRestore();
  vi.useRealTimers();
  clearWeatherCache();
  delete process.env.OPENWEATHER_API_KEY;
});

// ── mapOwCondition：OWM 英文 main → 中文 condition ─────────────

describe("mapOwCondition", () => {
  it.each([
    ["Clear", "晴"],
    ["Clouds", "多云"],
    ["Rain", "雨"],
    ["Snow", "雪"],
    ["Drizzle", "小雨"],
    ["Thunderstorm", "雷阵雨"],
    ["Mist", "雾"],
  ])("英文 main %s → 中文 %s", (main, expected) => {
    expect(mapOwCondition(main)).toBe(expected);
  });

  it("大小写不敏感", () => {
    expect(mapOwCondition("clear")).toBe("晴");
    expect(mapOwCondition("THUNDERSTORM")).toBe("雷阵雨");
  });

  it("中文 main 直接透传（兼容已返回中文的数据源）", () => {
    expect(mapOwCondition("小雨")).toBe("小雨");
  });

  it("未知英文 main 且无中文 description → 未知", () => {
    expect(mapOwCondition("VolcanicAsh")).toBe("未知");
    expect(mapOwCondition(undefined, "volcanic ash")).toBe("未知");
  });

  it("未知/缺失 main 时用中文 description 兜底", () => {
    expect(mapOwCondition("UnknownMain", "毛毛雨")).toBe("毛毛雨");
    expect(mapOwCondition(null, "晴")).toBe("晴");
    expect(mapOwCondition(undefined, undefined)).toBe("未知");
  });
});

// ── fetchWeather：映射 + 缓存 + 失败降级 ─────────────────────

describe("fetchWeather", () => {
  it("把 OWM 英文 main 映射成中文 condition，并整理字段", async () => {
    mockOwmOnce(
      owmPayload({
        weather: [{ main: "Rain", description: "小雨" }],
        main: { temp: 23.6, humidity: 78 },
        name: "Shanghai",
      })
    );

    const weather = await fetchWeather("Shanghai");

    expect(weather).toEqual({
      condition: "雨",
      temp: 24,
      humidity: 78,
      description: "小雨",
      city: "Shanghai",
    });
    expect(mockedGet).toHaveBeenCalledTimes(1);
  });

  it("从实时 OWM 数据映射出的 condition 可被下游情绪逻辑识别（晴天）", async () => {
    mockOwmOnce(
      owmPayload({ weather: [{ main: "Clear", description: "晴" }], main: { temp: 27.2, humidity: 40 } })
    );

    const weather = await fetchWeather("上海");
    expect(weather).not.toBeNull();

    const perception = perceiveWeather(weather!, "active", 0.2, null);
    expect(perception.moodOffset).toBe(0.05);
  });

  it("同一城市 30 分钟内命中缓存，不重复请求", async () => {
    mockedGet.mockResolvedValue({ data: owmPayload() } as never);

    const first = await fetchWeather("上海");
    const second = await fetchWeather("上海");

    expect(mockedGet).toHaveBeenCalledTimes(1);
    expect(second).toEqual(first);
  });

  it("不同城市各自独立缓存", async () => {
    mockOwmOnce(owmPayload({ name: "上海" }));
    mockOwmOnce(owmPayload({ name: "北京" }));

    await fetchWeather("上海");
    await fetchWeather("北京");
    await fetchWeather("上海");

    expect(mockedGet).toHaveBeenCalledTimes(2);
  });

  it("缓存过期（>30min）后重新请求", async () => {
    vi.useFakeTimers();
    mockOwmOnce(owmPayload());
    await fetchWeather("上海");
    expect(mockedGet).toHaveBeenCalledTimes(1);

    vi.setSystemTime(Date.now() + WEATHER_CACHE_TTL_MS + 1);
    mockOwmOnce(owmPayload({ weather: [{ main: "Rain", description: "中雨" }] }));
    const refreshed = await fetchWeather("上海");

    expect(mockedGet).toHaveBeenCalledTimes(2);
    expect(refreshed?.condition).toBe("雨");
  });

  it("clearWeatherCache 后立即重新请求", async () => {
    mockedGet.mockResolvedValue({ data: owmPayload() } as never);
    await fetchWeather("上海");
    clearWeatherCache();
    await fetchWeather("上海");
    expect(mockedGet).toHaveBeenCalledTimes(2);
  });

  it("请求失败返回 null（不抛出）", async () => {
    mockedGet.mockRejectedValueOnce(new Error("network down"));
    await expect(fetchWeather("上海")).resolves.toBeNull();
    expect(mockedGet).toHaveBeenCalledTimes(1);
  });

  it("失败结果不写缓存：下次调用会重新请求并成功", async () => {
    mockedGet.mockRejectedValueOnce(new Error("timeout"));
    expect(await fetchWeather("上海")).toBeNull();

    mockOwmOnce(owmPayload());
    const weather = await fetchWeather("上海");

    expect(mockedGet).toHaveBeenCalledTimes(2);
    expect(weather?.condition).toBe("晴");
  });

  it("无 Key 时返回 null 且不发请求", async () => {
    delete process.env.OPENWEATHER_API_KEY;
    expect(await fetchWeather("上海")).toBeNull();
    expect(mockedGet).not.toHaveBeenCalled();
  });

  it("显式传入 apiKey 时生效（params.appid 正确）", async () => {
    delete process.env.OPENWEATHER_API_KEY;
    mockOwmOnce(owmPayload());

    await fetchWeather("上海", "explicit-key");

    expect(mockedGet).toHaveBeenCalledWith(
      "https://api.openweathermap.org/data/2.5/weather",
      expect.objectContaining({
        params: expect.objectContaining({
          q: "上海",
          appid: "explicit-key",
          units: "metric",
          lang: "zh_cn",
        }),
        timeout: 5000,
      })
    );
  });

  it("响应结构异常（缺 weather / 缺温度）返回 null 且不写缓存", async () => {
    mockOwmOnce({ main: { temp: 20, humidity: 50 }, name: "上海" });
    expect(await fetchWeather("上海")).toBeNull();

    mockOwmOnce({ weather: [{ main: "Clear", description: "晴" }], main: {}, name: "上海" });
    expect(await fetchWeather("上海")).toBeNull();

    expect(mockedGet).toHaveBeenCalledTimes(2);
  });

  it("provider 未返回中文 description 时，用中文 condition 兜底", async () => {
    mockOwmOnce(
      owmPayload({ weather: [{ main: "Drizzle", description: "light intensity drizzle" }] })
    );

    const weather = await fetchWeather("上海");

    expect(weather?.condition).toBe("小雨");
    expect(weather?.description).toBe("小雨");
  });
});

// ── perceiveWeather：雨天/晴天 moodOffset ─────────────────────

describe("perceiveWeather moodOffset", () => {
  it("雨天 + 情绪基线下行 → -0.05（天气情绪生效）", () => {
    const perception = perceiveWeather(weatherInfo({ condition: "雨" }), "active", -0.3, null);
    expect(perception.moodOffset).toBe(-0.05);
    expect(perception.personalInterpretation).toContain("作对");
  });

  it("雨天 + 正常基线 + 无出门计划 → +0.05（窝在家里反而舒服）", () => {
    const perception = perceiveWeather(weatherInfo({ condition: "小雨" }), "passive", 0.2, null);
    expect(perception.moodOffset).toBe(0.05);
    expect(perception.personalInterpretation).toContain("窝在家里");
  });

  it("雨天 + 有出门计划 → -0.1", () => {
    const perception = perceiveWeather(weatherInfo({ condition: "大雨" }), "active", 0.2, "去公司");
    expect(perception.moodOffset).toBe(-0.1);
  });

  it("晴天 → +0.05", () => {
    const perception = perceiveWeather(weatherInfo({ condition: "晴", description: "晴" }), "active", 0, null);
    expect(perception.moodOffset).toBe(0.05);
    expect(perception.personalInterpretation).toContain("天气不错");
  });

  it("英文 condition（修复前的 OWM 原值）不会被识别为雨天 → 回归护栏", () => {
    // 修复前 fetchWeather 直接返回 "Rain"/"Clear"，导致中文匹配全部落空；
    // 这里显式断言英文值不再产生雨天/晴天情绪，提醒调用方必须走 mapOwCondition。
    const rainEnglish = perceiveWeather(weatherInfo({ condition: "Rain" }), "active", -0.3, null);
    expect(rainEnglish.moodOffset).toBe(0);
  });
});

// ── mockWeather：无 Key 降级数据仍是中文 ─────────────────────

describe("mockWeather", () => {
  it("生成的 condition 为下游可匹配的中文", () => {
    for (let i = 0; i < 20; i++) {
      const weather = mockWeather("上海");
      expect(["晴", "多云", "阴", "小雨", "雷阵雨"]).toContain(weather.condition);
      expect(weather.description).toBe(weather.condition);
    }
  });
});

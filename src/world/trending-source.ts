/**
 * 真实热榜来源（v0.9.32）：百度热搜 top board。
 *
 * 只取标题，不抓评论/用户数据；失败完全回退本地话题池，不阻塞聊天。
 * 每 30 分钟缓存一次，避免每轮都请求。
 */
import type { TrendingTopic } from "./trending-fetcher.js";

const BAIDU_URL = "https://top.baidu.com/board?tab=realtime";
const FETCH_TIMEOUT_MS = 3_000;
const MAX_TOPICS = 20;

export interface BaiduHotItem {
  word?: string;
  query?: string;
}

/** 从百度热搜 HTML 的 `<!--s-data:...-->` 里提取标题；解析失败返回空数组。 */
export function parseBaiduHotHtml(html: string): string[] {
  const marker = "<!--s-data:";
  const start = html.indexOf(marker);
  if (start < 0) return [];
  const bodyStart = start + marker.length;
  const end = html.indexOf("-->", bodyStart);
  if (end < 0) return [];
  const raw = html.slice(bodyStart, end);
  try {
    const data = JSON.parse(raw) as {
      data?: { cards?: Array<{ content?: BaiduHotItem[] }> };
    };
    const out: string[] = [];
    for (const card of data.data?.cards ?? []) {
      for (const item of card.content ?? []) {
        const title = String(item.word ?? item.query ?? "").trim();
        if (title && !out.includes(title)) out.push(title);
      }
    }
    return out.slice(0, MAX_TOPICS);
  } catch {
    return [];
  }
}

/** 抓百度热搜标题；失败返回空数组。 */
export async function fetchBaiduHotTitles(
  fetchFn: typeof fetch = fetch,
  timeoutMs = FETCH_TIMEOUT_MS,
): Promise<string[]> {
  try {
    const res = await fetchFn(BAIDU_URL, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/124 Safari/537.36",
        Accept: "text/html,application/xhtml+xml",
      },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return [];
    return parseBaiduHotHtml(await res.text());
  } catch {
    return [];
  }
}

/** 不进闲聊的标题：政治/灾难/犯罪/国际冲突等新闻，避免她突然聊到不该聊的事。 */
const UNSAFE_TITLE_RE =
  /(习近平|总书记|主席|国务院|政府|人大|政协|党代会|红军|长征|外交|国防|军队|战争|冲突|空袭|袭击|爆炸|火灾|地震|洪水|台风|事故|死亡|遇难|杀人|强奸|自杀|诈骗|抓[获捕]|判刑|落马|塌房|爆料|维权|抗议|日本|美国|俄罗斯|乌克兰|以色列|巴勒斯坦)/;

export function isSafeTrendingTitle(title: string): boolean {
  return Boolean(title.trim()) && !UNSAFE_TITLE_RE.test(title);
}

/** 标题 → 本地 TrendingTopic（只保留生活/娱乐类，过滤政治/灾难新闻）。 */
export function titlesToTrendingTopics(titles: string[]): TrendingTopic[] {
  return titles
    .map((title) => title.trim())
    .filter((title) => isSafeTrendingTitle(title))
    .slice(0, MAX_TOPICS)
    .map((title) => ({
      title,
      sphere: "生活" as const,
      layer: 1 as const,
      keywords: [],
    }));
}

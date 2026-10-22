import { describe, expect, it, vi } from "vitest";
import { fetchBaiduHotTitles, parseBaiduHotHtml, titlesToTrendingTopics } from "./trending-source.js";

const HTML = '<html><!--s-data:{"data":{"cards":[{"content":[{"word":"热搜一"},{"query":"热搜二"}]}]}}--></html>';

describe("trending-source", () => {
  it("解析百度热搜 s-data", () => {
    expect(parseBaiduHotHtml(HTML)).toEqual(["热搜一", "热搜二"]);
    expect(parseBaiduHotHtml("no data")).toEqual([]);
  });

  it("失败/非 2xx 返回空", async () => {
    const fail = vi.fn(async () => new Response("", { status: 500 })) as unknown as typeof fetch;
    await expect(fetchBaiduHotTitles(fail)).resolves.toEqual([]);
  });

  it("标题映射为 layer=1 话题，并过滤政治/灾难新闻", () => {
    expect(titlesToTrendingTopics(["某明星新歌", "B"])[0]).toMatchObject({ title: "某明星新歌", layer: 1 });
    expect(titlesToTrendingTopics(["习近平出席大会", "某地火灾", "某明星新歌"])).toHaveLength(1);
  });
});

import assert from "node:assert/strict";
import test from "node:test";
import {
  aggregateNews,
  NewsApiSource,
  parseNewsFeed,
  type InformationSource,
  type NewsArticle,
} from "../src/main/news-aggregator.ts";
import { DailyQuotaLimiter } from "../src/main/quota-limiter.ts";

const RSS = `<?xml version="1.0"?><rss><channel>
  <item>
    <title><![CDATA[人工智能 &amp; 新产品]]></title>
    <link>https://example.com/ai?utm_source=rss</link>
    <pubDate>Thu, 20 Aug 2026 10:00:00 GMT</pubDate>
    <description><![CDATA[<b>摘要</b><script>bad()</script> 内容]]></description>
    <source>示例媒体</source>
  </item>
</channel></rss>`;

test("parses structured RSS news and cleans markup", () => {
  const result = parseNewsFeed(RSS, {
    id: "rss-zh",
    name: "RSS 中文",
    language: "zh",
    weight: 20,
  });
  assert.deepEqual(result[0], {
    title: "人工智能 & 新产品",
    source: "示例媒体",
    url: "https://example.com/ai?utm_source=rss",
    publishedAt: "2026-08-20T10:00:00.000Z",
    summary: "摘要 内容",
    language: "zh",
    sourceId: "rss-zh",
    sourceWeight: 20,
  });
});

function source(id: string, language: "zh" | "en", articles: NewsArticle[]): InformationSource {
  return {
    id,
    name: id,
    language,
    weight: articles[0]?.sourceWeight ?? 20,
    fetch: async () => articles,
  };
}

test("filters by hourly window, deduplicates events, and ranks corroborated news", async () => {
  const now = new Date("2026-08-20T12:00:00.000Z");
  const common = {
    publishedAt: "2026-08-20T11:30:00.000Z",
    summary: "launch summary",
    language: "en" as const,
    sourceWeight: 25,
  };
  const result = await aggregateNews([
    source("one", "en", [{
      ...common,
      title: "Acme launches a new AI agent platform",
      source: "One",
      url: "https://one.example/story?utm_source=feed",
      sourceId: "one",
    }]),
    source("two", "en", [{
      ...common,
      title: "Acme launches new AI agent platform",
      source: "Two",
      url: "https://two.example/acme",
      sourceId: "two",
    }, {
      ...common,
      title: "Old AI story",
      source: "Two",
      url: "https://two.example/old",
      publishedAt: "2026-08-18T10:00:00.000Z",
      sourceId: "two",
    }]),
  ], {
    query: "AI agent",
    windowValue: 2,
    windowUnit: "hours",
    language: "all",
    limit: 10,
    now,
  });

  assert.equal(result.articles.length, 1);
  assert.equal(result.articles[0].corroboration, 2);
  assert.ok(result.articles[0].score > 70);
  assert.equal(result.window.since, "2026-08-20T10:00:00.000Z");
});

test("keeps NewsAPI keys out of URLs and enforces the local daily quota", async () => {
  let requestUrl = "";
  let apiKeyHeader = "";
  const source = new NewsApiSource(
    "en",
    "test-placeholder-key",
    1,
    async (input, init) => {
      requestUrl = String(input);
      apiKeyHeader = new Headers(init?.headers).get("x-api-key") ?? "";
      return new Response(JSON.stringify({ status: "ok", articles: [] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
    new DailyQuotaLimiter(),
  );
  const request = {
    query: "AI",
    since: new Date("2026-08-20T00:00:00Z"),
    until: new Date("2026-08-20T12:00:00Z"),
  };
  await source.fetch(request);
  assert.doesNotMatch(requestUrl, /test-placeholder-key/);
  assert.equal(apiKeyHeader, "test-placeholder-key");
  await assert.rejects(source.fetch(request), /本地调用上限/);
});

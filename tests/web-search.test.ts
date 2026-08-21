import assert from "node:assert/strict";
import test from "node:test";
import { createWebSearchTool, parseBingRss } from "../src/main/web-search.ts";

const RSS = `<?xml version="1.0"?>
<rss><channel>
  <item>
    <title>DoWork &amp; agents</title>
    <link>https://example.com/agents</link>
    <description><![CDATA[<b>Current</b> agent information.]]></description>
  </item>
  <item>
    <title>Second result</title>
    <link>https://example.org/two</link>
    <description>Another result</description>
  </item>
</channel></rss>`;

test("parses and sanitizes Bing RSS results", () => {
  const results = parseBingRss(RSS, 1);
  assert.deepEqual(results, [
    {
      title: "DoWork & agents",
      url: "https://example.com/agents",
      snippet: "Current agent information.",
    },
  ]);
});

test("web search tool formats sources for the agent", async () => {
  const requestedUrls: string[] = [];
  const mockFetch: typeof fetch = async (input) => {
    requestedUrls.push(String(input));
    return new Response(RSS, { status: 200, headers: { "content-type": "application/rss+xml" } });
  };
  const tool = createWebSearchTool(mockFetch);
  const result = await tool.execute("call-1", { query: "desktop agents", limit: 2 });

  assert.match(requestedUrls[0], /format=rss/);
  assert.match(result.content[0].type === "text" ? result.content[0].text : "", /https:\/\/example\.com\/agents/);
  assert.deepEqual(result.details, { query: "desktop agents", count: 2 });
});

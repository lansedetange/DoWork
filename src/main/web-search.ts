import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "typebox";

const SEARCH_ENDPOINT = "https://www.bing.com/search";
const MAX_RESPONSE_BYTES = 1024 * 1024;

export interface WebSearchResult {
  title: string;
  url: string;
  snippet: string;
}

function decodeEntities(value: string): string {
  const named: Record<string, string> = {
    amp: "&",
    apos: "'",
    gt: ">",
    lt: "<",
    nbsp: " ",
    quot: '"',
  };
  return value
    .replace(/&#x([0-9a-f]+);/gi, (_match, code: string) => String.fromCodePoint(Number.parseInt(code, 16)))
    .replace(/&#(\d+);/g, (_match, code: string) => String.fromCodePoint(Number.parseInt(code, 10)))
    .replace(/&([a-z]+);/gi, (match, name: string) => named[name.toLowerCase()] ?? match);
}

function tagValue(item: string, tag: string): string {
  const match = item.match(new RegExp(`<${tag}>([\\s\\S]*?)<\\/${tag}>`, "i"));
  return match?.[1] ?? "";
}

function cleanText(value: string): string {
  return decodeEntities(
    value
      .replace(/^<!\[CDATA\[/, "")
      .replace(/\]\]>$/, "")
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
      .trim(),
  );
}

export function parseBingRss(xml: string, limit: number): WebSearchResult[] {
  const items = xml.match(/<item>[\s\S]*?<\/item>/gi) ?? [];
  const results: WebSearchResult[] = [];
  for (const item of items) {
    const title = cleanText(tagValue(item, "title"));
    const url = cleanText(tagValue(item, "link"));
    const snippet = cleanText(tagValue(item, "description"));
    try {
      const parsedUrl = new URL(url);
      if (!title || parsedUrl.protocol !== "https:") continue;
      results.push({ title, url: parsedUrl.toString(), snippet });
      if (results.length >= limit) break;
    } catch {
      // Ignore malformed result URLs.
    }
  }
  return results;
}

export async function searchWeb(
  query: string,
  limit: number,
  fetchImpl: typeof fetch = fetch,
  signal?: AbortSignal,
): Promise<WebSearchResult[]> {
  const url = new URL(SEARCH_ENDPOINT);
  url.searchParams.set("format", "rss");
  url.searchParams.set("q", query);
  url.searchParams.set("count", String(limit));
  const timeoutSignal = AbortSignal.timeout(12_000);
  const response = await fetchImpl(url, {
    headers: {
      Accept: "application/rss+xml, application/xml;q=0.9",
      "User-Agent": "DoWork/0.1 (+desktop-agent)",
    },
    signal: signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal,
  });
  if (!response.ok) throw new Error(`搜索服务返回 HTTP ${response.status}。`);
  const xml = await response.text();
  if (Buffer.byteLength(xml, "utf8") > MAX_RESPONSE_BYTES) {
    throw new Error("搜索结果响应过大，已停止处理。 ");
  }
  return parseBingRss(xml, limit);
}

export function createWebSearchTool(fetchImpl: typeof fetch = fetch): AgentTool {
  return {
    name: "web_search",
    label: "联网搜索",
    description:
      "Search the public web for current information. Use it when the user asks to search, when facts may have changed, or when up-to-date sources are needed. Cite result URLs in the final answer.",
    parameters: Type.Object(
      {
        query: Type.String({ description: "Focused web search query." }),
        limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 8, description: "Number of results. Defaults to 5." })),
      },
      { additionalProperties: false },
    ),
    execute: async (_toolCallId, params, signal) => {
      const input = params as { query: string; limit?: number };
      const query = input.query.trim();
      if (!query) throw new Error("搜索词不能为空。 ");
      if (query.length > 300) throw new Error("搜索词不能超过 300 个字符。 ");
      const limit = Math.max(1, Math.min(input.limit ?? 5, 8));
      const results = await searchWeb(query, limit, fetchImpl, signal);
      if (results.length === 0) throw new Error("没有找到可用的搜索结果。 ");
      const text = results
        .map((result, index) => [
          `${index + 1}. ${result.title}`,
          `   ${result.url}`,
          result.snippet ? `   ${result.snippet}` : "",
        ].filter(Boolean).join("\n"))
        .join("\n\n");
      return {
        content: [{ type: "text" as const, text }],
        details: { query, count: results.length },
      };
    },
  };
}

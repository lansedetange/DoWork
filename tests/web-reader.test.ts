import assert from "node:assert/strict";
import test from "node:test";
import { extractReadableHtml, readWebPage } from "../src/main/web-reader.ts";

const ARTICLE_HTML = `<!doctype html><html><head><title>Agent News</title><style>.ad{}</style></head><body>
  <nav>Home Pricing Login</nav><article><h1>Agent News</h1>
  <p>${"This is the detailed article body with useful reporting and analysis. ".repeat(9)}</p>
  <script>steal()</script><aside>Advertisement</aside></article><footer>Copyright</footer>
</body></html>`;

test("extracts article text while removing navigation, scripts, and ads", () => {
  const result = extractReadableHtml(ARTICLE_HTML);
  assert.equal(result.title, "Agent News");
  assert.match(result.content, /detailed article body/);
  assert.doesNotMatch(result.content, /Home Pricing|steal\(\)|Advertisement|Copyright/);
});

test("reads a public webpage directly", async () => {
  const document = await readWebPage("https://example.com/story", {
    validateUrl: async (url) => new URL(url),
    fetchImpl: async () => new Response(ARTICLE_HTML, {
      status: 200,
      headers: { "content-type": "text/html; charset=utf-8" },
    }),
  });
  assert.equal(document.extractedBy, "direct");
  assert.equal(document.title, "Agent News");
  assert.ok(document.contentLength > 400);
});

test("falls back to Jina Reader for a thin or dynamic page", async () => {
  const requests: string[] = [];
  const document = await readWebPage("https://example.com/dynamic", {
    validateUrl: async (url) => new URL(url),
    env: { JINA_DAILY_LIMIT: "10" },
    fetchImpl: async (input) => {
      const url = String(input);
      requests.push(url);
      if (url.startsWith("https://r.jina.ai/")) {
        return new Response(`Title: Dynamic Story\nURL Source: https://example.com/dynamic\nMarkdown Content:\n${"Full rendered article paragraph. ".repeat(20)}`, { status: 200 });
      }
      return new Response("<html><body>Loading…</body></html>", {
        status: 200,
        headers: { "content-type": "text/html" },
      });
    },
  });
  assert.equal(document.extractedBy, "jina");
  assert.equal(document.title, "Dynamic Story");
  assert.equal(requests.length, 2);
});

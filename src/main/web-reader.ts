import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "typebox";
import { externalApiQuota } from "./quota-limiter.ts";
import { assertPublicHttpsUrl } from "./public-url.ts";
import { redactSensitiveText } from "./security.ts";

const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const MAX_CONTENT_CHARS = 60_000;

export interface WebPageDocument {
  url: string;
  title: string;
  content: string;
  contentLength: number;
  extractedBy: "direct" | "jina";
  fetchedAt: string;
}

export interface WebReaderDependencies {
  fetchImpl?: typeof fetch;
  validateUrl?: (url: string) => Promise<URL>;
  env?: NodeJS.ProcessEnv;
}

function decodeEntities(value: string): string {
  const named: Record<string, string> = {
    amp: "&", apos: "'", gt: ">", lt: "<", nbsp: " ", quot: '"', ndash: "–", mdash: "—",
  };
  return value
    .replace(/&#x([0-9a-f]+);/gi, (_match, code: string) => String.fromCodePoint(Number.parseInt(code, 16)))
    .replace(/&#(\d+);/g, (_match, code: string) => String.fromCodePoint(Number.parseInt(code, 10)))
    .replace(/&([a-z]+);/gi, (match, name: string) => named[name.toLowerCase()] ?? match);
}

function stripTags(value: string): string {
  return decodeEntities(value.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim());
}

export function extractReadableHtml(html: string): { title: string; content: string } {
  const title = stripTags(html.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? "");
  const cleaned = html
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<(script|style|noscript|svg|canvas|iframe|nav|header|footer|aside|form|button)\b[\s\S]*?<\/\1>/gi, " ");
  const article = cleaned.match(/<article\b[^>]*>([\s\S]*?)<\/article>/i)?.[1]
    ?? cleaned.match(/<main\b[^>]*>([\s\S]*?)<\/main>/i)?.[1]
    ?? cleaned.match(/<body\b[^>]*>([\s\S]*?)<\/body>/i)?.[1]
    ?? cleaned;
  const withBreaks = article
    .replace(/<(?:br|hr)\s*\/?>/gi, "\n")
    .replace(/<\/(?:p|div|section|article|h[1-6]|li|blockquote|pre|tr)>/gi, "\n")
    .replace(/<li\b[^>]*>/gi, "• ");
  const lines = decodeEntities(withBreaks.replace(/<[^>]+>/g, " "))
    .split(/\n+/)
    .map((line) => line.replace(/[\t ]+/g, " ").trim())
    .filter((line) => line.length > 1)
    .filter((line) => !/^(?:accept (?:all )?cookies?|cookie settings|advertisement|sign in|log in|subscribe)$/i.test(line));
  const unique: string[] = [];
  for (const line of lines) {
    if (line !== unique.at(-1)) unique.push(line);
  }
  return { title, content: unique.join("\n\n").slice(0, MAX_CONTENT_CHARS) };
}

async function fetchWithRedirectValidation(
  initialUrl: URL,
  fetchImpl: typeof fetch,
  validateUrl: (url: string) => Promise<URL>,
  signal?: AbortSignal,
  headers: Record<string, string> = {},
): Promise<{ response: Response; finalUrl: URL }> {
  let current = initialUrl;
  for (let redirects = 0; redirects <= 3; redirects += 1) {
    const response = await fetchImpl(current, {
      headers,
      redirect: "manual",
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(18_000)]) : AbortSignal.timeout(18_000),
    });
    if (response.status < 300 || response.status >= 400) return { response, finalUrl: current };
    const location = response.headers.get("location");
    if (!location) throw new Error("网页重定向缺少目标地址。");
    current = await validateUrl(new URL(location, current).toString());
  }
  throw new Error("网页重定向次数过多。");
}

async function boundedText(response: Response): Promise<string> {
  const declared = Number.parseInt(response.headers.get("content-length") ?? "0", 10);
  if (declared > MAX_RESPONSE_BYTES) throw new Error("网页响应超过 2 MB 限制。");
  const text = await response.text();
  if (Buffer.byteLength(text, "utf8") > MAX_RESPONSE_BYTES) throw new Error("网页响应超过 2 MB 限制。");
  return text;
}

function parseJinaMarkdown(markdown: string, target: URL): { title: string; content: string } {
  const title = markdown.match(/^Title:\s*(.+)$/mi)?.[1]?.trim()
    ?? markdown.match(/^#\s+(.+)$/m)?.[1]?.trim()
    ?? target.hostname;
  const marker = markdown.search(/^Markdown Content:\s*$/mi);
  const content = (marker >= 0 ? markdown.slice(marker).replace(/^Markdown Content:\s*$/mi, "") : markdown)
    .replace(/^URL Source:.*$/gmi, "")
    .replace(/^Published Time:.*$/gmi, "")
    .trim()
    .slice(0, MAX_CONTENT_CHARS);
  return { title, content };
}

async function readWithJina(
  target: URL,
  fetchImpl: typeof fetch,
  env: NodeJS.ProcessEnv,
  signal?: AbortSignal,
): Promise<WebPageDocument> {
  const dailyLimit = Math.max(1, Number.parseInt(env.JINA_DAILY_LIMIT ?? "100", 10) || 100);
  externalApiQuota.consume("Jina Reader", dailyLimit);
  const headers: Record<string, string> = {
    Accept: "text/plain",
    "User-Agent": "DoWork/0.1 (+desktop-agent)",
    "X-Return-Format": "markdown",
  };
  const apiKey = env.JINA_API_KEY?.trim();
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
  const readerUrl = new URL(`https://r.jina.ai/${target.toString()}`);
  const response = await fetchImpl(readerUrl, {
    headers,
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(25_000)]) : AbortSignal.timeout(25_000),
  });
  if (!response.ok) throw new Error(`Reader 服务返回 HTTP ${response.status}。`);
  const parsed = parseJinaMarkdown(await boundedText(response), target);
  if (parsed.content.length < 80) throw new Error("Reader 未提取到足够的正文内容。");
  return {
    url: target.toString(),
    title: parsed.title,
    content: parsed.content,
    contentLength: parsed.content.length,
    extractedBy: "jina",
    fetchedAt: new Date().toISOString(),
  };
}

export async function readWebPage(
  rawUrl: string,
  dependencies: WebReaderDependencies = {},
  signal?: AbortSignal,
): Promise<WebPageDocument> {
  const fetchImpl = dependencies.fetchImpl ?? fetch;
  const validateUrl = dependencies.validateUrl ?? assertPublicHttpsUrl;
  const env = dependencies.env ?? process.env;
  const target = await validateUrl(rawUrl);
  try {
    const { response, finalUrl } = await fetchWithRedirectValidation(target, fetchImpl, validateUrl, signal, {
      Accept: "text/html,application/xhtml+xml,text/plain;q=0.9",
      "User-Agent": "Mozilla/5.0 (compatible; DoWork/0.1; +desktop-agent)",
    });
    if (!response.ok) throw new Error(`网页返回 HTTP ${response.status}。`);
    const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
    if (contentType && !/(?:text\/html|application\/xhtml\+xml|text\/plain)/.test(contentType)) {
      throw new Error(`网页内容类型 ${contentType.split(";")[0]} 不支持正文抽取。`);
    }
    const raw = await boundedText(response);
    const parsed = contentType.includes("text/plain")
      ? { title: finalUrl.hostname, content: raw.trim().slice(0, MAX_CONTENT_CHARS) }
      : extractReadableHtml(raw);
    if (parsed.content.length < 400) throw new Error("直接读取未提取到足够正文。");
    return {
      url: finalUrl.toString(),
      title: parsed.title || finalUrl.hostname,
      content: parsed.content,
      contentLength: parsed.content.length,
      extractedBy: "direct",
      fetchedAt: new Date().toISOString(),
    };
  } catch (directError) {
    try {
      return await readWithJina(target, fetchImpl, env, signal);
    } catch (readerError) {
      throw new Error(`网页正文读取失败：${redactSensitiveText(directError)}；Reader 回退失败：${redactSensitiveText(readerError)}`);
    }
  }
}

export function createReadWebpageTool(dependencies: WebReaderDependencies = {}): AgentTool {
  return {
    name: "read_webpage",
    label: "读取网页",
    description: "Read and clean the main body of a public HTTPS webpage. Use after web_search or news_search when the full article is needed, then summarize with citations.",
    parameters: Type.Object({
      url: Type.String({ description: "Public HTTPS article URL from search results." }),
      maxChars: Type.Optional(Type.Integer({ minimum: 1000, maximum: MAX_CONTENT_CHARS })),
    }, { additionalProperties: false }),
    execute: async (_toolCallId, params, signal) => {
      const input = params as { url: string; maxChars?: number };
      const document = await readWebPage(input.url, dependencies, signal);
      const maxChars = Math.min(input.maxChars ?? 30_000, MAX_CONTENT_CHARS);
      const payload = { ...document, content: document.content.slice(0, maxChars) };
      return {
        content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }],
        details: { url: document.url, title: document.title, chars: payload.content.length, extractedBy: document.extractedBy },
      };
    },
  };
}

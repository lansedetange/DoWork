import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "typebox";
import { externalApiQuota, type DailyQuotaLimiter } from "./quota-limiter.ts";
import { redactSensitiveText } from "./security.ts";

const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;

export type NewsLanguage = "zh" | "en";

export interface NewsArticle {
  title: string;
  source: string;
  url: string;
  publishedAt: string;
  summary: string;
  language: NewsLanguage;
  sourceId: string;
  sourceWeight: number;
  engagement?: number;
}

export interface RankedNewsArticle extends Omit<NewsArticle, "sourceId" | "sourceWeight" | "engagement"> {
  score: number;
  corroboration: number;
}

export interface NewsFetchRequest {
  query: string;
  since: Date;
  until: Date;
  signal?: AbortSignal;
}

export interface InformationSource {
  id: string;
  name: string;
  language: NewsLanguage;
  weight: number;
  fetch(request: NewsFetchRequest): Promise<NewsArticle[]>;
}

export interface AggregateNewsOptions {
  query: string;
  windowValue: number;
  windowUnit: "hours" | "days";
  language: "all" | NewsLanguage;
  limit: number;
  now?: Date;
  signal?: AbortSignal;
}

export interface AggregateNewsResult {
  articles: RankedNewsArticle[];
  window: { since: string; until: string; unit: "hours" | "days"; value: number };
  sources: string[];
  warnings: string[];
}

function decodeEntities(value: string): string {
  const named: Record<string, string> = {
    amp: "&", apos: "'", gt: ">", lt: "<", nbsp: " ", quot: '"',
  };
  return value
    .replace(/&#x([0-9a-f]+);/gi, (_match, code: string) => String.fromCodePoint(Number.parseInt(code, 16)))
    .replace(/&#(\d+);/g, (_match, code: string) => String.fromCodePoint(Number.parseInt(code, 10)))
    .replace(/&([a-z]+);/gi, (match, name: string) => named[name.toLowerCase()] ?? match);
}

function cleanText(value: string): string {
  return decodeEntities(
    value
      .replace(/^<!\[CDATA\[/, "")
      .replace(/\]\]>$/, "")
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
      .trim(),
  );
}

function tagValue(item: string, tag: string): string {
  const match = item.match(new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${tag}>`, "i"));
  return match?.[1] ?? "";
}

function itemLink(item: string): string {
  const rssLink = cleanText(tagValue(item, "link"));
  if (rssLink) return rssLink;
  const atomLink = item.match(/<link[^>]+href=["']([^"']+)["'][^>]*>/i)?.[1];
  return atomLink ? decodeEntities(atomLink) : "";
}

export function parseNewsFeed(
  xml: string,
  source: Pick<InformationSource, "id" | "name" | "language" | "weight">,
): NewsArticle[] {
  const items = [
    ...(xml.match(/<item\b[\s\S]*?<\/item>/gi) ?? []),
    ...(xml.match(/<entry\b[\s\S]*?<\/entry>/gi) ?? []),
  ];
  const articles: NewsArticle[] = [];
  for (const item of items) {
    const title = cleanText(tagValue(item, "title"));
    const rawUrl = itemLink(item);
    const rawDate = cleanText(tagValue(item, "pubDate") || tagValue(item, "published") || tagValue(item, "updated"));
    const summary = cleanText(tagValue(item, "description") || tagValue(item, "summary") || tagValue(item, "content"));
    const publisher = cleanText(tagValue(item, "source")) || source.name;
    const publishedAt = new Date(rawDate);
    try {
      const url = new URL(rawUrl);
      if (!title || url.protocol !== "https:" || Number.isNaN(publishedAt.getTime())) continue;
      articles.push({
        title,
        source: publisher,
        url: url.toString(),
        publishedAt: publishedAt.toISOString(),
        summary: summary.slice(0, 600),
        language: source.language,
        sourceId: source.id,
        sourceWeight: source.weight,
      });
    } catch {
      // Ignore malformed entries without exposing feed internals.
    }
  }
  return articles;
}

async function responseText(response: Response): Promise<string> {
  if (!response.ok) throw new Error(`数据源返回 HTTP ${response.status}。`);
  const text = await response.text();
  if (Buffer.byteLength(text, "utf8") > MAX_RESPONSE_BYTES) throw new Error("数据源响应过大。");
  return text;
}

function withTimeout(signal?: AbortSignal): AbortSignal {
  const timeout = AbortSignal.timeout(15_000);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

export class GoogleNewsRssSource implements InformationSource {
  readonly weight = 24;
  readonly language: NewsLanguage;
  private readonly fetchImpl: typeof fetch;

  constructor(
    language: NewsLanguage,
    fetchImpl: typeof fetch = fetch,
  ) {
    this.language = language;
    this.fetchImpl = fetchImpl;
  }

  get id(): string { return `google-news-${this.language}`; }
  get name(): string { return this.language === "zh" ? "Google 新闻（中文）" : "Google News"; }

  async fetch(request: NewsFetchRequest): Promise<NewsArticle[]> {
    const url = new URL("https://news.google.com/rss/search");
    url.searchParams.set("q", request.query);
    if (this.language === "zh") {
      url.searchParams.set("hl", "zh-CN");
      url.searchParams.set("gl", "CN");
      url.searchParams.set("ceid", "CN:zh-Hans");
    } else {
      url.searchParams.set("hl", "en-US");
      url.searchParams.set("gl", "US");
      url.searchParams.set("ceid", "US:en");
    }
    const response = await this.fetchImpl(url, {
      headers: { Accept: "application/rss+xml", "User-Agent": "DoWork/0.1 (+desktop-agent)" },
      signal: withTimeout(request.signal),
    });
    return parseNewsFeed(await responseText(response), this);
  }
}

interface HnItem {
  id?: number;
  type?: string;
  title?: string;
  text?: string;
  url?: string;
  time?: number;
  score?: number;
  deleted?: boolean;
  dead?: boolean;
}

export class HackerNewsSource implements InformationSource {
  readonly id = "hacker-news";
  readonly name = "Hacker News";
  readonly language = "en" as const;
  readonly weight = 22;
  private readonly fetchImpl: typeof fetch;

  constructor(fetchImpl: typeof fetch = fetch) {
    this.fetchImpl = fetchImpl;
  }

  async fetch(request: NewsFetchRequest): Promise<NewsArticle[]> {
    const response = await this.fetchImpl("https://hacker-news.firebaseio.com/v0/newstories.json", {
      headers: { Accept: "application/json", "User-Agent": "DoWork/0.1 (+desktop-agent)" },
      signal: withTimeout(request.signal),
    });
    if (!response.ok) throw new Error(`Hacker News 返回 HTTP ${response.status}。`);
    const ids = (await response.json()) as unknown;
    if (!Array.isArray(ids)) throw new Error("Hacker News 返回格式无效。");
    const items = await Promise.all(
      ids.slice(0, 50).map(async (id) => {
        const itemResponse = await this.fetchImpl(`https://hacker-news.firebaseio.com/v0/item/${Number(id)}.json`, {
          headers: { Accept: "application/json", "User-Agent": "DoWork/0.1 (+desktop-agent)" },
          signal: withTimeout(request.signal),
        });
        return itemResponse.ok ? (await itemResponse.json()) as HnItem : null;
      }),
    );
    const terms = request.query.toLowerCase().split(/\s+/).filter((term) => term.length > 1);
    return items.flatMap((item): NewsArticle[] => {
      if (!item || item.type !== "story" || item.deleted || item.dead || !item.title || !item.time) return [];
      const haystack = `${item.title} ${cleanText(item.text ?? "")}`.toLowerCase();
      if (terms.length > 0 && !terms.some((term) => haystack.includes(term))) return [];
      const publishedAt = new Date(item.time * 1000);
      const url = item.url ?? `https://news.ycombinator.com/item?id=${item.id}`;
      try {
        if (new URL(url).protocol !== "https:") return [];
      } catch {
        return [];
      }
      return [{
        title: item.title,
        source: this.name,
        url,
        publishedAt: publishedAt.toISOString(),
        summary: cleanText(item.text ?? "").slice(0, 600),
        language: this.language,
        sourceId: this.id,
        sourceWeight: this.weight,
        engagement: item.score ?? 0,
      }];
    });
  }
}

interface NewsApiResponse {
  status?: string;
  message?: string;
  articles?: Array<{
    source?: { name?: string };
    title?: string;
    description?: string;
    url?: string;
    publishedAt?: string;
  }>;
}

export class NewsApiSource implements InformationSource {
  readonly id: string;
  readonly name = "NewsAPI";
  readonly weight = 30;
  readonly language: NewsLanguage;
  private readonly apiKey: string;
  private readonly dailyLimit: number;
  private readonly fetchImpl: typeof fetch;
  private readonly quota: DailyQuotaLimiter;

  constructor(
    language: NewsLanguage,
    apiKey: string,
    dailyLimit: number,
    fetchImpl: typeof fetch = fetch,
    quota: DailyQuotaLimiter = externalApiQuota,
  ) {
    this.language = language;
    this.apiKey = apiKey;
    this.dailyLimit = dailyLimit;
    this.fetchImpl = fetchImpl;
    this.quota = quota;
    this.id = `newsapi-${language}`;
  }

  async fetch(request: NewsFetchRequest): Promise<NewsArticle[]> {
    this.quota.consume("NewsAPI", this.dailyLimit);
    const url = new URL("https://newsapi.org/v2/everything");
    url.searchParams.set("q", request.query);
    url.searchParams.set("from", request.since.toISOString());
    url.searchParams.set("to", request.until.toISOString());
    url.searchParams.set("language", this.language);
    url.searchParams.set("sortBy", "publishedAt");
    url.searchParams.set("pageSize", "50");
    const response = await this.fetchImpl(url, {
      headers: { Accept: "application/json", "X-Api-Key": this.apiKey },
      signal: withTimeout(request.signal),
    });
    const body = (await response.json()) as NewsApiResponse;
    if (!response.ok || body.status !== "ok") {
      throw new Error(`NewsAPI 请求失败：${body.message || `HTTP ${response.status}`}`);
    }
    return (body.articles ?? []).flatMap((article): NewsArticle[] => {
      if (!article.title || !article.url || !article.publishedAt) return [];
      try {
        const url = new URL(article.url);
        const publishedAt = new Date(article.publishedAt);
        if (url.protocol !== "https:" || Number.isNaN(publishedAt.getTime())) return [];
        return [{
          title: article.title,
          source: article.source?.name || this.name,
          url: url.toString(),
          publishedAt: publishedAt.toISOString(),
          summary: (article.description ?? "").slice(0, 600),
          language: this.language,
          sourceId: this.id,
          sourceWeight: this.weight,
        }];
      } catch {
        return [];
      }
    });
  }
}

function canonicalUrl(rawUrl: string): string {
  try {
    const url = new URL(rawUrl);
    for (const key of [...url.searchParams.keys()]) {
      if (/^(?:utm_|fbclid|gclid|ref$|source$)/i.test(key)) url.searchParams.delete(key);
    }
    url.hash = "";
    return url.toString();
  } catch {
    return rawUrl;
  }
}

function titleTokens(title: string): Set<string> {
  const normalized = title
    .toLowerCase()
    .replace(/\s+[-|｜]\s+[^-|｜]{2,30}$/, "")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
  const latin = normalized.split(/\s+/).filter((token) => token.length > 2);
  const compactCjk = [...normalized.replace(/[\s\p{Script=Latin}\p{N}]/gu, "")];
  const cjk = compactCjk.slice(0, -1).map((char, index) => `${char}${compactCjk[index + 1]}`);
  return new Set([...latin, ...cjk]);
}

function similarity(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let shared = 0;
  for (const token of a) if (b.has(token)) shared += 1;
  return shared / (a.size + b.size - shared);
}

function queryMatchScore(title: string, query: string): number {
  const terms = query.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((term) => term.length > 1);
  if (terms.length === 0) return 0;
  const haystack = title.toLowerCase();
  return 10 * (terms.filter((term) => haystack.includes(term)).length / terms.length);
}

export async function aggregateNews(
  sources: InformationSource[],
  options: AggregateNewsOptions,
): Promise<AggregateNewsResult> {
  const query = options.query.trim();
  if (!query) throw new Error("新闻主题不能为空。");
  const now = options.now ?? new Date();
  const unitMs = options.windowUnit === "hours" ? 60 * 60 * 1000 : 24 * 60 * 60 * 1000;
  const since = new Date(now.getTime() - options.windowValue * unitMs);
  const enabled = sources.filter((source) => options.language === "all" || source.language === options.language);
  const settled = await Promise.allSettled(enabled.map((source) => source.fetch({
    query,
    since,
    until: now,
    signal: options.signal,
  })));
  const warnings: string[] = [];
  const raw: NewsArticle[] = [];
  settled.forEach((result, index) => {
    if (result.status === "fulfilled") raw.push(...result.value);
    else warnings.push(`${enabled[index]?.name ?? "数据源"}: ${redactSensitiveText(result.reason)}`);
  });
  if (raw.length === 0 && warnings.length === enabled.length) {
    throw new Error(`所有新闻数据源均不可用：${warnings.join("；")}`);
  }

  const candidates = raw.filter((article) => {
    const published = new Date(article.publishedAt).getTime();
    return published >= since.getTime() && published <= now.getTime() + 5 * 60 * 1000;
  });
  const groups: Array<{ representative: NewsArticle; articles: NewsArticle[]; tokens: Set<string> }> = [];
  for (const article of candidates.sort((a, b) => b.sourceWeight - a.sourceWeight)) {
    const url = canonicalUrl(article.url);
    const tokens = titleTokens(article.title);
    const group = groups.find((candidate) =>
      canonicalUrl(candidate.representative.url) === url || similarity(candidate.tokens, tokens) >= 0.58,
    );
    if (group) {
      group.articles.push(article);
      if (article.sourceWeight > group.representative.sourceWeight) group.representative = article;
    } else {
      groups.push({ representative: article, articles: [article], tokens });
    }
  }

  const windowMs = Math.max(1, now.getTime() - since.getTime());
  const articles = groups.map(({ representative, articles }) => {
    const age = Math.max(0, now.getTime() - new Date(representative.publishedAt).getTime());
    const recency = 50 * Math.max(0, 1 - age / windowMs);
    const corroboration = new Set(articles.map((article) => article.sourceId)).size;
    const engagement = Math.min(10, Math.log10((representative.engagement ?? 0) + 1) * 4);
    const score = Math.round((recency + representative.sourceWeight + Math.min(20, (corroboration - 1) * 8) + queryMatchScore(representative.title, query) + engagement) * 10) / 10;
    return {
      title: representative.title,
      source: representative.source,
      url: representative.url,
      publishedAt: representative.publishedAt,
      summary: representative.summary,
      language: representative.language,
      score,
      corroboration,
    } satisfies RankedNewsArticle;
  }).sort((a, b) => b.score - a.score).slice(0, options.limit);

  return {
    articles,
    window: { since: since.toISOString(), until: now.toISOString(), unit: options.windowUnit, value: options.windowValue },
    sources: enabled.map((source) => source.name),
    warnings,
  };
}

export function createDefaultNewsSources(
  fetchImpl: typeof fetch = fetch,
  env: NodeJS.ProcessEnv = process.env,
): InformationSource[] {
  const sources: InformationSource[] = [
    new GoogleNewsRssSource("zh", fetchImpl),
    new GoogleNewsRssSource("en", fetchImpl),
    new HackerNewsSource(fetchImpl),
  ];
  const apiKey = env.NEWSAPI_API_KEY?.trim();
  if (apiKey) {
    const parsedLimit = Number.parseInt(env.NEWSAPI_DAILY_LIMIT ?? "50", 10);
    const dailyLimit = Number.isFinite(parsedLimit) ? Math.max(1, parsedLimit) : 50;
    sources.push(
      new NewsApiSource("zh", apiKey, dailyLimit, fetchImpl),
      new NewsApiSource("en", apiKey, dailyLimit, fetchImpl),
    );
  }
  return sources;
}

export function createNewsTool(sources: InformationSource[] = createDefaultNewsSources()): AgentTool {
  return {
    name: "news_search",
    label: "实时新闻",
    description: "Fetch and rank current bilingual news for a topic. Supports hourly or daily windows and returns structured title/source/link/time/summary data.",
    parameters: Type.Object({
      query: Type.String({ description: "News topic in Chinese or English." }),
      windowValue: Type.Optional(Type.Integer({ minimum: 1, maximum: 30, description: "Window size. Defaults to 24 hours." })),
      windowUnit: Type.Optional(Type.Union([Type.Literal("hours"), Type.Literal("days")], { description: "hours or days" })),
      language: Type.Optional(Type.Union([Type.Literal("all"), Type.Literal("zh"), Type.Literal("en")])),
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 30 })),
    }, { additionalProperties: false }),
    execute: async (_toolCallId, params, signal) => {
      const input = params as Partial<AggregateNewsOptions> & { query: string };
      const result = await aggregateNews(sources, {
        query: input.query,
        windowValue: input.windowValue ?? 24,
        windowUnit: input.windowUnit ?? "hours",
        language: input.language ?? "all",
        limit: input.limit ?? 12,
        signal,
      });
      return {
        content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
        details: { query: input.query, count: result.articles.length, sources: result.sources },
      };
    },
  };
}

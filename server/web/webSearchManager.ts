/**
 * Web 搜索快轨：不经过 Playwright，直接 fetch DuckDuckGo HTML 快搜
 * 用于 research-then-open 等需要秒级出结果的场景，失败自动回退到 browser.search
 */

export type WebSearchResultItem = {
  rank: number;
  title: string;
  url: string;
  snippet: string;
  displayUrl?: string;
};

export type WebSearchData = {
  engine: "duckduckgo" | "tavily" | "brave" | "exa";
  query: string;
  resultPageUrl: string;
  results: WebSearchResultItem[];
  searchedAt: number;
};

export type WebSearchTopic = "general" | "news" | "finance";
export type WebSearchTimeRange = "day" | "week" | "month" | "year";

export type WebSearchCloudOptions = {
  /** 用户自备 Key：仅本次请求内存使用，从不落盘，前端经回环传入。 */
  apiKey?: string;
  provider?: "tavily" | "brave" | "exa";
  /** Tavily 专用：新闻/财经场景透传，不传即 general（向后兼容）。 */
  topic?: WebSearchTopic;
  timeRange?: WebSearchTimeRange;
  /** Tavily 专用：默认 basic（1 credit），advanced 为 2 credits。 */
  searchDepth?: "basic" | "advanced";
};

const DUCK_HTML = "https://html.duckduckgo.com/html/";

/**
 * DuckDuckGo 反爬/验证码页面的结构化特征。
 * 命中即说明本次没有拿到真实结果，必须报错而不是当成「零结果」。
 */
const DUCK_BLOCK_MARKERS = [
  "anomaly-modal",
  "anomaly.js",
  "challenge-form",
  "unusual traffic",
  "detected unusual"
];

function detectDuckBlock(html: string): boolean {
  const lower = html.toLowerCase();
  return DUCK_BLOCK_MARKERS.some((marker) => lower.includes(marker));
}

function resolveTarget(href: string): string {
  let h = href.trim();
  if (h.startsWith("//")) h = `https:${h}`;
  try {
    const u = new URL(h);
    const uddg = u.searchParams.get("uddg");
    if (uddg) return decodeURIComponent(uddg);
    return u.toString();
  } catch { return h; }
}

export async function webSearch(query: string, limit = 8, signal?: AbortSignal, cloud?: WebSearchCloudOptions): Promise<WebSearchData> {
  const q = query.trim();
  if (!q) throw Object.assign(new Error("缺少 query"), { webCode: "INVALID_REQUEST" });
  // 有用户自备 Key 时走云索引（服务端直调，无浏览器 CORS 问题，Key 只活在本次请求内存里）。
  if (cloud?.apiKey?.trim()) {
    return webSearchViaCloud(q, limit, {
      provider: cloud.provider ?? "tavily",
      apiKey: cloud.apiKey.trim(),
      topic: cloud.topic,
      timeRange: cloud.timeRange,
      searchDepth: cloud.searchDepth
    }, signal);
  }
  return webSearchViaDuck(q, limit, signal);
}

function cloudTopic(v: unknown): WebSearchTopic {
  return v === "news" || v === "finance" ? v : "general";
}

function cloudTimeRange(v: unknown): WebSearchTimeRange | undefined {
  return v === "day" || v === "week" || v === "month" || v === "year" ? v : undefined;
}

async function webSearchViaCloud(
  query: string,
  limit: number,
  cloud: { provider: "tavily" | "brave" | "exa"; apiKey: string; topic?: WebSearchTopic; timeRange?: WebSearchTimeRange; searchDepth?: "basic" | "advanced" },
  signal?: AbortSignal
): Promise<WebSearchData> {
  const provider = cloud.provider;
  const apiKey = cloud.apiKey;
  const capped = Math.min(Math.max(limit, 1), 10);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);
  const onAbort = () => controller.abort();
  if (signal) {
    if (signal.aborted) controller.abort();
    else signal.addEventListener("abort", onAbort, { once: true });
  }
  try {
    if (provider === "brave") {
      const r = await fetch(`https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=${capped}`, {
        headers: { "X-Subscription-Token": apiKey },
        signal: controller.signal
      });
      if (r.status === 401 || r.status === 403) {
        throw Object.assign(new Error("搜索 Key 无效，请去设置 → 联网搜索里检查后重试。"), { webCode: "KEY_INVALID" });
      }
      if (r.status === 429) {
        throw Object.assign(new Error("搜索限流，请稍后重试。"), { webCode: "RATE_LIMITED" });
      }
      if (!r.ok) throw Object.assign(new Error(`搜索服务异常（${r.status}）`), { webCode: "INTERNAL_ERROR" });
      const j = await r.json() as { web?: { results?: Array<{ title?: string; url?: string; description?: string }> } };
      const results = (j.web?.results ?? []).filter((x) => x.url).map((x, i) => ({
        rank: i + 1,
        title: (x.title ?? x.url ?? "").trim() || "Untitled",
        url: (x.url ?? "").trim(),
        snippet: (x.description ?? "").slice(0, 500),
        displayUrl: undefined
      }));
      return { engine: "brave", query, resultPageUrl: results[0]?.url ?? "", results, searchedAt: Date.now() };
    }
    if (provider === "exa") {
      const r = await fetch("https://api.exa.ai/search", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-api-key": apiKey },
        body: JSON.stringify({ query, numResults: capped }),
        signal: controller.signal
      });
      if (r.status === 401 || r.status === 403) {
        throw Object.assign(new Error("搜索 Key 无效，请去设置 → 联网搜索里检查后重试。"), { webCode: "KEY_INVALID" });
      }
      if (r.status === 429) {
        throw Object.assign(new Error("搜索限流，请稍后重试。"), { webCode: "RATE_LIMITED" });
      }
      if (!r.ok) throw Object.assign(new Error(`搜索服务异常（${r.status}）`), { webCode: "INTERNAL_ERROR" });
      const j = await r.json() as { results?: Array<{ title?: string; url?: string; text?: string }> };
      const results = (j.results ?? []).filter((x) => x.url).map((x, i) => ({
        rank: i + 1,
        title: (x.title ?? x.url ?? "").trim() || "Untitled",
        url: (x.url ?? "").trim(),
        snippet: (x.text ?? "").slice(0, 500),
        displayUrl: undefined
      }));
      return { engine: "exa", query, resultPageUrl: results[0]?.url ?? "", results, searchedAt: Date.now() };
    }
    const topic = cloudTopic(cloud.topic);
    const timeRange = cloudTimeRange(cloud.timeRange);
    const searchDepth = cloud.searchDepth === "advanced" ? "advanced" : "basic";
    const r = await fetch("https://api.tavily.com/search", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": `Bearer ${apiKey}` },
      body: JSON.stringify({
        query,
        max_results: capped,
        search_depth: searchDepth,
        topic,
        ...(timeRange ? { time_range: timeRange } : {}),
        include_answer: false
      }),
      signal: controller.signal
    });
    if (r.status === 401 || r.status === 403) {
      throw Object.assign(new Error("搜索 Key 无效，请去设置 → 联网搜索里检查后重试。"), { webCode: "KEY_INVALID" });
    }
    if (r.status === 422) {
      throw Object.assign(new Error("搜索请求被拒绝（参数校验失败），请升级后重试。"), { webCode: "INVALID_REQUEST" });
    }
    if (r.status === 429) {
      throw Object.assign(new Error("搜索限流，请稍后重试。"), { webCode: "RATE_LIMITED" });
    }
    if (!r.ok) throw Object.assign(new Error(`搜索服务异常（${r.status}）`), { webCode: "INTERNAL_ERROR" });
    const j = await r.json() as { results?: Array<{ title?: string; url?: string; content?: string }> };
    const results = (j.results ?? []).filter((x) => x.url).map((x, i) => ({
      rank: i + 1,
      title: (x.title ?? x.url ?? "").trim() || "Untitled",
      url: (x.url ?? "").trim(),
      snippet: (x.content ?? "").slice(0, 500),
      displayUrl: undefined
    }));
    return { engine: "tavily", query, resultPageUrl: results[0]?.url ?? "", results, searchedAt: Date.now() };
  } catch (e) {
    const err = e as Error & { webCode?: string; name?: string };
    if (err.webCode) throw e;
    if (err.name === "AbortError") {
      // 用户/上游取消必须原样上抛，只有内部超时才归为 TIMEOUT。
      if (signal?.aborted) throw e;
      throw Object.assign(new Error("搜索超时"), { webCode: "TIMEOUT" });
    }
    throw Object.assign(new Error(err.message || "搜索失败"), { webCode: "INTERNAL_ERROR" });
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener("abort", onAbort);
  }
}

async function webSearchViaDuck(query: string, limit: number, signal?: AbortSignal): Promise<WebSearchData> {
  const q = query.trim();
  if (!q) throw Object.assign(new Error("缺少 query"), { webCode: "INVALID_REQUEST" });
  const url = `${DUCK_HTML}?q=${encodeURIComponent(q)}`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 12000);
  const onAbort = () => controller.abort();
  if (signal) {
    if (signal.aborted) controller.abort();
    else signal.addEventListener("abort", onAbort, { once: true });
  }
  let html: string;
  try {
    const r = await fetch(url, {
      headers: { "User-Agent": "Mozilla/5.0 VOID/1.0", Accept: "text/html" },
      signal: controller.signal
    });
    // 明确区分「限流/反爬」和「服务异常」，避免模型把永久拦截当瞬时故障重试。
    if (r.status === 429) {
      throw Object.assign(new Error("DuckDuckGo 搜索限流（HTTP 429），请稍后再试。"), { webCode: "RATE_LIMITED" });
    }
    if (r.status === 403) {
      throw Object.assign(new Error("DuckDuckGo 拒绝了本次请求（HTTP 403，可能触发了反爬）。"), { webCode: "BLOCKED" });
    }
    if (!r.ok) throw new Error(`DuckDuckGo 响应 ${r.status}`);
    html = await r.text();
  } catch (e) {
    const err = e as Error & { name?: string; webCode?: string };
    if (err.webCode) throw e;
    if (err.name === "AbortError") {
      if (signal?.aborted) throw e;
      throw Object.assign(new Error("搜索超时"), { webCode: "TIMEOUT" });
    }
    throw Object.assign(new Error(err.message || "搜索失败"), { webCode: "INTERNAL_ERROR" });
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener("abort", onAbort);
  }

  // 200 也可能是反爬/验证码页：拿到空壳页面就当成功会伪造「无结果」。
  if (!html.trim()) {
    throw Object.assign(new Error("DuckDuckGo 返回了空页面"), { webCode: "INVALID_RESPONSE" });
  }
  if (detectDuckBlock(html)) {
    throw Object.assign(new Error("DuckDuckGo 返回了反爬/验证码页面，本次搜索未完成。"), { webCode: "BLOCKED" });
  }

  const results: WebSearchResultItem[] = [];
  // 极简解析：找 <a class="result__a" href="...">title</a> + 邻近 snippet
  const re = /<a[^>]*class="[^"]*result__a[^"]*"[^>]*href="([^"]+)"[^>]*>([^<]+)<\/a>[\s\S]*?class="[^"]*result__snippet[^"]*"[^>]*>([^<]*)/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null && results.length < limit) {
    const href = m[1] ?? "";
    const title = (m[2] ?? "").trim();
    const snippet = (m[3] ?? "").trim().replace(/\s+/g, " ");
    const url2 = resolveTarget(href);
    if (!title || !url2) continue;
    // 跳过广告
    if (url2.includes("duckduckgo.com/y.js")) continue;
    results.push({ rank: results.length + 1, title, url: url2, snippet, displayUrl: undefined });
  }

  // 兜底：若未解析到，用更宽松的 <a href> 兜
  if (results.length === 0) {
    const re2 = /<a[^>]*href="([^"]+)"[^>]*>([^<]{8,120})<\/a>/gi;
    while ((m = re2.exec(html)) !== null && results.length < limit) {
      const href = m[1]; const title = m[2].trim();
      if (!title || href.includes("duckduckgo.com")) continue;
      const url2 = resolveTarget(href);
      if (!url2.startsWith("http")) continue;
      results.push({ rank: results.length + 1, title, url: url2, snippet: "", displayUrl: undefined });
    }
  }

  return { engine: "duckduckgo", query: q, resultPageUrl: url, results, searchedAt: Date.now() };
}

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

export type WebSearchCloudOptions = {
  /** 用户自备 Key：仅本次请求内存使用，从不落盘，前端经回环传入。 */
  apiKey?: string;
  provider?: "tavily" | "brave" | "exa";
};

const DUCK_HTML = "https://html.duckduckgo.com/html/";

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
    return webSearchViaCloud(q, limit, cloud.provider ?? "tavily", cloud.apiKey.trim(), signal);
  }
  return webSearchViaDuck(q, limit, signal);
}

async function webSearchViaCloud(
  query: string,
  limit: number,
  provider: "tavily" | "brave" | "exa",
  apiKey: string,
  signal?: AbortSignal
): Promise<WebSearchData> {
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
    const r = await fetch("https://api.tavily.com/search", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ api_key: apiKey, query, max_results: capped, search_depth: "advanced", include_answer: false }),
      signal: controller.signal
    });
    if (r.status === 401 || r.status === 403) {
      throw Object.assign(new Error("搜索 Key 无效，请去设置 → 联网搜索里检查后重试。"), { webCode: "KEY_INVALID" });
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
    if (err.name === "AbortError") throw Object.assign(new Error("搜索超时"), { webCode: "TIMEOUT" });
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
    if (!r.ok) throw new Error(`DuckDuckGo 响应 ${r.status}`);
    html = await r.text();
  } catch (e) {
    const err = e as Error & { name?: string };
    if (err.name === "AbortError") throw Object.assign(new Error("搜索超时"), { webCode: "TIMEOUT" });
    throw Object.assign(new Error(err.message || "搜索失败"), { webCode: "INTERNAL_ERROR" });
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener("abort", onAbort);
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

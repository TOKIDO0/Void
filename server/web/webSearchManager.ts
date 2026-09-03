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
  engine: "duckduckgo";
  query: string;
  resultPageUrl: string;
  results: WebSearchResultItem[];
  searchedAt: number;
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

export async function webSearch(query: string, limit = 8, signal?: AbortSignal): Promise<WebSearchData> {
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

import { bridgeAuthHeadersForUrl } from "../../../lib/runtime/voidBridgeAuth";
import { resolveVoidBridgeOrigin } from "../../../lib/runtime/voidBridgeRuntime";
import { loadWebSearchConfig } from "../../settings/webSearchConfig";

function resolveOrigin(): string {
  return resolveVoidBridgeOrigin();
}

type CloudSearchHit = { title: string; url: string; snippet: string };

/** 有用户自备 Key 时走云索引直连（不经本机 bridge），失败自动回落 bridge。
 * 401/403 直接抛 Key 无效（诚实，不吞错）；网络异常才回落。 */
async function webSearchViaCloud(query: string, limit: number, signal?: AbortSignal): Promise<CloudSearchHit[] | null> {
  const { provider, apiKey } = loadWebSearchConfig();
  const key = apiKey.trim();
  if (!key) return null;
  return webSearchViaCloudWithKey(query, limit, provider, key, signal);
}

/** 设置页“测试搜索”用：直接拿草稿里的服务商+Key 验连通性，不读已保存配置。 */
export async function testWebSearchConnection(
  provider: "tavily" | "brave" | "exa",
  apiKey: string,
  signal?: AbortSignal
): Promise<number> {
  const key = apiKey.trim();
  if (!key) throw new Error("请先填写搜索 Key，再点测试。");
  const hits = await webSearchViaCloudWithKey("GitHub", 1, provider, key, signal);
  return hits?.length ?? 0;
}

async function webSearchViaCloudWithKey(
  query: string,
  limit: number,
  provider: "tavily" | "brave" | "exa",
  key: string,
  signal?: AbortSignal
): Promise<CloudSearchHit[] | null> {
  const capped = Math.min(Math.max(limit, 1), 10);
  const withTimeout = (ms: number): { signal: AbortSignal; done: () => void } => {
    const controller = new AbortController();
    const timer = window.setTimeout(() => controller.abort(), ms);
    if (signal) {
      if (signal.aborted) controller.abort();
      else signal.addEventListener("abort", () => controller.abort(), { once: true });
    }
    return { signal: controller.signal, done: () => window.clearTimeout(timer) };
  };
  try {
    if (provider === "tavily") {
      const t = withTimeout(12000);
      try {
        const r = await fetch("https://api.tavily.com/search", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ api_key: key, query, max_results: capped, search_depth: "advanced", include_answer: false }),
          signal: t.signal
        });
        if (!r.ok) {
          if (r.status === 401 || r.status === 403) {
            throw Object.assign(new Error("搜索 Key 无效，请去设置 → 联网搜索里检查后重试。"), { webCode: "KEY_INVALID" });
          }
          return null;
        }
        const j = await r.json() as { results?: Array<{ title?: string; url?: string; content?: string }> };
        const hits = (j.results ?? []).filter((x) => x.url).map((x) => ({
          title: (x.title ?? x.url ?? "").trim() || "Untitled",
          url: (x.url ?? "").trim(),
          snippet: (x.content ?? "").slice(0, 500)
        }));
        return hits.length ? hits : null;
      } finally {
        t.done();
      }
    }
    if (provider === "brave") {
      const t = withTimeout(12000);
      try {
        const r = await fetch(`https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=${capped}`, {
          headers: { "X-Subscription-Token": key },
          signal: t.signal
        });
        if (!r.ok) {
          if (r.status === 401 || r.status === 403) {
            throw Object.assign(new Error("搜索 Key 无效，请去设置 → 联网搜索里检查后重试。"), { webCode: "KEY_INVALID" });
          }
          return null;
        }
        const j = await r.json() as { web?: { results?: Array<{ title?: string; url?: string; description?: string }> } };
        const hits = (j.web?.results ?? []).filter((x) => x.url).map((x) => ({
          title: (x.title ?? x.url ?? "").trim() || "Untitled",
          url: (x.url ?? "").trim(),
          snippet: (x.description ?? "").slice(0, 500)
        }));
        return hits.length ? hits : null;
      } finally {
        t.done();
      }
    }
    const t = withTimeout(12000);
    try {
      const r = await fetch("https://api.exa.ai/search", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-api-key": key },
        body: JSON.stringify({ query, numResults: capped }),
        signal: t.signal
      });
        if (!r.ok) {
          if (r.status === 401 || r.status === 403) {
            throw Object.assign(new Error("搜索 Key 无效，请去设置 → 联网搜索里检查后重试。"), { webCode: "KEY_INVALID" });
          }
          return null;
        }
        const j = await r.json() as { results?: Array<{ title?: string; url?: string; text?: string }> };
      const hits = (j.results ?? []).filter((x) => x.url).map((x) => ({
        title: (x.title ?? x.url ?? "").trim() || "Untitled",
        url: (x.url ?? "").trim(),
        snippet: (x.text ?? "").slice(0, 500)
      }));
      return hits.length ? hits : null;
    } finally {
      t.done();
    }
  } catch (e) {
    // Key 无效必须诚实上浮，其它网络异常才回落 bridge。
    if ((e as { webCode?: string })?.webCode === "KEY_INVALID") throw e;
    return null;
  }
}

export async function webSearchViaBridge(query: string, limit = 8, signal?: AbortSignal) {
  const cloud = await webSearchViaCloud(query, limit, signal);
  if (cloud) {
    return {
      engine: "cloud",
      query,
      resultPageUrl: cloud[0]?.url ?? "",
      results: cloud.map((hit, index) => ({ rank: index + 1, ...hit })),
      searchedAt: Date.now()
    };
  }
  // Key 随本次请求经回环透给 bridge，服务端只做内存转发（Tavily 等云索引），从不落盘；
  // 无 Key 时服务端走免费 DuckDuckGo 链路。
  const { provider, apiKey } = loadWebSearchConfig();
  const trimmedKey = apiKey.trim();
  const url = `${resolveOrigin()}/void-web/search`;
  const headers: Record<string, string> = { "Content-Type": "application/json", ...(await bridgeAuthHeadersForUrl(url)) };
  const r = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify(trimmedKey ? { query, limit, apiKey: trimmedKey, provider } : { query, limit }),
    signal
  });
  const j = await r.json() as { ok: boolean; data?: unknown; error?: { code: string; message: string } };
  if (!j.ok) throw Object.assign(new Error(j.error?.message ?? "搜索失败"), { webCode: j.error?.code });
  return j.data as { engine: string; query: string; resultPageUrl: string; results: Array<{ rank: number; title: string; url: string; snippet: string }>; searchedAt: number };
}

export async function webFetchViaBridge(url: string, signal?: AbortSignal) {
  const endpoint = `${resolveOrigin()}/void-web/fetch`;
  const headers: Record<string, string> = { "Content-Type": "application/json", ...(await bridgeAuthHeadersForUrl(endpoint)) };
  const r = await fetch(endpoint, { method: "POST", headers, body: JSON.stringify({ url }), signal });
  const j = await r.json() as { ok: boolean; data?: unknown; error?: { code: string; message: string } };
  if (!j.ok) throw Object.assign(new Error(j.error?.message ?? "抓取失败"), { webCode: j.error?.code });
  return j.data as { url: string; finalUrl: string; contentType: string; status: number; text: string; truncated: boolean; fetchedAt: number };
}

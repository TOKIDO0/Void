import { bridgeAuthHeadersForUrl } from "../../../lib/runtime/voidBridgeAuth";
import { resolveVoidBridgeOrigin } from "../../../lib/runtime/voidBridgeRuntime";
import { loadWebSearchConfig } from "../../settings/webSearchConfig";

function resolveOrigin(): string {
  return resolveVoidBridgeOrigin();
}

type CloudSearchHit = { title: string; url: string; snippet: string };

/** 有用户自备 Key 时走云索引直连（不经本机 bridge），失败自动回落免费链路。 */
async function webSearchViaCloud(query: string, limit: number, signal?: AbortSignal): Promise<CloudSearchHit[] | null> {
  const { provider, apiKey } = loadWebSearchConfig();
  const key = apiKey.trim();
  if (!key) return null;
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
        if (!r.ok) return null;
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
        if (!r.ok) return null;
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
      if (!r.ok) return null;
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
  } catch {
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
  const url = `${resolveOrigin()}/void-web/search`;
  const headers: Record<string, string> = { "Content-Type": "application/json", ...(await bridgeAuthHeadersForUrl(url)) };
  const r = await fetch(url, { method: "POST", headers, body: JSON.stringify({ query, limit }), signal });
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

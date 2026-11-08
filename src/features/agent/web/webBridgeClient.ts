import { bridgeAuthHeadersForUrl } from "../../../lib/runtime/voidBridgeAuth";
import { resolveVoidBridgeOrigin } from "../../../lib/runtime/voidBridgeRuntime";
import { loadWebSearchConfig } from "../../settings/webSearchConfig";
import { isVaultRef } from "../../../lib/runtime/secretVault";

function resolveOrigin(): string {
  return resolveVoidBridgeOrigin();
}

type CloudSearchHit = { title: string; url: string; snippet: string };

/** 结构化联网错误：webCode 是唯一分类来源，供 webToolShared 映射成 ToolError。 */
function createWebBridgeError(
  webCode: string,
  message: string,
  details?: Record<string, unknown>
) {
  return Object.assign(new Error(message), { webCode, webDetails: details });
}

/**
 * 读取联网错误分类。
 * 只有带 webCode 的错误才有已知类别；其余一律 UNKNOWN，禁止在调用方猜根因。
 */
export function getWebBridgeErrorInfo(error: unknown): {
  code: string;
  message: string;
  details?: Record<string, unknown>;
} {
  if (
    typeof error === "object"
    && error !== null
    && typeof (error as { webCode?: unknown }).webCode === "string"
  ) {
    const coded = error as Error & { webCode: string; webDetails?: Record<string, unknown> };
    return { code: coded.webCode, message: coded.message, details: coded.webDetails };
  }

  if (error instanceof Error) {
    return { code: "UNKNOWN", message: error.message };
  }

  return { code: "UNKNOWN", message: "联网请求失败" };
}

export type WebSearchCloudParams = {
  topic?: "general" | "news" | "finance";
  timeRange?: "day" | "week" | "month" | "year";
  searchDepth?: "basic" | "advanced";
};

/** 有用户自备 Key 时走云索引直连（不经本机 bridge），失败自动回落 bridge。
 * 401/403 直接抛 Key 无效（诚实，不吞错）；网络异常才回落。 */
async function webSearchViaCloud(query: string, limit: number, signal?: AbortSignal, params?: WebSearchCloudParams): Promise<CloudSearchHit[] | null> {
  const { provider, apiKey } = loadWebSearchConfig();
  const key = apiKey.trim();
  if (!key) return null;
  if (isVaultRef(key)) {
    // vault 引用必须先异步解出明文，绝不把引用当 Key 发出去。
    const { loadWebSearchConfigAsync } = await import("../../settings/webSearchConfig");
    const resolved = await loadWebSearchConfigAsync();
    const resolvedKey = resolved.apiKey.trim();
    if (!resolvedKey) return null;
    return webSearchViaCloudWithKey(query, limit, resolved.provider, resolvedKey, signal, params);
  }
  return webSearchViaCloudWithKey(query, limit, provider, key, signal, params);
}

/** 设置页“测试搜索”用：直接拿草稿里的服务商+Key 验连通性，不读已保存配置。 */
export async function testWebSearchConnection(
  provider: "tavily" | "brave" | "exa",
  apiKey: string,
  signal?: AbortSignal
): Promise<number> {
  const key = apiKey.trim();
  if (!key) throw new Error("请先填写搜索 Key，再点测试。");
  if (isVaultRef(key)) throw new Error("已存 Key 为加密引用，请重新填写明文后再测试。");
  // 最便宜的探针：basic + general + 1 条，不烧 advanced 额度。
  const hits = await webSearchViaCloudWithKey("GitHub", 1, provider, key, signal, { searchDepth: "basic", topic: "general" });
  return hits?.length ?? 0;
}

async function webSearchViaCloudWithKey(
  query: string,
  limit: number,
  provider: "tavily" | "brave" | "exa",
  key: string,
  signal?: AbortSignal,
  params?: WebSearchCloudParams
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
        const topic = params?.topic === "news" || params?.topic === "finance" ? params.topic : "general";
        const timeRange = params?.timeRange === "day" || params?.timeRange === "week" || params?.timeRange === "month" || params?.timeRange === "year" ? params.timeRange : undefined;
        const searchDepth = params?.searchDepth === "advanced" ? "advanced" : "basic";
        const r = await fetch("https://api.tavily.com/search", {
          method: "POST",
          headers: { "Content-Type": "application/json", "Authorization": `Bearer ${key}` },
          body: JSON.stringify({
            query,
            max_results: capped,
            search_depth: searchDepth,
            topic,
            ...(timeRange ? { time_range: timeRange } : {}),
            include_answer: false
          }),
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

export async function webSearchViaBridge(query: string, limit = 8, signal?: AbortSignal, params?: WebSearchCloudParams) {
  const cloud = await webSearchViaCloud(query, limit, signal, params);
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
  const { loadWebSearchConfigAsync } = await import("../../settings/webSearchConfig");
  const { provider, apiKey } = await loadWebSearchConfigAsync();
  const trimmedKey = apiKey.trim();
  const url = `${resolveOrigin()}/void-web/search`;
  const headers: Record<string, string> = { "Content-Type": "application/json", ...(await bridgeAuthHeadersForUrl(url)) };
  const topic = params?.topic === "news" || params?.topic === "finance" ? params.topic : undefined;
  const timeRange = params?.timeRange === "day" || params?.timeRange === "week" || params?.timeRange === "month" || params?.timeRange === "year" ? params.timeRange : undefined;
  const searchDepth = params?.searchDepth === "advanced" ? "advanced" : undefined;
  let r: Response;
  try {
    r = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(trimmedKey ? { query, limit, apiKey: trimmedKey, provider, topic, timeRange, searchDepth } : { query, limit }),
      signal
    });
  } catch (error) {
    // 取消必须原样上抛，交给执行器判定 CANCELLED；其余连接失败才是桥接不可达。
    if (error instanceof Error && error.name === "AbortError") throw error;
    throw createWebBridgeError("BRIDGE_UNREACHABLE", "本机联网服务未连接", {
      transport: error instanceof Error ? error.message : undefined
    });
  }

  let j: { ok: boolean; data?: unknown; error?: { code: string; message: string } };
  try {
    j = await r.json() as { ok: boolean; data?: unknown; error?: { code: string; message: string } };
  } catch {
    throw createWebBridgeError(
      "INVALID_RESPONSE",
      `本机联网服务返回了非 JSON 响应（HTTP ${r.status}）`,
      { status: r.status }
    );
  }
  if (!j.ok) {
    throw createWebBridgeError(j.error?.code ?? "INTERNAL_ERROR", j.error?.message ?? "搜索失败");
  }
  return j.data as { engine: string; query: string; resultPageUrl: string; results: Array<{ rank: number; title: string; url: string; snippet: string }>; searchedAt: number };
}

export async function webFetchViaBridge(url: string, signal?: AbortSignal) {
  const endpoint = `${resolveOrigin()}/void-web/fetch`;
  const headers: Record<string, string> = { "Content-Type": "application/json", ...(await bridgeAuthHeadersForUrl(endpoint)) };
  let r: Response;
  try {
    r = await fetch(endpoint, { method: "POST", headers, body: JSON.stringify({ url }), signal });
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") throw error;
    throw createWebBridgeError("BRIDGE_UNREACHABLE", "本机联网服务未连接", {
      transport: error instanceof Error ? error.message : undefined
    });
  }

  let j: { ok: boolean; data?: unknown; error?: { code: string; message: string } };
  try {
    j = await r.json() as { ok: boolean; data?: unknown; error?: { code: string; message: string } };
  } catch {
    throw createWebBridgeError(
      "INVALID_RESPONSE",
      `本机联网服务返回了非 JSON 响应（HTTP ${r.status}）`,
      { status: r.status }
    );
  }
  if (!j.ok) {
    throw createWebBridgeError(j.error?.code ?? "INTERNAL_ERROR", j.error?.message ?? "抓取失败");
  }
  return j.data as { url: string; finalUrl: string; contentType: string; status: number; text: string; truncated: boolean; fetchedAt: number };
}

import { bridgeAuthHeadersForUrl } from "../../../lib/runtime/voidBridgeAuth";

const DEFAULT_BRIDGE_ORIGIN = "http://127.0.0.1:17872";
function resolveOrigin(): string {
  const env = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env;
  const o = env?.VOID_BRIDGE_ORIGIN?.trim();
  if (o) return o.replace(/\/$/, "");
  const p = env?.VOID_BRIDGE_PORT?.trim();
  if (p) return `http://127.0.0.1:${p}`;
  return DEFAULT_BRIDGE_ORIGIN;
}

export async function webSearchViaBridge(query: string, limit = 8, signal?: AbortSignal) {
  const url = `${resolveOrigin()}/void-web/search`;
  const headers: Record<string, string> = { "Content-Type": "application/json", ...(await bridgeAuthHeadersForUrl(url)) };
  const r = await fetch(url, { method: "POST", headers, body: JSON.stringify({ query, limit }), signal });
  const j = await r.json() as { ok: boolean; data?: unknown; error?: { code: string; message: string } };
  if (!j.ok) throw Object.assign(new Error(j.error?.message ?? "搜索失败"), { webCode: j.error?.code });
  return j.data as { engine: string; query: string; resultPageUrl: string; results: Array<{ rank: number; title: string; url: string; snippet: string }>; searchedAt: number };
}

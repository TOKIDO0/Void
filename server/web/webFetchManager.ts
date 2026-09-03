/**
 * WebFetch 通用精读：GET 单页 → 文本/ Markdown
 * 对标 Claude Code WebFetch / Hermes WebFetch
 * 只读、大小/超时/SSRF 防护，复用 fileDownloadSafety 同策略
 */

export type WebFetchData = {
  url: string;
  finalUrl: string;
  contentType: string;
  status: number;
  text: string;
  truncated: boolean;
  fetchedAt: number;
};

const MAX_BYTES = 1 * 1024 * 1024;
const TIMEOUT_MS = 12000;
const ALLOWED_PROTOCOLS = new Set(["http:", "https:"]);

function isPrivateHost(hostname: string): boolean {
  const h = hostname.toLowerCase();
  if (h === "localhost" || h === "127.0.0.1" || h === "::1") return true;
  if (/^10\./.test(h) || /^192\.168\./.test(h) || /^172\.(1[6-9]|2\d|3[01])\./.test(h)) return true;
  if (h.endsWith(".localhost") || h.endsWith(".internal") || h.endsWith(".local")) return true;
  if (!h.includes(".")) return true;
  return false;
}

function htmlToText(html: string): string {
  let t = html.replace(/<script[\s\S]*?<\/script>/gi, " ").replace(/<style[\s\S]*?<\/style>/gi, " ");
  t = t.replace(/<[^>]+>/g, " ");
  t = t.replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'");
  t = t.replace(/\s+/g, " ").trim();
  // 截断到 20000 字符，保留上下文
  if (t.length > 20000) t = t.slice(0, 20000) + "\n...[已截断]";
  return t;
}

export async function webFetch(url: string, signal?: AbortSignal): Promise<WebFetchData> {
  let parsed: URL;
  try {
    parsed = new URL(url.trim());
  } catch {
    throw Object.assign(new Error("URL 格式不正确"), { webCode: "INVALID_REQUEST" });
  }
  if (!ALLOWED_PROTOCOLS.has(parsed.protocol)) {
    throw Object.assign(new Error("仅支持 http/https"), { webCode: "INVALID_REQUEST" });
  }
  if (isPrivateHost(parsed.hostname)) {
    throw Object.assign(new Error("不允许访问本地/私网/内网地址"), { webCode: "INVALID_REQUEST" });
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);
  const onAbort = () => controller.abort();
  if (signal) {
    if (signal.aborted) controller.abort();
    else signal.addEventListener("abort", onAbort, { once: true });
  }

  let res: Response;
  try {
    res = await fetch(parsed.toString(), {
      headers: { "User-Agent": "VOID/1.0", Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8" },
      signal: controller.signal,
      redirect: "follow"
    });
  } catch (e) {
    const err = e as Error & { name?: string };
    if (err.name === "AbortError") throw Object.assign(new Error("抓取超时"), { webCode: "TIMEOUT" });
    throw Object.assign(new Error(err.message || "抓取失败"), { webCode: "INTERNAL_ERROR" });
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener("abort", onAbort);
  }

  if (!res.ok) {
    throw Object.assign(new Error(`目标返回 ${res.status}`), { webCode: "INTERNAL_ERROR" });
  }

  const contentType = res.headers.get("content-type") || "";
  const buf = new Uint8Array(await res.arrayBuffer());
  if (buf.length > MAX_BYTES) {
    throw Object.assign(new Error("页面过大"), { webCode: "TOO_LARGE" });
  }
  const textRaw = new TextDecoder().decode(buf);
  const isHtml = contentType.includes("html") || textRaw.trim().startsWith("<");
  const text = isHtml ? htmlToText(textRaw) : textRaw.slice(0, 20000);
  const truncated = textRaw.length > 20000 || buf.length >= MAX_BYTES;

  return {
    url: parsed.toString(),
    finalUrl: res.url || parsed.toString(),
    contentType: contentType || (isHtml ? "text/html" : "text/plain"),
    status: res.status,
    text,
    truncated,
    fetchedAt: Date.now()
  };
}

/**
 * WebFetch 通用精读：GET 单页 → 文本/ Markdown
 * 对标 Claude Code WebFetch / Hermes WebFetch
 * 只读、大小/超时/SSRF 防护，统一消费 server/net/ssrfGuard（DNS pin + 编码IP归一化 + 逐跳重验）。
 */

import {
  SSRF_DEFAULT_MAX_BYTES,
  SSRF_DEFAULT_TIMEOUT_MS,
  assertPublicUrl
} from "../net/ssrfGuard";

export type WebFetchData = {
  url: string;
  finalUrl: string;
  contentType: string;
  status: number;
  text: string;
  truncated: boolean;
  fetchedAt: number;
};

const MAX_BYTES = SSRF_DEFAULT_MAX_BYTES;
const TIMEOUT_MS = SSRF_DEFAULT_TIMEOUT_MS;
const MAX_REDIRECTS = 5;

/** 简易速率守卫：10 秒窗口至多 20 次抓取，防止模型循环打爆出口。 */
const RATE_WINDOW_MS = 10_000;
const RATE_MAX_REQUESTS = 20;
let rateWindowStart = 0;
let rateWindowCount = 0;

function assertFetchRate(): void {
  const now = Date.now();
  if (now - rateWindowStart >= RATE_WINDOW_MS) {
    rateWindowStart = now;
    rateWindowCount = 0;
  }
  rateWindowCount += 1;
  if (rateWindowCount > RATE_MAX_REQUESTS) {
    throw Object.assign(new Error("抓取频率过高，请稍后再试"), { webCode: "RATE_LIMITED" });
  }
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
  assertFetchRate();
  const startUrl = url.trim();
  // 首跳校验（含 DNS pin + 编码 IP 归一化）
  try {
    await assertPublicUrl(startUrl, { allowHttp: true });
  } catch (error) {
    throw toWebError(error);
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);
  const onAbort = () => controller.abort();
  if (signal) {
    if (signal.aborted) controller.abort();
    else signal.addEventListener("abort", onAbort, { once: true });
  }

  let current = startUrl;
  let res: Response | null = null;
  try {
    for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
      // 逐跳重验：重定向目标重新走 DNS pin + 分类
      try {
        const checked = await assertPublicUrl(current, { allowHttp: true });
        current = checked.toString();
      } catch (error) {
        throw toWebError(error);
      }
      try {
        res = await fetch(current, {
          headers: { "User-Agent": "VOID/1.0", Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8" },
          signal: controller.signal,
          redirect: "manual"
        });
      } catch (e) {
        const err = e as Error & { name?: string };
        if (err.name === "AbortError") throw Object.assign(new Error("抓取超时"), { webCode: "TIMEOUT" });
        throw Object.assign(new Error(err.message || "抓取失败"), { webCode: "INTERNAL_ERROR" });
      }
      if (res.status >= 300 && res.status < 400) {
        const location = res.headers.get("location");
        try {
          await res.body?.cancel();
        } catch {
          // ignore
        }
        if (!location) {
          throw Object.assign(new Error(`重定向缺少 Location（HTTP ${res.status}）`), { webCode: "INTERNAL_ERROR" });
        }
        current = new URL(location, current).toString();
        continue;
      }
      break;
    }
    if (!res) {
      throw Object.assign(new Error("抓取失败"), { webCode: "INTERNAL_ERROR" });
    }
    if (res.status >= 300 && res.status < 400) {
      throw Object.assign(new Error("重定向次数过多"), { webCode: "INTERNAL_ERROR" });
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
      url: startUrl,
      finalUrl: current,
      contentType: contentType || (isHtml ? "text/html" : "text/plain"),
      status: res.status,
      text,
      truncated,
      fetchedAt: Date.now()
    };
  } catch (e) {
    const err = e as Error & { name?: string; webCode?: string; ssrfCode?: string };
    if (err.webCode) throw e;
    if (err.name === "AbortError") throw Object.assign(new Error("抓取超时"), { webCode: "TIMEOUT" });
    throw e;
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener("abort", onAbort);
  }
}

function toWebError(error: unknown): Error {
  const coded = error as { ssrfCode?: string; message?: string };
  if (coded?.ssrfCode === "PRIVATE_NETWORK_URL") {
    return Object.assign(new Error("不允许访问本地/私网/内网地址"), { webCode: "INVALID_REQUEST" });
  }
  if (coded?.ssrfCode === "DNS_LOOKUP_FAILED") {
    return Object.assign(new Error(coded.message || "主机解析失败"), { webCode: "INVALID_REQUEST" });
  }
  return Object.assign(new Error((error as Error)?.message || "URL 格式不正确"), { webCode: "INVALID_REQUEST" });
}

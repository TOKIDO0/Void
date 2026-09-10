/**
 * 通用文件直链下载的网络安全边界。
 * 重点防 SSRF：禁止公网 URL 重定向到本机、私网、链路本地或单标签主机名。
 * 统一消费 server/net/ssrfGuard（DNS pin + 编码 IP 归一化 + 逐跳重验），
 * 本文件只保留下载语义（manual 重定向链 + header 超时 + 私网 allowlist 环境名映射）。
 */

import { createFileError } from "./fileRuntimePaths";
import {
  assertPublicUrl,
  readPrivateHostAllowlist
} from "../net/ssrfGuard";

const DEFAULT_MAX_REDIRECTS = 8;
const DEFAULT_HEADER_TIMEOUT_MS = 90_000;
const DEFAULT_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36";

type GuardedFetchOptions = {
  signal?: AbortSignal;
  maxRedirects?: number;
  headerTimeoutMs?: number;
  headers?: Record<string, string>;
};

type PrivateDownloadHostRule = {
  hostname: string;
  port?: string;
};

export type GuardedDownloadFetchResult = {
  response: Response;
  finalUrl: string;
  redirectChain: string[];
};

export async function fetchWithPublicDownloadGuard(
  startUrl: string,
  options: GuardedFetchOptions = {}
): Promise<GuardedDownloadFetchResult> {
  const maxRedirects = options.maxRedirects ?? DEFAULT_MAX_REDIRECTS;
  let current = (await assertPublicHttpDownloadUrl(startUrl)).toString();
  const redirectChain = [current];

  for (let hop = 0; hop <= maxRedirects; hop += 1) {
    if (options.signal?.aborted) {
      throw createFileError("DOWNLOAD_FAILED", "下载已取消");
    }

    const response = await fetchDownloadHeaders(current, options);
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      await cancelResponseBody(response);
      if (!location) {
        throw createFileError(
          "DOWNLOAD_FAILED",
          `重定向缺少 Location（HTTP ${response.status}）`,
          { url: current, status: response.status }
        );
      }

      const nextUrl = new URL(location, current).toString();
      current = (await assertPublicHttpDownloadUrl(nextUrl)).toString();
      redirectChain.push(current);
      continue;
    }

    return { response, finalUrl: current, redirectChain };
  }

  throw createFileError(
    "DOWNLOAD_FAILED",
    `重定向次数过多（超过 ${maxRedirects} 次）`,
    { startUrl }
  );
}

async function fetchDownloadHeaders(
  url: string,
  options: GuardedFetchOptions
): Promise<Response> {
  const controller = new AbortController();
  const abort = () => controller.abort();
  const timer = setTimeout(abort, options.headerTimeoutMs ?? DEFAULT_HEADER_TIMEOUT_MS);
  options.signal?.addEventListener("abort", abort, { once: true });

  try {
    return await fetch(url, {
      method: "GET",
      redirect: "manual",
      signal: controller.signal,
      headers: {
        "User-Agent": DEFAULT_USER_AGENT,
        ...(options.headers ?? {})
      }
    });
  } catch (error) {
    throw createFileError(
      "DOWNLOAD_FAILED",
      error instanceof Error ? `下载失败：${error.message}` : "下载失败",
      { url }
    );
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", abort);
  }
}

async function assertPublicHttpDownloadUrl(urlText: string): Promise<URL> {
  try {
    return await assertPublicUrl(urlText, {
      allowHttp: true,
      allowlist: readPrivateHostAllowlist("VOID_DOWNLOAD_ALLOWED_PRIVATE_HOSTS")
    });
  } catch (error) {
    const coded = error as { ssrfCode?: string; message?: string; details?: Record<string, unknown> };
    if (coded?.ssrfCode === "PRIVATE_NETWORK_URL") {
      const details = coded.details as { host?: string; reason?: string } | undefined;
      throwBlockedDownload(details?.host ?? urlText, details?.reason ?? coded.message ?? "私有网络地址");
    }
    if (coded?.ssrfCode === "DNS_LOOKUP_FAILED") {
      throw createFileError(
        "DOWNLOAD_FAILED",
        coded.message ?? `无法解析主机：${urlText}`,
        { failureCode: "DNS_LOOKUP_FAILED", host: urlText }
      );
    }
    throw createFileError("INVALID_REQUEST", coded?.message ?? `非法 URL：${urlText}`);
  }
}

function throwBlockedDownload(host: string, reason: string): never {
  throw createFileError(
    "DOWNLOAD_BLOCKED",
    `拒绝从本地或私有网络地址下载：${host}`,
    { failureCode: "PRIVATE_NETWORK_URL", host, reason }
  );
}

async function cancelResponseBody(response: Response) {
  try {
    await response.body?.cancel();
  } catch {
    // ignore
  }
}

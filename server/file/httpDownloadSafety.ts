/**
 * 通用文件直链下载的网络安全边界。
 * 重点防 SSRF：禁止公网 URL 重定向到本机、私网、链路本地或单标签主机名。
 */

import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { createFileError } from "./fileRuntimePaths";

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
  let parsed: URL;
  try {
    parsed = new URL(urlText.trim());
  } catch {
    throw createFileError("INVALID_REQUEST", `非法 URL：${urlText}`);
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw createFileError("INVALID_REQUEST", `仅允许 http/https 下载：${urlText}`);
  }

  const hostname = normalizeHostname(parsed.hostname);
  const privateHostAllowed = isPrivateDownloadHostAllowed(parsed, hostname);
  const hostReason = classifyBlockedHostname(hostname);
  if (hostReason && !privateHostAllowed) {
    throwBlockedDownload(hostname, hostReason);
  }

  if (!isIP(hostname) && !privateHostAllowed) {
    await assertHostnameResolvesPublic(hostname);
  }

  return parsed;
}

function normalizeHostname(hostname: string): string {
  return hostname.replace(/^\[|\]$/g, "").replace(/\.$/, "").toLowerCase();
}

function classifyBlockedHostname(hostname: string): string | null {
  if (!hostname) {
    return "空主机名";
  }
  if (hostname === "localhost" || hostname.endsWith(".localhost")) {
    return "localhost 回环地址";
  }
  if (
    hostname.endsWith(".local")
    || hostname.endsWith(".lan")
    || hostname.endsWith(".internal")
    || hostname.endsWith(".home.arpa")
  ) {
    return "本地域名或内网域名";
  }
  if (!hostname.includes(".") && !hostname.includes(":")) {
    return "单标签主机名，通常指向内网设备";
  }

  return classifyBlockedIp(hostname);
}

function isPrivateDownloadHostAllowed(parsed: URL, hostname: string): boolean {
  const rules = readPrivateDownloadHostAllowlist();
  if (!rules.length) {
    return false;
  }

  const port = parsed.port || defaultPortForProtocol(parsed.protocol);
  return rules.some((rule) =>
    rule.hostname === hostname && (!rule.port || rule.port === port)
  );
}

function readPrivateDownloadHostAllowlist(): PrivateDownloadHostRule[] {
  const raw = process.env.VOID_DOWNLOAD_ALLOWED_PRIVATE_HOSTS?.trim();
  if (!raw) {
    return [];
  }

  const rules: PrivateDownloadHostRule[] = [];
  for (const entry of raw.split(/[\s,;]+/)) {
    const rule = parsePrivateDownloadHostRule(entry);
    if (rule) {
      rules.push(rule);
    }
  }
  return rules;
}

function parsePrivateDownloadHostRule(entry: string): PrivateDownloadHostRule | null {
  const trimmed = entry.trim();
  if (!trimmed || trimmed.includes("*")) {
    return null;
  }

  if (/^https?:\/\//i.test(trimmed)) {
    try {
      const parsed = new URL(trimmed);
      return {
        hostname: normalizeHostname(parsed.hostname),
        port: parsed.port || defaultPortForProtocol(parsed.protocol)
      };
    } catch {
      return null;
    }
  }

  if (trimmed.startsWith("[")) {
    const closeIndex = trimmed.indexOf("]");
    if (closeIndex < 0) {
      return null;
    }
    const hostname = normalizeHostname(trimmed.slice(1, closeIndex));
    const portText = trimmed.slice(closeIndex + 1).replace(/^:/, "");
    return buildPrivateHostRule(hostname, portText);
  }

  const separatorIndex = trimmed.lastIndexOf(":");
  if (separatorIndex >= 0 && trimmed.indexOf(":") === separatorIndex) {
    const hostname = normalizeHostname(trimmed.slice(0, separatorIndex));
    const portText = trimmed.slice(separatorIndex + 1);
    return buildPrivateHostRule(hostname, portText);
  }

  return buildPrivateHostRule(normalizeHostname(trimmed), "");
}

function buildPrivateHostRule(hostname: string, portText: string): PrivateDownloadHostRule | null {
  if (!hostname || hostname.includes("*")) {
    return null;
  }
  const port = portText ? normalizePort(portText) : undefined;
  if (portText && !port) {
    return null;
  }
  return { hostname, port };
}

function normalizePort(portText: string): string | undefined {
  const port = Number.parseInt(portText, 10);
  if (!Number.isInteger(port) || port <= 0 || port >= 65536 || String(port) !== portText) {
    return undefined;
  }
  return String(port);
}

function defaultPortForProtocol(protocol: string): string {
  return protocol === "https:" ? "443" : "80";
}

async function assertHostnameResolvesPublic(hostname: string): Promise<void> {
  let records: Array<{ address: string }>;
  try {
    records = await lookup(hostname, { all: true, verbatim: true });
  } catch {
    throw createFileError(
      "DOWNLOAD_FAILED",
      `无法解析主机：${hostname}`,
      { failureCode: "DNS_LOOKUP_FAILED", host: hostname }
    );
  }

  if (!records.length) {
    throw createFileError(
      "DOWNLOAD_FAILED",
      `主机无解析结果：${hostname}`,
      { failureCode: "DNS_LOOKUP_EMPTY", host: hostname }
    );
  }

  for (const record of records) {
    const reason = classifyBlockedIp(record.address);
    if (reason) {
      throwBlockedDownload(hostname, `${reason}（DNS：${record.address}）`);
    }
  }
}

function classifyBlockedIp(value: string): string | null {
  const ip = normalizeHostname(value);
  const ipv4 = parseIpv4(ip);
  if (ipv4) {
    const [a, b] = ipv4;
    if (a === 0) return "0.0.0.0/8 本地网络地址";
    if (a === 10) return "10.0.0.0/8 私有地址";
    if (a === 127) return "127.0.0.0/8 回环地址";
    if (a === 169 && b === 254) return "169.254.0.0/16 链路本地地址";
    if (a === 172 && b >= 16 && b <= 31) return "172.16.0.0/12 私有地址";
    if (a === 192 && b === 168) return "192.168.0.0/16 私有地址";
    if (a === 100 && b >= 64 && b <= 127) return "100.64.0.0/10 运营商级 NAT 地址";
    if (a >= 224) return "组播或保留 IPv4 地址";
    return null;
  }

  if (!isIP(ip)) {
    return null;
  }

  if (ip === "::" || ip === "::1" || ip === "0:0:0:0:0:0:0:1") {
    return "IPv6 回环或未指定地址";
  }
  if (ip.startsWith("fe80:")) {
    return "IPv6 链路本地地址";
  }
  if (/^f[cd][0-9a-f]{2}:/i.test(ip)) {
    return "IPv6 唯一本地地址";
  }

  const mappedIpv4 = parseMappedIpv4(ip);
  return mappedIpv4 ? classifyBlockedIp(mappedIpv4) : null;
}

function parseIpv4(value: string): [number, number, number, number] | null {
  const parts = value.split(".");
  if (parts.length !== 4) {
    return null;
  }
  const octets = parts.map((part) => Number.parseInt(part, 10));
  if (
    octets.some((octet, index) =>
      !Number.isInteger(octet)
      || octet < 0
      || octet > 255
      || String(octet) !== parts[index]
    )
  ) {
    return null;
  }
  return octets as [number, number, number, number];
}

function parseMappedIpv4(value: string): string | null {
  const lower = value.toLowerCase();
  const mapped = lower.match(/^(?:0:0:0:0:0:ffff:|::ffff:)(\d+\.\d+\.\d+\.\d+)$/);
  return mapped?.[1] ?? null;
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

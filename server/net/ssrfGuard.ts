/**
 * 共享 SSRF 守卫（P0-4 真源）。
 *
 * 设计（对标 Parassharmaa/agent-fetch 思想，不依赖其 npm 包）：
 *  - DNS 预解析 pin IP：主机名逐跳 lookup(all:true)，全部记录必须为公网；
 *  - 编码 IP 归一化：%编码/十进制/八进制/十六进制/混合 IPv4、::ffff: 映射全部归一后再分类；
 *  - 重定向逐跳重验：调用方每跳都调 assert*，守卫本身无状态；
 *  - body/速率/超时由调用方配额执行，本模块只给常量建议值。
 *
 * owner：server/net/ssrfGuard.ts；webFetch / fileDownload / modelProxy 统一消费，
 * 禁止各自私造字符串判断。
 */

import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

export const SSRF_DEFAULT_MAX_REDIRECTS = 5;
export const SSRF_DEFAULT_TIMEOUT_MS = 12_000;
export const SSRF_DEFAULT_MAX_BYTES = 1 * 1024 * 1024;

export type PrivateHostRule = { hostname: string; port?: string };

export function normalizeHostname(hostname: string): string {
  return hostname.replace(/^\[|\]$/g, "").replace(/\.$/, "").toLowerCase();
}

/** %编码解码（容错：失败则原文返回）。 */
function percentDecode(host: string): string {
  try {
    return decodeURIComponent(host);
  } catch {
    return host;
  }
}

/** 单段 IPv4 数字：十进制 / 0开头八进制 / 0x开头十六进制。 */
function parseIpv4Segment(seg: string): number | null {
  const s = seg.trim().toLowerCase();
  if (!s) return null;
  let radix = 10;
  let digits = s;
  if (s.startsWith("0x")) {
    radix = 16;
    digits = s.slice(2);
  } else if (/^0[0-7]+$/.test(s) && s.length > 1) {
    radix = 8;
    digits = s;
  } else if (!/^\d+$/.test(s)) {
    return null;
  }
  const n = Number.parseInt(digits, radix);
  if (!Number.isInteger(n) || n < 0 || n > 255) return null;
  return n;
}

/**
 * 归一化编码 IP：
 *  - 2130706433（纯十进制大整数）→ 127.0.0.1
 *  - 0x7f.0.0.1 / 0177.0.0.1 / 0x7f000001 → 点分十进制
 *  - 其余返回小写去括号形式
 */
export function normalizeEncodedIp(host: string): string {
  const decoded = percentDecode(host.trim());
  const noBrackets = decoded.replace(/^\[|\]$/g, "").replace(/\.$/, "");
  // 纯大整数 IPv4
  if (/^\d+$/.test(noBrackets)) {
    try {
      const n = BigInt(noBrackets);
      if (n >= 0n && n <= 4294967295n) {
        const v = Number(n);
        return `${(v >>> 24) & 255}.${(v >>> 16) & 255}.${(v >>> 8) & 255}.${v & 255}`;
      }
    } catch {
      // fallthrough
    }
  }
  // 0x 开头整体十六进制
  if (/^0x[0-9a-f]+$/i.test(noBrackets)) {
    try {
      const n = Number.parseInt(noBrackets, 16);
      if (Number.isInteger(n) && n >= 0 && n <= 0xffffffff) {
        return `${(n >>> 24) & 255}.${(n >>> 16) & 255}.${(n >>> 8) & 255}.${n & 255}`;
      }
    } catch {
      // fallthrough
    }
  }
  const parts = noBrackets.split(".");
  if (parts.length === 4) {
    const octets: number[] = [];
    for (const p of parts) {
      const v = parseIpv4Segment(p);
      if (v === null) return noBrackets.toLowerCase();
      octets.push(v);
    }
    return octets.join(".");
  }
  return noBrackets.toLowerCase();
}

export function parseIpv4(value: string): [number, number, number, number] | null {
  const parts = value.split(".");
  if (parts.length !== 4) return null;
  const octets = parts.map((p) => Number.parseInt(p, 10));
  if (
    octets.some(
      (o, i) =>
        !Number.isInteger(o) || o < 0 || o > 255 || String(o) !== parts[i]
    )
  ) {
    return null;
  }
  return octets as [number, number, number, number];
}

function parseMappedIpv4(value: string): string | null {
  const m = value.toLowerCase().match(/^(?:0:0:0:0:0:ffff:|::ffff:)(\d+\.\d+\.\d+\.\d+)$/);
  return m?.[1] ?? null;
}

/** 公网分类：返回阻断原因，null = 公网放行。 */
export function classifyBlockedIp(value: string): string | null {
  const normalized = normalizeEncodedIp(normalizeHostname(value));
  const ipv4 = parseIpv4(normalized);
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
  if (!isIP(normalized)) return null;
  if (normalized === "::" || normalized === "::1" || normalized === "0:0:0:0:0:0:0:1") {
    return "IPv6 回环或未指定地址";
  }
  if (normalized.startsWith("fe80:")) return "IPv6 链路本地地址";
  if (/^f[cd][0-9a-f]{2}:/i.test(normalized)) return "IPv6 唯一本地地址";
  const mapped = parseMappedIpv4(normalized);
  return mapped ? classifyBlockedIp(mapped) : null;
}

export function classifyBlockedHostname(hostname: string): string | null {
  const normalized = normalizeEncodedIp(normalizeHostname(hostname));
  if (!normalized) return "空主机名";
  if (normalized === "localhost" || normalized.endsWith(".localhost")) {
    return "localhost 回环地址";
  }
  if (
    normalized.endsWith(".local") ||
    normalized.endsWith(".lan") ||
    normalized.endsWith(".internal") ||
    normalized.endsWith(".home.arpa")
  ) {
    return "本地域名或内网域名";
  }
  if (!normalized.includes(".") && !normalized.includes(":")) {
    return "单标签主机名，通常指向内网设备";
  }
  return classifyBlockedIp(normalized);
}

export function readPrivateHostAllowlist(envName: string): PrivateHostRule[] {
  const raw = process.env[envName]?.trim();
  if (!raw) return [];
  const rules: PrivateHostRule[] = [];
  for (const entry of raw.split(/[\s,;]+/)) {
    const trimmed = entry.trim();
    if (!trimmed || trimmed.includes("*")) continue;
    if (/^https?:\/\//i.test(trimmed)) {
      try {
        const parsed = new URL(trimmed);
        rules.push({
          hostname: normalizeEncodedIp(normalizeHostname(parsed.hostname)),
          port: parsed.port || (parsed.protocol === "https:" ? "443" : "80")
        });
      } catch {
        // ignore
      }
      continue;
    }
    const sep = trimmed.lastIndexOf(":");
    if (sep >= 0 && trimmed.indexOf(":") === sep) {
      const h = normalizeEncodedIp(normalizeHostname(trimmed.slice(0, sep)));
      const portText = trimmed.slice(sep + 1);
      const port = /^\d+$/.test(portText) ? portText : undefined;
      if (h) rules.push({ hostname: h, port });
      continue;
    }
    rules.push({ hostname: normalizeEncodedIp(normalizeHostname(trimmed)) });
  }
  return rules;
}

export function isPrivateHostAllowed(
  parsed: URL,
  allowlist: PrivateHostRule[]
): boolean {
  if (!allowlist.length) return false;
  const hostname = normalizeEncodedIp(normalizeHostname(parsed.hostname));
  const port = parsed.port || (parsed.protocol === "https:" ? "443" : "80");
  return allowlist.some(
    (rule) => rule.hostname === hostname && (!rule.port || rule.port === port)
  );
}

export type SsrfCheckError = Error & { ssrfCode: string; details?: Record<string, unknown> };

export function ssrfError(
  code: "INVALID_REQUEST" | "PRIVATE_NETWORK_URL" | "DNS_LOOKUP_FAILED",
  message: string,
  details?: Record<string, unknown>
): SsrfCheckError {
  return Object.assign(new Error(message), { ssrfCode: code, details });
}

/** DNS pin：主机名全部解析记录必须为公网，否则抛阻断错误。 */
export async function assertHostnameResolvesPublic(hostname: string): Promise<void> {
  const normalized = normalizeEncodedIp(normalizeHostname(hostname));
  let records: Array<{ address: string }>;
  try {
    records = await lookup(normalized, { all: true, verbatim: true });
  } catch {
    throw ssrfError("DNS_LOOKUP_FAILED", `无法解析主机：${normalized}`, {
      host: normalized
    });
  }
  if (!records.length) {
    throw ssrfError("DNS_LOOKUP_FAILED", `主机无解析结果：${normalized}`, {
      host: normalized
    });
  }
  for (const record of records) {
    const reason = classifyBlockedIp(record.address);
    if (reason) {
      throw ssrfError("PRIVATE_NETWORK_URL", `拒绝访问解析到内网的地址：${normalized}`, {
        host: normalized,
        reason: `${reason}（DNS：${record.address}）`
      });
    }
  }
}

export type PublicUrlOptions = {
  /** 允许 http（默认仅 https）。 */
  allowHttp?: boolean;
  /** 私网 allowlist 环境变量名或已解析规则。 */
  allowlist?: PrivateHostRule[];
};

/**
 * 逐跳校验 URL：协议 → 归一化 → allowlist → 字面 IP 分类 → DNS pin。
 * 调用方重定向每跳都必须调一次。
 */
export async function assertPublicUrl(
  urlText: string,
  options: PublicUrlOptions = {}
): Promise<URL> {
  let parsed: URL;
  try {
    parsed = new URL(urlText.trim());
  } catch {
    throw ssrfError("INVALID_REQUEST", `非法 URL：${urlText}`);
  }
  const allowHttp = options.allowHttp ?? false;
  if (parsed.protocol !== "https:" && !(allowHttp && parsed.protocol === "http:")) {
    throw ssrfError("INVALID_REQUEST", `仅允许 ${allowHttp ? "http/https" : "https"}：${urlText}`);
  }
  const hostname = normalizeEncodedIp(normalizeHostname(parsed.hostname));
  const allowlist = options.allowlist ?? [];
  if (isPrivateHostAllowed(parsed, allowlist)) return parsed;
  const hostReason = classifyBlockedHostname(hostname);
  if (hostReason) {
    throw ssrfError("PRIVATE_NETWORK_URL", `拒绝访问本地或私有网络地址：${hostname}`, {
      host: hostname,
      reason: hostReason
    });
  }
  if (!isIP(hostname)) {
    await assertHostnameResolvesPublic(hostname);
  }
  return parsed;
}

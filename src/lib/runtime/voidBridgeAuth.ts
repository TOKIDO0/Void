import { isTauriRuntime } from "./voidBridgeRuntime";

export const BRIDGE_TOKEN_HEADER_NAME = "X-VOID-Bridge-Token";

let cachedBridgeToken: string | null | undefined;
let pendingBridgeToken: Promise<string | null> | null = null;

function readNodeBridgeToken(): string | null {
  const env = (globalThis as {
    process?: { env?: Record<string, string | undefined> };
  }).process?.env;
  const token = env?.VOID_BRIDGE_TOKEN?.trim();
  return token ? token : null;
}

async function readTauriBridgeToken(): Promise<string | null> {
  const { invoke } = await import("@tauri-apps/api/core");
  const token = await invoke<string>("get_bridge_token");
  const trimmedToken = token.trim();
  return trimmedToken ? trimmedToken : null;
}

async function resolveBridgeToken(): Promise<string | null> {
  if (cachedBridgeToken !== undefined) {
    return cachedBridgeToken;
  }

  const nodeToken = readNodeBridgeToken();
  if (nodeToken) {
    cachedBridgeToken = nodeToken;
    return cachedBridgeToken;
  }

  if (!isTauriRuntime()) {
    cachedBridgeToken = null;
    return cachedBridgeToken;
  }

  if (!pendingBridgeToken) {
    pendingBridgeToken = readTauriBridgeToken().catch(() => null);
  }
  cachedBridgeToken = await pendingBridgeToken;
  pendingBridgeToken = null;
  return cachedBridgeToken;
}

/**
 * 本机 bridge 认证头。
 *
 * release Tauri 由 Rust 生成随机 token 并注入 sidecar；开发态没有 token 时返回空对象，
 * 保持现有 dev:all / smoke 脚本可用。调用方必须只把它合并到本机 bridge 请求里。
 */
export async function bridgeAuthHeaders(): Promise<Record<string, string>> {
  const token = await resolveBridgeToken();
  return token ? { [BRIDGE_TOKEN_HEADER_NAME]: token } : {};
}

export function isLoopbackBridgeUrl(urlText: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(urlText);
  } catch {
    return false;
  }

  const hostname = parsed.hostname
    .replace(/^\[|\]$/g, "")
    .replace(/\.$/, "")
    .toLowerCase();
  return hostname === "127.0.0.1" || hostname === "localhost" || hostname === "::1";
}

/**
 * 只给本机回环 bridge 请求附带 token。
 *
 * 即使某个调用方或联调环境误把 bridge origin 配到远端地址，也不会把本机
 * X-VOID-Bridge-Token 发出本机边界。
 */
export async function bridgeAuthHeadersForUrl(urlText: string): Promise<Record<string, string>> {
  if (!isLoopbackBridgeUrl(urlText)) {
    return {};
  }
  return bridgeAuthHeaders();
}

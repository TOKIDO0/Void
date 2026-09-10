import { randomBytes, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";

export const BRIDGE_TOKEN_HEADER = "x-void-bridge-token";

/**
 * P0-1 鉴权下沉：dev 不再允许空 token 裸奔。
 * - 已配置 VOID_BRIDGE_TOKEN：直接使用；
 * - 未配置 + 显式 VOID_ALLOW_EMPTY_BRIDGE_TOKEN=1（smoke/联调隔离）：允许空（isRequired=false）；
 * - 未配置 + 开发态（NODE_ENV!=production）：自动生成一次性 token 并注入 process.env，
 *   使 isRequired=true，bridge/代理层统一走 token 校验；
 * - 未配置 + 生产态：保持空，要求调用方 fail-closed（server 启动时应显式报错，见 ensureBridgeTokenOrThrow）。
 */
let devTokenLogged = false;

export function ensureBridgeTokenInitialized(): string {
  const configured = process.env.VOID_BRIDGE_TOKEN?.trim() ?? "";
  if (configured) return configured;
  if (process.env.VOID_ALLOW_EMPTY_BRIDGE_TOKEN === "1") return "";
  if (process.env.NODE_ENV === "production") return "";
  const generated = randomBytes(32).toString("hex");
  process.env.VOID_BRIDGE_TOKEN = generated;
  if (!devTokenLogged) {
    devTokenLogged = true;
    console.log("[void-bridge] dev token auto-generated (ephemeral, process-only)");
  }
  return generated;
}

export function readConfiguredBridgeToken(): string {
  const direct = process.env.VOID_BRIDGE_TOKEN?.trim() ?? "";
  if (direct) return direct;
  // dev 自动生成：避免空 token 裸奔；测试隔离显式 allow-empty 则保持空。
  if (process.env.VOID_ALLOW_EMPTY_BRIDGE_TOKEN === "1") return "";
  if (process.env.NODE_ENV === "production") return "";
  return ensureBridgeTokenInitialized();
}

export function isBridgeTokenRequired(): boolean {
  return readConfiguredBridgeToken().length > 0;
}

export function isBridgeTokenAccepted(request: IncomingMessage): boolean {
  const expected = readConfiguredBridgeToken();
  if (!expected) {
    return true;
  }

  const provided = request.headers[BRIDGE_TOKEN_HEADER];
  if (Array.isArray(provided) || typeof provided !== "string") {
    return false;
  }

  const expectedBuffer = Buffer.from(expected, "utf8");
  const providedBuffer = Buffer.from(provided.trim(), "utf8");
  if (expectedBuffer.length !== providedBuffer.length) {
    return false;
  }
  return timingSafeEqual(expectedBuffer, providedBuffer);
}

export function sendBridgeAuthReject(response: ServerResponse): void {
  response.statusCode = 403;
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  response.end(JSON.stringify({
    ok: false,
    error: {
      code: "BRIDGE_TOKEN_FORBIDDEN",
      message: "本地 bridge token 缺失或无效"
    }
  }));
}

/** vite dev 同源形态：回环 Host + 无 Origin 或 allowlist Origin。 */
const DEV_SAME_ORIGIN_ALLOWLIST = new Set([
  "http://localhost:5173",
  "tauri://localhost",
  "http://tauri.localhost"
]);

export function isLoopbackHostHeader(hostHeader: string | string[] | undefined): boolean {
  if (!hostHeader || Array.isArray(hostHeader)) return false;
  const normalized = hostHeader.trim().toLowerCase();
  return (
    normalized.startsWith("127.0.0.1") ||
    normalized.startsWith("localhost") ||
    normalized.startsWith("[::1]")
  );
}

export function isAllowedDevOrigin(origin: string | string[] | undefined): boolean {
  if (!origin || Array.isArray(origin)) return true;
  return DEV_SAME_ORIGIN_ALLOWLIST.has(origin);
}

/**
 * 仅供 vite dev 中间件（同进程）调用：先验 Host/Origin，恶意 Origin 直接返回 false
 * （调用方回 403）；同源 dev 缺 token 时内部补齐 dev token，再进 handleModelProxy 的
 * 统一 token 校验。bridge 进程永不调用此函数，严格要求 token。
 */
export function attachDevTokenForSameOrigin(request: IncomingMessage): boolean {
  if (!isLoopbackHostHeader(request.headers.host)) return false;
  const origin = request.headers.origin;
  if (typeof origin === "string" && !DEV_SAME_ORIGIN_ALLOWLIST.has(origin)) {
    return false;
  }
  const expected = readConfiguredBridgeToken();
  if (!expected) return true;
  const provided = request.headers[BRIDGE_TOKEN_HEADER];
  if (typeof provided === "string" && provided.trim()) return true;
  request.headers[BRIDGE_TOKEN_HEADER] = expected;
  return true;
}

import { randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, normalize } from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import { resolveRuntimeRoot } from "../file/fileRuntimePaths";

export const BRIDGE_TOKEN_HEADER = "x-void-bridge-token";
// 头名互通说明：服务端用全小写 x-void-bridge-token；Node 收包自动小写请求头，
// 前端发 X-VOID-Bridge-Token 经 HTTP 语义等价互通，不用改名。

/**
 * P0-1 鉴权下沉：dev 不再允许空 token 裸奔。
 * - 已配置 VOID_BRIDGE_TOKEN：直接使用；
 * - 未配置 + 显式 VOID_ALLOW_EMPTY_BRIDGE_TOKEN=1（smoke/联调隔离）：允许空（isRequired=false）；
 * - 未配置 + 开发态（NODE_ENV!=production）：自动生成一次性 token 并注入 process.env，
 *   使 isRequired=true，bridge/代理层统一走 token 校验；
 * - 未配置 + 生产态：保持空，要求调用方 fail-closed（server 启动时应显式报错，见 ensureBridgeTokenOrThrow）。
 */
let devTokenLogged = false;

const DEV_TOKEN_FILENAME = ".bridge-token";

/**
 * dev token 共享文件路径（单一真源，与 Rust debug 回退同约定）。
 * 优先级：VOID_BRIDGE_TOKEN_FILE > VOID_RUNTIME_DIR > VOID_RUNTIME_ROOT > 默认 D 盘运行时目录。
 * Rust 侧（src-tauri/src/lib.rs debug resolve_bridge_token）按同一优先级读取，release 不读文件。
 */
export function resolveDevBridgeTokenFilePath(): string {
  const direct = process.env.VOID_BRIDGE_TOKEN_FILE?.trim();
  if (direct) return normalize(direct);
  const runtimeDir = process.env.VOID_RUNTIME_DIR?.trim()
    || process.env.VOID_RUNTIME_ROOT?.trim()
    || resolveRuntimeRoot();
  return join(normalize(runtimeDir), DEV_TOKEN_FILENAME);
}

/** 读共享文件 token：无文件/空/格式非法一律视同缺失（调用方给诚实错误，不抛）。 */
export function readDevSharedBridgeToken(): string {
  let raw: string;
  try {
    raw = readFileSync(resolveDevBridgeTokenFilePath(), "utf8");
  } catch {
    return "";
  }
  const token = raw.trim();
  // dev 生成 hex(64) / release 侧 base64url 均放行；拒绝空、换行夹带、超长垃圾防投毒。
  if (!/^[\w\-+/=.]{16,512}$/.test(token)) return "";
  return token;
}

/**
 * 原子持久化 dev token：已存在有效文件则直接复用（双进程竞写时后来者认输），
 * 用 wx 独占创建避免覆盖；失败一律 best-effort（返回内存 token，不抛）。
 */
function persistDevBridgeTokenBestEffort(token: string): string {
  const target = resolveDevBridgeTokenFilePath();
  const existing = readDevSharedBridgeToken();
  if (existing) return existing;
  try {
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, `${token}\n`, { flag: "wx", mode: 0o600 });
    return token;
  } catch (error) {
    // EEXIST：竞写输了，读赢家的。
    if ((error as NodeJS.ErrnoException)?.code === "EEXIST") {
      return readDevSharedBridgeToken() || token;
    }
    // 落盘失败（如只读目录）：保持内存 token 可用，不阻断 dev。
    try {
      if (!existsSync(target)) return token;
    } catch { /* best-effort */ }
    return readDevSharedBridgeToken() || token;
  }
}

export function ensureBridgeTokenInitialized(): string {
  const configured = process.env.VOID_BRIDGE_TOKEN?.trim() ?? "";
  if (configured) return configured;
  if (process.env.VOID_ALLOW_EMPTY_BRIDGE_TOKEN === "1") return "";
  if (process.env.NODE_ENV === "production") return "";
  // dev 单一真源：优先复用共享文件（bridge/vite 谁先起谁落地，后起复用），无文件才生成并原子写入。
  const shared = readDevSharedBridgeToken();
  if (shared) {
    process.env.VOID_BRIDGE_TOKEN = shared;
    return shared;
  }
  const generated = randomBytes(32).toString("hex");
  const settled = persistDevBridgeTokenBestEffort(generated);
  process.env.VOID_BRIDGE_TOKEN = settled;
  if (!devTokenLogged) {
    devTokenLogged = true;
    console.log("[void-bridge] dev token ready (shared file, all dev processes converge)");
  }
  return settled;
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

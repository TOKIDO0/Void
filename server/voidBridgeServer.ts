/**
 * VOID 桥接 sidecar 服务入口。
 *
 * 生产环境没有 vite dev，因此文本模型请求仍由该进程负责跨域与流式转发。
 * 豆包 STT/TTS 已迁移至托管 Cloudflare Worker，不再经过本地 sidecar。
 * 阶段 C：浏览器只读自动化（Playwright）也挂在本进程，前端经工具契约 HTTP 调用。
 *
 * 监听：默认 127.0.0.1:17872（仅回环，不对外暴露）。端口可由环境变量 VOID_BRIDGE_PORT 覆盖。
 * 挂载：
 *   HTTP /void-model-proxy → 模型接口转发（SSE 流式）
 *   HTTP /void-browser/*   → Playwright 只读浏览器工具
 *   HTTP /void-file/*      → 阶段 D 下载/落盘/校验
 *   HTTP /void-software/*  → 官方软件安装包解析与安全下载
 *   HTTP /void-desktop/*   → 剪贴板 read/write + 资源管理器 revealPath
 *   HTTP /void-memory/*    → 记忆本地 Embedding（句向量编码，供语义召回）
 */
import { createServer } from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import { networkInterfaces } from "node:os";
import {
  BRIDGE_TOKEN_HEADER,
  isBridgeTokenAccepted,
  isBridgeTokenRequired,
  sendBridgeAuthReject
} from "./bridge/bridgeAuth";
import { browserSessionManager } from "./browser/browserSessionManager";
import { handleBrowserHttpRequest } from "./browser/browserHttpHandlers";
import { handleDesktopHttpRequest } from "./desktop/desktopHttpHandlers";
import { handleFileHttpRequest } from "./file/fileHttpHandlers";
import { ensureRuntimeDirectories } from "./file/fileRuntimePaths";
import { handleCodeHttpRequest } from "./code/codeHttpHandlers";
import { handleMemoryHttpRequest } from "./memory/memoryEmbeddingHandlers";
import { handleSkillsHttpRequest } from "./skills/skillsHttpHandlers";
import { handleSoftwareHttpRequest } from "./software/softwareHttpHandlers";
import { getProxyRuntimeStatus, handleModelProxy } from "./voidProxyMiddleware";

// 默认端口：固定回环端口，前端在 Tauri 环境下直连此端口。
const DEFAULT_BRIDGE_PORT = 17872;
const BRIDGE_HOST = "127.0.0.1";
let activeBridgePort = DEFAULT_BRIDGE_PORT;
let activeBridgeHost = BRIDGE_HOST;

export type VoidBridgeServerOptions = {
  port?: number;
  host?: string;
  exitOnError?: boolean;
  installSignalHandlers?: boolean;
};

export type VoidBridgeServerHandle = {
  server: Server;
  host: string;
  port: number;
  origin: string;
  close: () => Promise<void>;
};

const ALLOWED_ORIGINS = new Set([
  "http://localhost:5173",
  "tauri://localhost",
  "http://tauri.localhost"
]);

// 允许携带的自定义请求头（与转发白名单一致，供 CORS 预检放行）。
const CORS_ALLOWED_HEADERS = [
  "content-type",
  "authorization",
  "x-void-target-url",
  BRIDGE_TOKEN_HEADER,
  "anthropic-version"
].join(", ");

const ALLOWED_HOSTNAMES = new Set(["127.0.0.1", "localhost", "::1"]);
const ALLOWED_LISTEN_HOSTS = new Set(["127.0.0.1", "localhost", "::1"]);

function resolvePort(overridePort?: number): number {
  if (Number.isInteger(overridePort) && overridePort >= 0 && overridePort < 65536) {
    return overridePort;
  }

  const fromEnv = process.env.VOID_BRIDGE_PORT;
  if (fromEnv) {
    const parsed = Number.parseInt(fromEnv, 10);
    if (Number.isInteger(parsed) && parsed > 0 && parsed < 65536) {
      return parsed;
    }
  }
  return DEFAULT_BRIDGE_PORT;
}

function resolveListenHost(overrideHost?: string): string {
  const requestedHost = (overrideHost ?? BRIDGE_HOST).trim();
  const normalizedHost = requestedHost.replace(/^\[|\]$/g, "").toLowerCase();
  if (!ALLOWED_LISTEN_HOSTS.has(normalizedHost)) {
    throw new Error(
      `VOID bridge 只允许监听本机回环地址，拒绝监听：${requestedHost || "(空)"}`
    );
  }
  return normalizedHost;
}

function formatListenOrigin(host: string, port: number): string {
  return host === "::1"
    ? `http://[::1]:${port}`
    : `http://${host}:${port}`;
}

/**
 * Tauri WebView 前端与 sidecar 端口不同源，跨源 fetch 会触发 CORS 预检。
 * 此处对回环请求放行本应用所需的方法与头；不使用通配符凭证，仅服务本地。
 */
function applyCorsHeaders(response: ServerResponse, origin: string): void {
  response.setHeader("Access-Control-Allow-Origin", origin);
  response.setHeader("Vary", "Origin");
  response.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  response.setHeader("Access-Control-Allow-Headers", CORS_ALLOWED_HEADERS);
  response.setHeader("Access-Control-Max-Age", "86400");
}

function applySecurityHeaders(response: ServerResponse): void {
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.setHeader("Cache-Control", "no-store");
  response.setHeader("Referrer-Policy", "no-referrer");
}

function sendSecurityReject(
  response: ServerResponse,
  code: "HOST_FORBIDDEN" | "ORIGIN_FORBIDDEN",
  message: string
): void {
  applySecurityHeaders(response);
  response.statusCode = 403;
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  response.end(JSON.stringify({ ok: false, error: { code, message } }));
}

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  response.statusCode = status;
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  response.end(JSON.stringify(body));
}

/**
 * Host 头必须指向回环主机，防止 DNS rebinding 或伪 Host 把本地工具桥暴露给网页。
 * 端口存在时也必须等于当前 bridge 端口；无端口的 HTTP/1.0 风格请求仅允许回环主机。
 */
function isAllowedHostHeader(hostHeader: string | undefined): boolean {
  if (!hostHeader || Array.isArray(hostHeader)) {
    return false;
  }

  const normalized = hostHeader.trim().toLowerCase();
  if (!normalized) {
    return false;
  }

  let hostname = normalized;
  let portText = "";

  if (normalized.startsWith("[")) {
    const closeIndex = normalized.indexOf("]");
    if (closeIndex < 0) {
      return false;
    }
    hostname = normalized.slice(1, closeIndex);
    portText = normalized.slice(closeIndex + 1).replace(/^:/, "");
  } else {
    const separatorIndex = normalized.lastIndexOf(":");
    if (separatorIndex >= 0 && normalized.indexOf(":") === separatorIndex) {
      hostname = normalized.slice(0, separatorIndex);
      portText = normalized.slice(separatorIndex + 1);
    }
  }

  if (!ALLOWED_HOSTNAMES.has(hostname)) {
    return false;
  }
  if (!portText) {
    return true;
  }
  const port = Number.parseInt(portText, 10);
  return Number.isInteger(port) && port === activeBridgePort;
}

type NetworkAddressScope =
  | "loopback"
  | "private"
  | "linkLocal"
  | "uniqueLocal"
  | "public"
  | "other";

type SecurityCheck = {
  id: string;
  ok: boolean;
  severity: "info" | "warning" | "danger";
  message: string;
};

function classifyNetworkAddress(address: string, family: string | number, internal?: boolean): NetworkAddressScope {
  if (internal) {
    return "loopback";
  }

  const normalizedFamily = typeof family === "number"
    ? family === 4 ? "IPv4" : family === 6 ? "IPv6" : "unknown"
    : family;

  if (normalizedFamily === "IPv4") {
    const parts = address.split(".").map((part) => Number.parseInt(part, 10));
    if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) {
      return "other";
    }
    const [first, second] = parts;
    if (first === 127) {
      return "loopback";
    }
    if (first === 10 || (first === 172 && second >= 16 && second <= 31) || (first === 192 && second === 168)) {
      return "private";
    }
    if (first === 169 && second === 254) {
      return "linkLocal";
    }
    if (first === 100 && second >= 64 && second <= 127) {
      return "private";
    }
    return "public";
  }

  if (normalizedFamily === "IPv6") {
    const normalizedAddress = address.split("%")[0].toLowerCase();
    if (normalizedAddress === "::1") {
      return "loopback";
    }
    if (normalizedAddress.startsWith("fe80:")) {
      return "linkLocal";
    }
    if (normalizedAddress.startsWith("fc") || normalizedAddress.startsWith("fd")) {
      return "uniqueLocal";
    }
    return "public";
  }

  return "other";
}

function summarizeNetworkInterfaces() {
  const interfaces = networkInterfaces();
  const addressCounts: Record<NetworkAddressScope, number> = {
    loopback: 0,
    private: 0,
    linkLocal: 0,
    uniqueLocal: 0,
    public: 0,
    other: 0
  };
  let interfaceCount = 0;

  for (const entries of Object.values(interfaces)) {
    if (!entries?.length) {
      continue;
    }
    interfaceCount += 1;
    for (const entry of entries) {
      const scope = classifyNetworkAddress(entry.address, entry.family, entry.internal);
      addressCounts[scope] += 1;
    }
  }

  return {
    interfaceCount,
    nonLoopbackAddressCount:
      addressCounts.private
      + addressCounts.linkLocal
      + addressCounts.uniqueLocal
      + addressCounts.public
      + addressCounts.other,
    addressCounts
  };
}

function buildSecurityCheck(
  id: string,
  ok: boolean,
  severity: SecurityCheck["severity"],
  passMessage: string,
  failMessage: string
): SecurityCheck {
  return {
    id,
    ok,
    severity: ok ? "info" : severity,
    message: ok ? passMessage : failMessage
  };
}

function buildBridgeSecurityStatus() {
  const listenIsLoopback = ALLOWED_LISTEN_HOSTS.has(activeBridgeHost);
  const tokenRequired = isBridgeTokenRequired();
  const proxy = getProxyRuntimeStatus();
  const browser = browserSessionManager.getRuntimeStatus();
  const network = summarizeNetworkInterfaces();

  const checks: SecurityCheck[] = [
    buildSecurityCheck(
      "bridge.listenLoopback",
      listenIsLoopback,
      "danger",
      "bridge 当前只监听本机回环地址",
      "bridge 当前监听地址不是回环地址，请立即停止并检查配置"
    ),
    buildSecurityCheck(
      "bridge.tokenRequired",
      tokenRequired,
      "warning",
      "bridge token 已启用，非 OPTIONS 请求需要认证头",
      "当前未启用 bridge token；开发模式可兼容，release 应启用随机 token"
    ),
    buildSecurityCheck(
      "bridge.corsAllowlist",
      !ALLOWED_ORIGINS.has("*"),
      "danger",
      "CORS 使用精确 allowlist，未使用通配符",
      "CORS 出现通配符 Origin，可能暴露本地 bridge"
    ),
    buildSecurityCheck(
      "proxy.bodyLimit",
      proxy.requestBodyMaxBytes <= 4 * 1024 * 1024,
      "warning",
      "模型/语音代理请求体上限处于保守范围",
      "模型/语音代理请求体上限偏大，可能导致本地内存占用过高"
    ),
    buildSecurityCheck(
      "proxy.concurrencyLimit",
      proxy.maxConcurrentRequests <= 16,
      "warning",
      "模型/语音代理并发上限处于保守范围",
      "模型/语音代理并发上限偏大，可能导致本地连接或内存占用过高"
    ),
    buildSecurityCheck(
      "browser.sessionLimit",
      browser.maxSessions <= 8,
      "warning",
      "浏览器任务会话上限处于保守范围",
      "浏览器任务会话上限偏大，可能导致浏览器资源占用过高"
    )
  ];
  const overall = checks.some((check) => !check.ok && check.severity === "danger")
    ? "unsafe"
    : checks.some((check) => !check.ok)
      ? "attention"
      : "healthy";

  return {
    status: "ok",
    overall,
    inspectedAt: Date.now(),
    bridge: {
      host: activeBridgeHost,
      port: activeBridgePort,
      origin: formatListenOrigin(activeBridgeHost, activeBridgePort),
      listenIsLoopback,
      tokenRequired,
      allowedOrigins: [...ALLOWED_ORIGINS],
      allowedListenHosts: [...ALLOWED_LISTEN_HOSTS],
      allowedHostnames: [...ALLOWED_HOSTNAMES],
      securityHeaders: [
        "X-Content-Type-Options",
        "Cache-Control",
        "Referrer-Policy"
      ],
      timeouts: {
        headersTimeoutMs: 15_000,
        requestTimeoutMs: 120_000,
        keepAliveTimeoutMs: 5_000,
        maxHeadersCount: 64
      }
    },
    proxy,
    browser,
    network,
    checks
  };
}

function handleHttpRequest(request: IncomingMessage, response: ServerResponse): void {
  applySecurityHeaders(response);

  if (!isAllowedHostHeader(request.headers.host)) {
    sendSecurityReject(
      response,
      "HOST_FORBIDDEN",
      "请求 Host 不在本地回环允许列表内"
    );
    return;
  }

  const origin = request.headers.origin;
  if (origin && !ALLOWED_ORIGINS.has(origin)) {
    sendSecurityReject(response, "ORIGIN_FORBIDDEN", "请求 Origin 不在允许列表内");
    return;
  }

  if (origin) {
    applyCorsHeaders(response, origin);
  }

  // 预检请求直接放行
  if (request.method === "OPTIONS") {
    response.statusCode = 204;
    response.end();
    return;
  }

  if (!isBridgeTokenAccepted(request)) {
    sendBridgeAuthReject(response);
    return;
  }

  const pathname = (request.url ?? "").split("?")[0];

  if (pathname === "/void-model-proxy") {
    void handleModelProxy(request, response);
    return;
  }

  // 阶段 C：浏览器只读自动化
  if (pathname.startsWith("/void-browser")) {
    void handleBrowserHttpRequest(request, response, pathname);
    return;
  }

  // 阶段 D：下载到临时目录 / 确认后落盘 / 校验
  if (pathname.startsWith("/void-file")) {
    void handleFileHttpRequest(request, response, pathname);
    return;
  }

  // 官方软件安装包：解析 + 安全下载（通用目录，非双软件专线）
  if (pathname.startsWith("/void-software")) {
    void handleSoftwareHttpRequest(request, response, pathname);
    return;
  }

  // Q4：桌面剪贴板
  if (pathname.startsWith("/void-desktop")) {
    void handleDesktopHttpRequest(request, response, pathname);
    return;
  }

  // P2：受限代码执行（JS/Python 沙箱）
  if (pathname.startsWith("/void-code")) {
    void handleCodeHttpRequest(request, response, pathname);
    return;
  }

  // M4：记忆本地 Embedding（句向量编码，供前端语义召回融合）
  if (pathname.startsWith("/void-memory")) {
    void handleMemoryHttpRequest(request, response, pathname);
    return;
  }

  // 41 号文档：本地技能注册表（只读任务剧本列表）
  if (pathname.startsWith("/void-skills")) {
    handleSkillsHttpRequest(request, response, pathname);
    return;
  }

  // 健康检查：供 Tauri 后端确认 sidecar 已就绪
  if (pathname === "/void-bridge/health") {
    response.statusCode = 200;
    response.setHeader("Content-Type", "application/json");
    response.end(
      JSON.stringify({
        status: "ok",
        tokenRequired: isBridgeTokenRequired(),
        browserReady: browserSessionManager.isBrowserReady(),
        activeBrowserSessions: browserSessionManager.listActiveTaskIds().length
      })
    );
    return;
  }

  if (pathname === "/void-bridge/security-status") {
    sendJson(response, 200, { ok: true, data: buildBridgeSecurityStatus() });
    return;
  }

  response.statusCode = 404;
  response.end("Not found");
}

export function startBridgeServer(options: VoidBridgeServerOptions = {}): Promise<VoidBridgeServerHandle> {
  ensureRuntimeDirectories();
  const port = resolvePort(options.port);
  const host = resolveListenHost(options.host);
  activeBridgeHost = host;
  activeBridgePort = port;
  const httpServer = createServer(handleHttpRequest);
  httpServer.headersTimeout = 15_000;
  httpServer.requestTimeout = 120_000;
  httpServer.keepAliveTimeout = 5_000;
  httpServer.maxHeadersCount = 64;

  let shutdownStarted = false;
  const close = async () => {
    if (shutdownStarted) {
      return;
    }
    shutdownStarted = true;
    await browserSessionManager.dispose();
    await new Promise<void>((resolve, reject) => {
      httpServer.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
    });
  };

  if (options.exitOnError) {
    httpServer.on("error", (error) => {
      console.error("[void-bridge] server error", error);
      process.exit(1);
    });
  }

  if (options.installSignalHandlers) {
    // 收到终止信号时优雅退出（Tauri 回收 sidecar 时发送）。
    const shutdown = () => {
      void close().finally(() => process.exit(0));
    };
    process.on("SIGTERM", shutdown);
    process.on("SIGINT", shutdown);
  }

  return new Promise((resolve, reject) => {
    httpServer.once("error", reject);
    httpServer.listen(port, host, () => {
      httpServer.off("error", reject);
      const address = httpServer.address();
      const actualPort = typeof address === "object" && address ? address.port : port;
      activeBridgePort = actualPort;
      // 该行是 Tauri 后端判断 sidecar 就绪的约定标记，勿改格式。
      console.log(`[void-bridge] listening on ${formatListenOrigin(host, actualPort)}`);
      resolve({
        server: httpServer,
        host,
        port: actualPort,
        origin: formatListenOrigin(host, actualPort),
        close
      });
    });
  });
}

if (process.env.VOID_BRIDGE_DISABLE_AUTOSTART !== "1") {
  void startBridgeServer({
    exitOnError: true,
    installSignalHandlers: true
  });
}

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
 */
import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import { browserSessionManager } from "./browser/browserSessionManager";
import { handleBrowserHttpRequest } from "./browser/browserHttpHandlers";
import { handleDesktopHttpRequest } from "./desktop/desktopHttpHandlers";
import { handleFileHttpRequest } from "./file/fileHttpHandlers";
import { ensureRuntimeDirectories } from "./file/fileRuntimePaths";
import { handleSoftwareHttpRequest } from "./software/softwareHttpHandlers";
import { handleModelProxy } from "./voidProxyMiddleware";

// 默认端口：固定回环端口，前端在 Tauri 环境下直连此端口。
const DEFAULT_BRIDGE_PORT = 17872;
const BRIDGE_HOST = "127.0.0.1";

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
  "anthropic-version"
].join(", ");

function resolvePort(): number {
  const fromEnv = process.env.VOID_BRIDGE_PORT;
  if (fromEnv) {
    const parsed = Number.parseInt(fromEnv, 10);
    if (Number.isInteger(parsed) && parsed > 0 && parsed < 65536) {
      return parsed;
    }
  }
  return DEFAULT_BRIDGE_PORT;
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

function handleHttpRequest(request: IncomingMessage, response: ServerResponse): void {
  const origin = request.headers.origin;
  if (origin && !ALLOWED_ORIGINS.has(origin)) {
    response.statusCode = 403;
    response.setHeader("Content-Type", "application/json; charset=utf-8");
    response.end(JSON.stringify({
      ok: false,
      error: { code: "ORIGIN_FORBIDDEN", message: "请求 Origin 不在允许列表内" }
    }));
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

  // 健康检查：供 Tauri 后端确认 sidecar 已就绪
  if (pathname === "/void-bridge/health") {
    response.statusCode = 200;
    response.setHeader("Content-Type", "application/json");
    response.end(
      JSON.stringify({
        status: "ok",
        browserReady: browserSessionManager.isBrowserReady(),
        activeBrowserSessions: browserSessionManager.listActiveTaskIds().length
      })
    );
    return;
  }

  response.statusCode = 404;
  response.end("Not found");
}

function startBridgeServer(): void {
  ensureRuntimeDirectories();
  const port = resolvePort();
  const httpServer = createServer(handleHttpRequest);

  httpServer.on("error", (error) => {
    console.error("[void-bridge] server error", error);
    process.exit(1);
  });

  httpServer.listen(port, BRIDGE_HOST, () => {
    // 该行是 Tauri 后端判断 sidecar 就绪的约定标记，勿改格式。
    console.log(`[void-bridge] listening on http://${BRIDGE_HOST}:${port}`);
  });

  // 收到终止信号时优雅退出（Tauri 回收 sidecar 时发送）。
  const shutdown = () => {
    void browserSessionManager.dispose().finally(() => {
      httpServer.close(() => process.exit(0));
    });
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

startBridgeServer();

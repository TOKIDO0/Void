/**
 * VOID 桥接运行时定位。
 *
 * 背景：模型 / 语音的 HTTP 转发与 STT/TTS 的 WebSocket 桥接，原来都寄生在 vite dev 上，
 * 前端用「当前页面同源」推导地址即可。迁移到 Tauri 后，这些桥接改由独立 sidecar 进程
 * 在固定回环端口提供，Tauri WebView 的页面 origin（tauri://localhost 或 http://localhost:5173）
 * 与 sidecar 端口不同源，必须显式指向 sidecar，而不能再用同源推导。
 *
 * 本模块是这套「地址从哪来」的唯一判定点：
 *   - 运行在 Tauri 里 → 指向 sidecar（127.0.0.1:17872）。
 *   - 运行在普通浏览器（vite dev / 未来 Web 部署）→ 维持原同源逻辑。
 *
 * 这样 Tauri 开发态与生产态走完全相同的代码路径，避免「开发能用、打包后哑」的分叉。
 */

// sidecar 默认回环地址，与 server/voidBridgeServer.ts 的 DEFAULT_BRIDGE_PORT 保持一致。
const SIDECAR_HOST = "127.0.0.1";
const SIDECAR_PORT = 17872;

/** 工具桥默认地址（sidecar 直接监听地址，各客户端统一引用，禁止各自硬编码）。 */
export const VOID_BRIDGE_DEFAULT_ORIGIN = `http://${SIDECAR_HOST}:${SIDECAR_PORT}`;

function readNodeBridgeEnv(name: string): string | undefined {
  const env = (globalThis as {
    process?: { env?: Record<string, string | undefined> };
  }).process?.env;
  const value = env?.[name]?.trim();
  return value ? value : undefined;
}

function readViteBridgeEnv(name: string): string | undefined {
  try {
    const meta = import.meta as unknown as {
      env?: Record<string, string | undefined>;
    };
    const value = meta.env?.[name]?.trim();
    return value ? value : undefined;
  } catch {
    return undefined;
  }
}

function normalizeBridgeOrigin(origin: string): string {
  return origin.replace(/\/$/, "");
}

/**
 * 工具桥地址唯一判定点（P0-3 收敛）。
 *
 * 优先级：显式 origin（Vite 环境变量 / Node 环境变量）> 显式端口 > 默认回环。
 * 注意：Vite 浏览器里没有 `process.env`，必须同时读 `import.meta.env`，
 * 否则 VOID_BRIDGE_PORT 覆盖永远不生效。各工具客户端禁止自建判定。
 */
export function resolveVoidBridgeOrigin(): string {
  const origin = readViteBridgeEnv("VOID_BRIDGE_ORIGIN")
    ?? readViteBridgeEnv("VITE_VOID_BRIDGE_ORIGIN")
    ?? readNodeBridgeEnv("VOID_BRIDGE_ORIGIN");
  if (origin) {
    return normalizeBridgeOrigin(origin);
  }
  const port = readViteBridgeEnv("VOID_BRIDGE_PORT")
    ?? readViteBridgeEnv("VITE_VOID_BRIDGE_PORT")
    ?? readNodeBridgeEnv("VOID_BRIDGE_PORT");
  if (port) {
    return `http://${SIDECAR_HOST}:${port}`;
  }
  return VOID_BRIDGE_DEFAULT_ORIGIN;
}

/**
 * 桥接不可达时的统一行动指引（P0-1）。
 * Tauri 安装包：sidecar 由 Rust 拉起，重点查托盘残留/进程崩溃；
 * 浏览器 dev：sidecar 需手动 `npm run dev:bridge`（或 `dev:all`）启动。
 */
export function getBridgeUnavailableHint(): string {
  if (isTauriRuntime()) {
    return "本地工具服务未连接：先完全退出托盘再重开 VOID；仍不行检查任务管理器是否有 void-bridge 进程。";
  }
  return "本地工具服务未连接：请确认已启动 sidecar（npm run dev:bridge，或改用 npm run dev:all）。";
}

/**
 * 是否运行在 Tauri WebView 中。
 * Tauri v2 运行时会注入布尔标记 window.isTauri（官方 isTauri() 判据），
 * 同时注入 IPC backbone __TAURI_INTERNALS__；两者取其一命中即视为 Tauri 环境。
 */
export function isTauriRuntime(): boolean {
  if (typeof window === "undefined") {
    return false;
  }
  return Boolean((window as { isTauri?: boolean }).isTauri) || "__TAURI_INTERNALS__" in window;
}

/** 桥接 HTTP 基地址（不含路径）。Tauri → sidecar；浏览器 → 同源。 */
export function resolveBridgeHttpOrigin(): string {
  if (isTauriRuntime()) {
    return `http://${SIDECAR_HOST}:${SIDECAR_PORT}`;
  }
  return window.location.origin;
}

/** 桥接 WebSocket 基地址（不含路径）。Tauri → sidecar；浏览器 → 同源。 */
export function resolveBridgeWsOrigin(): string {
  if (isTauriRuntime()) {
    return `ws://${SIDECAR_HOST}:${SIDECAR_PORT}`;
  }
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${protocol}//${window.location.host}`;
}

/**
 * 桥接 HTTP 转发路径解析：给定同源相对路径（如 /void-model-proxy），
 * 在 Tauri 下补全为 sidecar 绝对地址，浏览器下原样返回相对路径。
 */
export function resolveBridgeHttpUrl(pathname: string): string {
  if (isTauriRuntime()) {
    return `${resolveBridgeHttpOrigin()}${pathname}`;
  }
  return pathname;
}

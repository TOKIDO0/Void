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

/**
 * 桌面 sidecar HTTP 客户端（剪贴板）。
 * 工具层只调本客户端，不直接碰 OS。
 */

import type {
  ClipboardReadData,
  ClipboardWriteData,
  DesktopBridgeErrorCode,
  DesktopBridgeResponse,
  DesktopInstalledApp,
  DesktopInstalledAppsData,
  DesktopKnownLocation,
  DesktopLaunchAppData,
  DesktopOpenKnownLocationData,
  DesktopRevealPathData,
  DesktopListWindowsData,
  DesktopFocusWindowData,
  DesktopCloseWindowData,
  DesktopSystemInfoData,
  DesktopScreenshotData,
  DesktopSetWindowBoundsData
} from "./desktopBridgeTypes";
import { bridgeAuthHeadersForUrl } from "../../../lib/runtime/voidBridgeAuth";

const DEFAULT_BRIDGE_ORIGIN = "http://127.0.0.1:17872";

function resolveDesktopBridgeOrigin(): string {
  const env = (globalThis as {
    process?: { env?: Record<string, string | undefined> };
  }).process?.env;

  const origin = env?.VOID_BRIDGE_ORIGIN;
  if (origin && origin.trim()) {
    return origin.replace(/\/$/, "");
  }

  const port = env?.VOID_BRIDGE_PORT;
  if (port && port.trim()) {
    return `http://127.0.0.1:${port.trim()}`;
  }

  return DEFAULT_BRIDGE_ORIGIN;
}

function createDesktopClientError(
  code: DesktopBridgeErrorCode,
  message: string,
  details?: Record<string, unknown>
) {
  const error = new Error(message) as Error & {
    desktopCode: DesktopBridgeErrorCode;
    details?: Record<string, unknown>;
  };
  error.desktopCode = code;
  error.details = details;
  return error;
}

async function postDesktopApi<T>(
  pathname: string,
  body: Record<string, unknown>,
  signal?: AbortSignal
): Promise<T> {
  const url = `${resolveDesktopBridgeOrigin()}${pathname}`;
  const timeoutController = new AbortController();
  const timeoutHandle = setTimeout(() => timeoutController.abort(), 30_000);
  const onCallerAbort = () => timeoutController.abort();
  if (signal) {
    if (signal.aborted) {
      timeoutController.abort();
    } else {
      signal.addEventListener("abort", onCallerAbort, { once: true });
    }
  }

  let response: Response;
  try {
    const authHeaders = await bridgeAuthHeadersForUrl(url);
    response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...authHeaders },
      body: JSON.stringify(body),
      signal: timeoutController.signal
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "无法连接桌面桥接服务";
    const aborted = timeoutController.signal.aborted;
    throw createDesktopClientError(
      aborted && signal?.aborted
        ? "INTERNAL_ERROR"
        : aborted
          ? "TIMEOUT"
          : "BRIDGE_UNREACHABLE",
      aborted && signal?.aborted
        ? "桌面请求已取消"
        : aborted
          ? `桌面桥接超时（${url}）`
          : `桌面桥接不可达（${url}）：${message}。请确认 sidecar 已启动（npm run dev:bridge）。`
    );
  } finally {
    clearTimeout(timeoutHandle);
    signal?.removeEventListener("abort", onCallerAbort);
  }

  let payload: DesktopBridgeResponse<T>;
  try {
    payload = (await response.json()) as DesktopBridgeResponse<T>;
  } catch {
    throw createDesktopClientError(
      "INTERNAL_ERROR",
      `桌面桥接返回非 JSON（HTTP ${response.status}）`
    );
  }

  if (!payload || typeof payload !== "object") {
    throw createDesktopClientError("INTERNAL_ERROR", "桌面桥接响应无效");
  }

  if (!payload.ok) {
    throw createDesktopClientError(
      payload.error?.code ?? "INTERNAL_ERROR",
      payload.error?.message ?? "桌面操作失败",
      payload.error?.details
    );
  }

  return payload.data;
}

export async function clipboardRead(
  signal?: AbortSignal
): Promise<ClipboardReadData> {
  return postDesktopApi<ClipboardReadData>(
    "/void-desktop/clipboard/read",
    {},
    signal
  );
}

export async function clipboardWrite(
  input: { text: string },
  signal?: AbortSignal
): Promise<ClipboardWriteData> {
  return postDesktopApi<ClipboardWriteData>(
    "/void-desktop/clipboard/write",
    { text: input.text },
    signal
  );
}

export async function revealPath(
  input: { path: string },
  signal?: AbortSignal
): Promise<DesktopRevealPathData> {
  return postDesktopApi<DesktopRevealPathData>(
    "/void-desktop/reveal-path",
    { path: input.path },
    signal
  );
}

export async function openKnownLocation(
  input: { location: DesktopKnownLocation },
  signal?: AbortSignal
): Promise<DesktopOpenKnownLocationData> {
  return postDesktopApi<DesktopOpenKnownLocationData>(
    "/void-desktop/open-known-location",
    { location: input.location },
    signal
  );
}

export async function listInstalledApplications(
  signal?: AbortSignal
): Promise<DesktopInstalledAppsData> {
  return postDesktopApi<DesktopInstalledAppsData>(
    "/void-desktop/list-apps",
    {},
    signal
  );
}

export async function launchApplication(
  input: { name: string },
  signal?: AbortSignal
): Promise<DesktopLaunchAppData> {
  return postDesktopApi<DesktopLaunchAppData>(
    "/void-desktop/launch-app",
    { name: input.name },
    signal
  );
}

export async function listWindows(signal?: AbortSignal): Promise<DesktopListWindowsData> {
  return postDesktopApi<DesktopListWindowsData>("/void-desktop/list-windows", {}, signal);
}

export async function focusWindow(
  input: { hwnd?: string; pid?: number; title?: string },
  signal?: AbortSignal
): Promise<DesktopFocusWindowData> {
  return postDesktopApi<DesktopFocusWindowData>("/void-desktop/focus-window", input as Record<string, unknown>, signal);
}

export async function closeWindow(
  input: { hwnd?: string; pid?: number; title?: string },
  signal?: AbortSignal
): Promise<DesktopCloseWindowData> {
  return postDesktopApi<DesktopCloseWindowData>("/void-desktop/close-window", input as Record<string, unknown>, signal);
}

export async function getSystemInfo(signal?: AbortSignal): Promise<DesktopSystemInfoData> {
  return postDesktopApi<DesktopSystemInfoData>("/void-desktop/system-info", {}, signal);
}

export async function takeScreenshot(signal?: AbortSignal): Promise<DesktopScreenshotData> {
  return postDesktopApi<DesktopScreenshotData>("/void-desktop/screenshot", {}, signal);
}

export async function setWindowBounds(
  input: { hwnd?: string; pid?: number; title?: string; x?: number; y?: number; width?: number; height?: number; action?: string },
  signal?: AbortSignal
): Promise<DesktopSetWindowBoundsData> {
  return postDesktopApi<DesktopSetWindowBoundsData>("/void-desktop/set-window-bounds", input as Record<string, unknown>, signal);
}

export function getDesktopBridgeErrorInfo(error: unknown): {
  code: DesktopBridgeErrorCode;
  message: string;
  details?: Record<string, unknown>;
} {
  if (
    typeof error === "object"
    && error !== null
    && "desktopCode" in error
    && typeof (error as { desktopCode?: unknown }).desktopCode === "string"
  ) {
    const coded = error as Error & {
      desktopCode: DesktopBridgeErrorCode;
      details?: Record<string, unknown>;
    };
    return {
      code: coded.desktopCode,
      message: coded.message,
      details: coded.details
    };
  }

  return {
    code: "INTERNAL_ERROR",
    message: error instanceof Error ? error.message : "桌面桥接未知错误"
  };
}

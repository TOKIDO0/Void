/**
 * 桌面能力 HTTP 路由：/void-desktop/*
 * 当前：clipboard read/write、reveal-path
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import {
  isInvalidJsonBody,
  isRequestBodyTooLarge,
  readJsonBody
} from "../http/httpRequest";
import {
  CLIPBOARD_WRITE_MAX_CHARS,
  clipboardManager,
  getDesktopErrorPayload
} from "./clipboardManager";
import { desktopRevealManager } from "./desktopRevealManager";
import { desktopKnownLocationManager } from "./desktopKnownLocationManager";
import { listInstalledApplications, launchApplicationByName } from "./desktopAppManager";
import { listWindows, focusWindow, closeWindow, getSystemInfo } from "./desktopWindowManager";
import { takeDesktopScreenshot } from "./desktopScreenshotManager";
import type {
  ClipboardReadData,
  ClipboardWriteData,
  DesktopApiResponse,
  DesktopOpenKnownLocationData,
  DesktopRevealPathData
} from "./desktopTypes";

function sendJson(response: ServerResponse, status: number, body: unknown) {
  response.statusCode = status;
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  response.end(JSON.stringify(body));
}

function asRecord(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return {};
}

async function withDesktopHandler<T>(
  response: ServerResponse,
  work: () => Promise<T> | T
): Promise<void> {
  try {
    const data = await work();
    const payload: DesktopApiResponse<T> = { ok: true, data };
    sendJson(response, 200, payload);
  } catch (error) {
    if (isRequestBodyTooLarge(error)) {
      sendJson(response, 413, {
        ok: false,
        error: { code: "REQUEST_BODY_TOO_LARGE", message: error.message }
      });
      return;
    }
    if (isInvalidJsonBody(error)) {
      sendJson(response, 400, {
        ok: false,
        error: { code: "INVALID_REQUEST", message: error.message }
      });
      return;
    }
    const payloadError = getDesktopErrorPayload(error);
    const status =
      payloadError.code === "INVALID_REQUEST" || payloadError.code === "TOO_LARGE"
        ? 400
        : payloadError.code === "PATH_NOT_ALLOWED"
          ? 403
          : payloadError.code === "PATH_NOT_FOUND" || payloadError.code === "APP_NOT_FOUND"
            ? 404
            : payloadError.code === "AMBIGUOUS_APP_NAME"
              ? 409
              : payloadError.code === "UNSUPPORTED_PLATFORM"
                ? 501
                : payloadError.code === "TIMEOUT"
                  ? 504
                  : 500;
    const payload: DesktopApiResponse<never> = {
      ok: false,
      error: payloadError
    };
    sendJson(response, status, payload);
  }
}

/**
 * 处理 /void-desktop/* 。命中返回 true。
 */
export async function handleDesktopHttpRequest(
  request: IncomingMessage,
  response: ServerResponse,
  pathname: string
): Promise<boolean> {
  if (!pathname.startsWith("/void-desktop")) {
    return false;
  }

  if (request.method === "GET" && pathname === "/void-desktop/health") {
    sendJson(response, 200, { status: "ok", module: "desktop" });
    return true;
  }

  if (request.method !== "POST") {
    sendJson(response, 405, {
      ok: false,
      error: { code: "INVALID_REQUEST", message: "仅支持 POST/GET health" }
    });
    return true;
  }

  if (pathname === "/void-desktop/clipboard/read") {
    await withDesktopHandler<ClipboardReadData>(response, async () => {
      // body 可空；预读一下以免客户端挂起
      await readJsonBody(request);
      return clipboardManager.read();
    });
    return true;
  }

  if (pathname === "/void-desktop/clipboard/write") {
    await withDesktopHandler<ClipboardWriteData>(response, async () => {
      const body = asRecord(await readJsonBody(request));
      if (typeof body.text !== "string") {
        throw Object.assign(new Error("缺少 text"), {
          desktopCode: "INVALID_REQUEST"
        });
      }
      if (body.text.length > CLIPBOARD_WRITE_MAX_CHARS) {
        throw Object.assign(
          new Error(
            `剪贴板写入不能超过 ${CLIPBOARD_WRITE_MAX_CHARS} 字符（当前 ${body.text.length}）`
          ),
          {
            desktopCode: "TOO_LARGE",
            details: {
              maxChars: CLIPBOARD_WRITE_MAX_CHARS,
              length: body.text.length
            }
          }
        );
      }
      return clipboardManager.write(body.text);
    });
    return true;
  }

  if (pathname === "/void-desktop/reveal-path") {
    await withDesktopHandler<DesktopRevealPathData>(response, async () => {
      const body = asRecord(await readJsonBody(request));
      const path = typeof body.path === "string" ? body.path.trim() : "";
      if (!path) {
        throw Object.assign(new Error("缺少 path"), {
          desktopCode: "INVALID_REQUEST"
        });
      }
      return desktopRevealManager.revealPath(path);
    });
    return true;
  }

  if (pathname === "/void-desktop/open-known-location") {
    await withDesktopHandler<DesktopOpenKnownLocationData>(response, async () => {
      const body = asRecord(await readJsonBody(request));
      const location = body.location;
      if (location !== "this_pc") {
        throw Object.assign(new Error("location 只允许 this_pc"), {
          desktopCode: "INVALID_REQUEST"
        });
      }
      return desktopKnownLocationManager.open(location);
    });
    return true;
  }

  if (pathname === "/void-desktop/list-apps") {
    await withDesktopHandler(response, async () => {
      await readJsonBody(request);
      const apps = listInstalledApplications();
      return { apps, count: apps.length, scannedAt: Date.now() };
    });
    return true;
  }

  if (pathname === "/void-desktop/launch-app") {
    await withDesktopHandler(response, async () => {
      const body = asRecord(await readJsonBody(request));
      const name = typeof body.name === "string" ? body.name.trim() : "";
      if (!name) {
        throw Object.assign(new Error("缺少 name（应用名）"), { desktopCode: "INVALID_REQUEST" });
      }
      return launchApplicationByName(name);
    });
    return true;
  }

  if (pathname === "/void-desktop/list-windows") {
    await withDesktopHandler(response, async () => {
      await readJsonBody(request);
      const windows = await listWindows();
      return { windows, count: windows.length, scannedAt: Date.now() };
    });
    return true;
  }

  if (pathname === "/void-desktop/focus-window") {
    await withDesktopHandler(response, async () => {
      const body = asRecord(await readJsonBody(request));
      const hwnd = typeof body.hwnd === "string" ? body.hwnd.trim() : undefined;
      const pid = typeof body.pid === "number" ? body.pid : typeof body.pid === "string" ? Number(body.pid) : undefined;
      const title = typeof body.title === "string" ? body.title.trim() : undefined;
      if (!hwnd && !pid && !title) {
        throw Object.assign(new Error("需提供 hwnd/pid/title 之一"), { desktopCode: "INVALID_REQUEST" });
      }
      const w = await focusWindow({ hwnd, pid, title });
      return { hwnd: w.hwnd, pid: w.pid, processName: w.processName, title: w.title, focusedAt: Date.now() };
    });
    return true;
  }

  if (pathname === "/void-desktop/close-window") {
    await withDesktopHandler(response, async () => {
      const body = asRecord(await readJsonBody(request));
      const hwnd = typeof body.hwnd === "string" ? body.hwnd.trim() : undefined;
      const pid = typeof body.pid === "number" ? body.pid : typeof body.pid === "string" ? Number(body.pid) : undefined;
      const title = typeof body.title === "string" ? body.title.trim() : undefined;
      if (!hwnd && !pid && !title) {
        throw Object.assign(new Error("需提供 hwnd/pid/title 之一"), { desktopCode: "INVALID_REQUEST" });
      }
      const res = await closeWindow({ hwnd, pid, title });
      return { closed: res.closed, pid: res.pid, title: res.title, closedAt: Date.now() };
    });
    return true;
  }

  if (pathname === "/void-desktop/system-info") {
    await withDesktopHandler(response, async () => {
      await readJsonBody(request);
      const info = await getSystemInfo();
      return { ...info, collectedAt: Date.now() };
    });
    return true;
  }

  if (pathname === "/void-desktop/screenshot") {
    await withDesktopHandler(response, async () => {
      await readJsonBody(request);
      return takeDesktopScreenshot();
    });
    return true;
  }

  sendJson(response, 404, {
    ok: false,
    error: { code: "INVALID_REQUEST", message: `未知桌面路由：${pathname}` }
  });
  return true;
}

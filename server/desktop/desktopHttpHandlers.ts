/**
 * 桌面能力 HTTP 路由：/void-desktop/*
 * 当前：clipboard read / write
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import {
  CLIPBOARD_WRITE_MAX_CHARS,
  clipboardManager,
  getDesktopErrorPayload
} from "./clipboardManager";
import type {
  ClipboardReadData,
  ClipboardWriteData,
  DesktopApiResponse
} from "./desktopTypes";

async function readJsonBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  const raw = Buffer.concat(chunks).toString("utf8").trim();
  if (!raw) {
    return {};
  }
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    throw Object.assign(new Error("请求体不是合法 JSON"), {
      desktopCode: "INVALID_REQUEST"
    });
  }
}

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
    const payloadError = getDesktopErrorPayload(error);
    const status =
      payloadError.code === "INVALID_REQUEST" || payloadError.code === "TOO_LARGE"
        ? 400
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

  sendJson(response, 404, {
    ok: false,
    error: { code: "INVALID_REQUEST", message: `未知桌面路由：${pathname}` }
  });
  return true;
}

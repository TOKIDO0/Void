/**
 * 浏览器自动化 HTTP 路由处理器。
 * 路径前缀：/void-browser/*
 * 仅 JSON；错误统一 BrowserApiResponse 形态。
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import {
  browserSessionManager,
  getBrowserErrorPayload
} from "./browserSessionManager";
import type {
  BrowserApiResponse,
  BrowserCloseSessionData,
  BrowserOpenData,
  BrowserReadResultData,
  BrowserScreenshotData,
  BrowserSearchData
} from "./browserTypes";

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
      browserCode: "INVALID_REQUEST"
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

function readString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function readNumber(record: Record<string, unknown>, key: string): number | undefined {
  const value = record[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function readBoolean(record: Record<string, unknown>, key: string): boolean | undefined {
  const value = record[key];
  return typeof value === "boolean" ? value : undefined;
}

async function withBrowserHandler<T>(
  response: ServerResponse,
  work: () => Promise<T>
): Promise<void> {
  try {
    const data = await work();
    const payload: BrowserApiResponse<T> = { ok: true, data };
    sendJson(response, 200, payload);
  } catch (error) {
    const payloadError = getBrowserErrorPayload(error);
    const status =
      payloadError.code === "INVALID_REQUEST"
        ? 400
        : payloadError.code === "SESSION_NOT_FOUND" || payloadError.code === "PAGE_NOT_FOUND"
          ? 404
          : payloadError.code === "BROWSER_UNAVAILABLE"
            ? 503
            : 500;
    const payload: BrowserApiResponse<never> = {
      ok: false,
      error: payloadError
    };
    sendJson(response, status, payload);
  }
}

/**
 * 处理 /void-browser/* 路由。命中返回 true。
 */
export async function handleBrowserHttpRequest(
  request: IncomingMessage,
  response: ServerResponse,
  pathname: string
): Promise<boolean> {
  if (!pathname.startsWith("/void-browser")) {
    return false;
  }

  if (request.method === "GET" && pathname === "/void-browser/health") {
    sendJson(response, 200, {
      status: "ok",
      browserReady: browserSessionManager.isBrowserReady(),
      activeSessions: browserSessionManager.listActiveTaskIds().length
    });
    return true;
  }

  if (request.method !== "POST") {
    sendJson(response, 405, {
      ok: false,
      error: { code: "INVALID_REQUEST", message: "仅支持 POST/GET health" }
    });
    return true;
  }

  if (pathname === "/void-browser/session/ensure") {
    await withBrowserHandler(response, async () => {
      const body = asRecord(await readJsonBody(request));
      const taskId = readString(body, "taskId");
      if (!taskId) {
        throw Object.assign(new Error("缺少 taskId"), { browserCode: "INVALID_REQUEST" });
      }
      return browserSessionManager.ensureSession(taskId);
    });
    return true;
  }

  if (pathname === "/void-browser/session/close") {
    await withBrowserHandler<BrowserCloseSessionData>(response, async () => {
      const body = asRecord(await readJsonBody(request));
      const taskId = readString(body, "taskId");
      if (!taskId) {
        throw Object.assign(new Error("缺少 taskId"), { browserCode: "INVALID_REQUEST" });
      }
      return browserSessionManager.closeSession(taskId);
    });
    return true;
  }

  if (pathname === "/void-browser/open") {
    await withBrowserHandler<BrowserOpenData>(response, async () => {
      const body = asRecord(await readJsonBody(request));
      const taskId = readString(body, "taskId");
      const url = readString(body, "url");
      if (!taskId || !url) {
        throw Object.assign(new Error("缺少 taskId 或 url"), {
          browserCode: "INVALID_REQUEST"
        });
      }
      return browserSessionManager.open({
        taskId,
        url,
        pageId: readString(body, "pageId")
      });
    });
    return true;
  }

  if (pathname === "/void-browser/search") {
    await withBrowserHandler<BrowserSearchData>(response, async () => {
      const body = asRecord(await readJsonBody(request));
      const taskId = readString(body, "taskId");
      const query = readString(body, "query");
      if (!taskId || !query) {
        throw Object.assign(new Error("缺少 taskId 或 query"), {
          browserCode: "INVALID_REQUEST"
        });
      }
      return browserSessionManager.search({
        taskId,
        query,
        limit: readNumber(body, "limit")
      });
    });
    return true;
  }

  if (pathname === "/void-browser/read-result") {
    await withBrowserHandler<BrowserReadResultData>(response, async () => {
      const body = asRecord(await readJsonBody(request));
      const taskId = readString(body, "taskId");
      if (!taskId) {
        throw Object.assign(new Error("缺少 taskId"), { browserCode: "INVALID_REQUEST" });
      }
      return browserSessionManager.readResult({
        taskId,
        pageId: readString(body, "pageId"),
        limit: readNumber(body, "limit")
      });
    });
    return true;
  }

  if (pathname === "/void-browser/screenshot") {
    await withBrowserHandler<BrowserScreenshotData>(response, async () => {
      const body = asRecord(await readJsonBody(request));
      const taskId = readString(body, "taskId");
      if (!taskId) {
        throw Object.assign(new Error("缺少 taskId"), { browserCode: "INVALID_REQUEST" });
      }
      return browserSessionManager.screenshot({
        taskId,
        pageId: readString(body, "pageId"),
        fullPage: readBoolean(body, "fullPage")
      });
    });
    return true;
  }

  sendJson(response, 404, {
    ok: false,
    error: { code: "INVALID_REQUEST", message: `未知浏览器路由：${pathname}` }
  });
  return true;
}

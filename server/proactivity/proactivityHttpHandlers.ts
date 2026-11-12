/**
 * PRO-04 安静时段 HTTP 路由：/void-proactivity/*（回环 + bridge token，同其它 sidecar 模块契约）。
 * 成功 { ok:true, data }，失败 { ok:false, error:{ code, message } }。
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import { isInvalidJsonBody, isRequestBodyTooLarge, readJsonBody } from "../http/httpRequest";
import { getProactivityErrorInfo } from "./proactivityPolicy";
import { proactivityStore } from "./proactivityStore";

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  if (response.destroyed || response.writableEnded) {
    return;
  }
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

export async function handleProactivityHttpRequest(
  request: IncomingMessage,
  response: ServerResponse,
  pathname: string
): Promise<boolean> {
  if (!pathname.startsWith("/void-proactivity")) {
    return false;
  }

  if (request.method === "GET" && pathname === "/void-proactivity/status") {
    sendJson(response, 200, { ok: true, data: proactivityStore.getStatus() });
    return true;
  }

  if (request.method === "POST" && pathname === "/void-proactivity/quiet-hours") {
    try {
      const body = asRecord(await readJsonBody(request));
      sendJson(response, 200, { ok: true, data: proactivityStore.setQuietHours(body) });
    } catch (error) {
      handleBodyError(response, error);
    }
    return true;
  }

  sendJson(response, 404, { ok: false, error: { code: "NOT_FOUND", message: "未知安静时段端点" } });
  return true;
}

function handleBodyError(response: ServerResponse, error: unknown): void {
  if (isRequestBodyTooLarge(error)) {
    sendJson(response, 413, {
      ok: false,
      error: { code: "REQUEST_BODY_TOO_LARGE", message: (error as Error).message }
    });
    return;
  }
  if (isInvalidJsonBody(error)) {
    sendJson(response, 400, {
      ok: false,
      error: { code: "INVALID_REQUEST", message: (error as Error).message }
    });
    return;
  }
  const info = getProactivityErrorInfo(error);
  sendJson(response, info.code === "INVALID_REQUEST" ? 400 : 500, { ok: false, error: info });
}

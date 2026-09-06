/**
 * C 模型用量 HTTP 路由：/void-model-usage/*（回环 + token，同其它 sidecar 模块契约）。
 * 成功 { ok:true, data }，失败 { ok:false, error:{ code, message } }。
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import { isInvalidJsonBody, isRequestBodyTooLarge, readJsonBody } from "../http/httpRequest";
import { modelUsageStore } from "./modelUsageStore";

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

export async function handleUsageHttpRequest(
  request: IncomingMessage,
  response: ServerResponse,
  pathname: string
): Promise<boolean> {
  if (!pathname.startsWith("/void-model-usage")) {
    return false;
  }

  if (request.method === "GET" && pathname === "/void-model-usage") {
    sendJson(response, 200, {
      ok: true,
      data: {
        today: modelUsageStore.getToday(),
        last7: modelUsageStore.getLast7Days(),
        dailyTokenCap: modelUsageStore.getDailyTokenCap()
      }
    });
    return true;
  }

  if (request.method === "POST" && pathname === "/void-model-usage/budget") {
    try {
      const body = asRecord(await readJsonBody(request));
      const cap = body.dailyTokenCap;
      if (typeof cap !== "number" || !Number.isFinite(cap) || cap < 0) {
        sendJson(response, 400, {
          ok: false,
          error: { code: "INVALID_REQUEST", message: "dailyTokenCap 必须是非负数字（0 表示不限）" }
        });
        return true;
      }
      sendJson(response, 200, { ok: true, data: { dailyTokenCap: modelUsageStore.setDailyTokenCap(cap) } });
    } catch (error) {
      if (isRequestBodyTooLarge(error)) {
        sendJson(response, 413, { ok: false, error: { code: "REQUEST_BODY_TOO_LARGE", message: (error as Error).message } });
        return true;
      }
      if (isInvalidJsonBody(error)) {
        sendJson(response, 400, { ok: false, error: { code: "INVALID_REQUEST", message: (error as Error).message } });
        return true;
      }
      throw error;
    }
    return true;
  }

  sendJson(response, 404, { ok: false, error: { code: "NOT_FOUND", message: "未知用量端点" } });
  return true;
}

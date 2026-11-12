/**
 * PRO-02 主动程度 HTTP 路由：/void-proactivity/level（回环 + bridge token，同其它 sidecar 模块契约）。
 * 成功 { ok:true, data }，失败 { ok:false, error:{ code, message } }。
 * 只做参数校验与协议映射；档位语义与预算由 proactivityLevelPolicy 决定。
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import { isInvalidJsonBody, isRequestBodyTooLarge, readJsonBody } from "../http/httpRequest";
import { getProactivityErrorInfo } from "./proactivityPolicy";
import { proactivityLevelStore } from "./proactivityLevelStore";

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

export async function handleProactivityLevelHttpRequest(
  request: IncomingMessage,
  response: ServerResponse,
  pathname: string
): Promise<boolean> {
  if (pathname !== "/void-proactivity/level") {
    return false;
  }

  if (request.method === "GET") {
    sendJson(response, 200, { ok: true, data: proactivityLevelStore.getStatus() });
    return true;
  }

  if (request.method === "POST") {
    try {
      const body = asRecord(await readJsonBody(request));
      sendJson(response, 200, { ok: true, data: proactivityLevelStore.setLevel(body) });
    } catch (error) {
      if (isRequestBodyTooLarge(error)) {
        sendJson(response, 413, {
          ok: false,
          error: { code: "REQUEST_BODY_TOO_LARGE", message: (error as Error).message }
        });
        return true;
      }
      if (isInvalidJsonBody(error)) {
        sendJson(response, 400, {
          ok: false,
          error: { code: "INVALID_REQUEST", message: (error as Error).message }
        });
        return true;
      }
      const info = getProactivityErrorInfo(error);
      sendJson(response, info.code === "INVALID_REQUEST" ? 400 : 500, { ok: false, error: info });
    }
    return true;
  }

  sendJson(response, 404, { ok: false, error: { code: "NOT_FOUND", message: "未知主动等级端点" } });
  return true;
}

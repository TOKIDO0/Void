/**
 * PRO-05 静默巡检 HTTP 路由：/void-heartbeat/*（回环 + bridge token，同其它 sidecar 模块契约）。
 * 成功 { ok:true, data }，失败 { ok:false, error:{ code, message } }。
 * 只做参数校验与协议映射；是否该巡检、什么算问题全部在 policy/runner。
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import { isInvalidJsonBody, isRequestBodyTooLarge, readJsonBody } from "../http/httpRequest";
import { getHeartbeatStatus, runHeartbeatRound, setHeartbeatEnabled } from "./heartbeatRunner";
import { createHeartbeatError, getHeartbeatErrorInfo } from "./heartbeatTypes";

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

function sendError(response: ServerResponse, error: unknown): void {
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
  const info = getHeartbeatErrorInfo(error);
  sendJson(response, info.code === "INVALID_REQUEST" ? 400 : 500, { ok: false, error: info });
}

export async function handleHeartbeatHttpRequest(
  request: IncomingMessage,
  response: ServerResponse,
  pathname: string
): Promise<boolean> {
  if (!pathname.startsWith("/void-heartbeat")) {
    return false;
  }

  if (request.method === "GET" && pathname === "/void-heartbeat/status") {
    try {
      sendJson(response, 200, { ok: true, data: getHeartbeatStatus() });
    } catch (error) {
      sendError(response, error);
    }
    return true;
  }

  if (request.method === "POST" && pathname === "/void-heartbeat/config") {
    try {
      const body = asRecord(await readJsonBody(request));
      if (typeof body.enabled !== "boolean") {
        throw createHeartbeatError("INVALID_REQUEST", "enabled 必须是布尔值");
      }
      sendJson(response, 200, { ok: true, data: setHeartbeatEnabled(body.enabled) });
    } catch (error) {
      sendError(response, error);
    }
    return true;
  }

  if (request.method === "POST" && pathname === "/void-heartbeat/run") {
    try {
      const result = runHeartbeatRound({ manual: true });
      sendJson(response, 200, { ok: true, data: { result, status: getHeartbeatStatus() } });
    } catch (error) {
      sendError(response, error);
    }
    return true;
  }

  sendJson(response, 404, { ok: false, error: { code: "NOT_FOUND", message: "未知静默巡检端点" } });
  return true;
}

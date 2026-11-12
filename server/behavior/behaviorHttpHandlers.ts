/**
 * BEH-01 行为聚合 HTTP 路由：/void-behavior/*（回环 + bridge token，同其它 sidecar 模块契约）。
 * 成功 { ok:true, data }，失败 { ok:false, error:{ code, message } }。
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import { isInvalidJsonBody, isRequestBodyTooLarge, readJsonBody } from "../http/httpRequest";
import { BEHAVIOR_MAX_SAMPLES_PER_REQUEST } from "./behaviorTypes";
import { deriveBehaviorProfile } from "./behaviorProfile";
import { behaviorStore } from "./behaviorStore";

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

export async function handleBehaviorHttpRequest(
  request: IncomingMessage,
  response: ServerResponse,
  pathname: string
): Promise<boolean> {
  if (!pathname.startsWith("/void-behavior")) {
    return false;
  }

  if (request.method === "GET" && pathname === "/void-behavior/status") {
    sendJson(response, 200, { ok: true, data: behaviorStore.getStatus() });
    return true;
  }

  if (request.method === "GET" && pathname === "/void-behavior/profile") {
    try {
      const data = deriveBehaviorProfile(behaviorStore.readProfileSource());
      sendJson(response, 200, { ok: true, data });
    } catch (error) {
      sendJson(response, 500, {
        ok: false,
        error: {
          code: "PROFILE_DERIVATION_FAILED",
          message: error instanceof Error ? error.message : "作息画像派生失败"
        }
      });
    }
    return true;
  }

  if (request.method === "POST" && pathname === "/void-behavior/enabled") {
    try {
      const body = asRecord(await readJsonBody(request));
      if (typeof body.enabled !== "boolean") {
        sendJson(response, 400, {
          ok: false,
          error: { code: "INVALID_REQUEST", message: "enabled 必须是布尔值" }
        });
        return true;
      }
      sendJson(response, 200, { ok: true, data: { enabled: behaviorStore.setEnabled(body.enabled) } });
    } catch (error) {
      handleBodyError(response, error);
    }
    return true;
  }

  if (request.method === "POST" && pathname === "/void-behavior/sample") {
    try {
      const body = asRecord(await readJsonBody(request));
      if (!Array.isArray(body.samples)) {
        sendJson(response, 400, {
          ok: false,
          error: { code: "INVALID_REQUEST", message: "samples 必须是数组" }
        });
        return true;
      }
      if (body.samples.length > BEHAVIOR_MAX_SAMPLES_PER_REQUEST) {
        sendJson(response, 400, {
          ok: false,
          error: {
            code: "SAMPLE_LIMIT",
            message: `单次最多 ${BEHAVIOR_MAX_SAMPLES_PER_REQUEST} 条样本，收到 ${body.samples.length} 条`
          }
        });
        return true;
      }
      const result = behaviorStore.ingest(body.samples, body.probeReadFailures);
      sendJson(response, 200, { ok: true, data: result });
    } catch (error) {
      handleBodyError(response, error);
    }
    return true;
  }

  sendJson(response, 404, { ok: false, error: { code: "NOT_FOUND", message: "未知行为观察端点" } });
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
  sendJson(response, 500, {
    ok: false,
    error: { code: "INTERNAL_ERROR", message: error instanceof Error ? error.message : "行为观察内部错误" }
  });
}

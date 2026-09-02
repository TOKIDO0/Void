import type { IncomingMessage, ServerResponse } from "node:http";
import { isInvalidJsonBody, isRequestBodyTooLarge, readJsonBody } from "../http/httpRequest";
import { executeCode, getCodeErrorPayload } from "./codeExecutor";
import type { CodeApiResponse, CodeRunData } from "./codeTypes";

function sendJson(response: ServerResponse, status: number, body: unknown) {
  if (response.destroyed || response.writableEnded) return;
  response.statusCode = status;
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  response.end(JSON.stringify(body));
}

function resolveCodeErrorStatus(code: string): number {
  switch (code) {
    case "INVALID_REQUEST":
    case "BLOCKED_PATTERN":
      return 400;
    case "PYTHON_NOT_FOUND":
      return 503;
    default:
      return 500;
  }
}

export async function handleCodeHttpRequest(request: IncomingMessage, response: ServerResponse, pathname: string): Promise<boolean> {
  if (!pathname.startsWith("/void-code")) return false;
  if (request.method === "GET" && pathname === "/void-code/health") {
    sendJson(response, 200, { status: "ok" });
    return true;
  }
  if (request.method !== "POST") {
    sendJson(response, 405, { ok: false, error: { code: "INVALID_REQUEST", message: "仅支持 POST/GET health" } });
    return true;
  }
  if (pathname === "/void-code/run") {
    try {
      const body = await readJsonBody(request, 64 * 1024) as Record<string, unknown>;
      const language = typeof body.language === "string" ? body.language.trim() : "";
      const code = typeof body.code === "string" ? body.code : "";
      const timeoutMs = body.timeoutMs as unknown;
      const data = await executeCode({ language: language as never, code, timeoutMs: timeoutMs as number | undefined });
      const payload: CodeApiResponse<CodeRunData> = { ok: true, data };
      sendJson(response, 200, payload);
    } catch (error) {
      if (isRequestBodyTooLarge(error)) {
        sendJson(response, 413, { ok: false, error: { code: "REQUEST_BODY_TOO_LARGE", message: (error as Error).message } });
        return true;
      }
      if (isInvalidJsonBody(error)) {
        sendJson(response, 400, { ok: false, error: { code: "INVALID_REQUEST", message: (error as Error).message } });
        return true;
      }
      const payloadError = getCodeErrorPayload(error);
      const status = resolveCodeErrorStatus(payloadError.code);
      sendJson(response, status, { ok: false, error: payloadError });
    }
    return true;
  }
  sendJson(response, 404, { ok: false, error: { code: "INVALID_REQUEST", message: `未知代码路由：${pathname}` } });
  return true;
}

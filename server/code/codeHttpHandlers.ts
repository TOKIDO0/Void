import type { IncomingMessage, ServerResponse } from "node:http";
import { BRIDGE_TOKEN_HEADER } from "../bridge/bridgeAuth";
import { isInvalidJsonBody, isRequestBodyTooLarge, readJsonBody } from "../http/httpRequest";
import { appendToolAudit, fingerprintToken } from "../audit/toolAuditLog";
import { hooksRegistry } from "../hooks/hooksRegistry";
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
      return 400;
    case "PYTHON_DISABLED":
      return 403;
    case "PYTHON_NOT_FOUND":
      return 503;
    default:
      return 500;
  }
}

function callerFingerprint(request: IncomingMessage): string {
  const token = request.headers[BRIDGE_TOKEN_HEADER];
  return fingerprintToken(typeof token === "string" ? token : "");
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
    const started = Date.now();
    try {
      const body = await readJsonBody(request, 64 * 1024) as Record<string, unknown>;
      const language = typeof body.language === "string" ? body.language.trim() : "";
      // P1 Hooks PreToolUse：code.run 支持 hook deny。
      const hookDecision = hooksRegistry.consult("PreToolUse", `code.run:${language || "unknown"}`);
      if (hookDecision?.effect === "deny") {
        appendToolAudit({
          at: Date.now(),
          module: "code",
          action: `code.run:${language || "unknown"}`,
          decision: "deny",
          reason: `Hook deny：${hookDecision.reason}`,
          callerFingerprint: callerFingerprint(request),
          durationMs: Date.now() - started,
          errorCode: "HOOK_DENIED"
        });
        sendJson(response, 403, { ok: false, error: { code: "HOOK_DENIED", message: `代码执行被 Hook 拒绝（${hookDecision.reason}）` } });
        return true;
      }
      const code = typeof body.code === "string" ? body.code : "";
      const timeoutMs = body.timeoutMs as unknown;
      const data = await executeCode({ language: language as never, code, timeoutMs: timeoutMs as number | undefined });
      const payload: CodeApiResponse<CodeRunData> = { ok: true, data };
      appendToolAudit({
        at: Date.now(),
        module: "code",
        action: `code.run:${language}`,
        decision: "ask-allow",
        reason: `执行完成（exit=${String(data.exitCode)}, ${data.durationMs}ms）`,
        callerFingerprint: callerFingerprint(request),
        durationMs: Date.now() - started
      });
      hooksRegistry.consult("PostToolUse", `code.run:${language}`);
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

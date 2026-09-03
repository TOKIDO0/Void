import type { IncomingMessage, ServerResponse } from "node:http";
import { isInvalidJsonBody, isRequestBodyTooLarge, readJsonBody } from "../http/httpRequest";
import { webSearch } from "./webSearchManager";
import { webFetch } from "./webFetchManager";

function sendJson(response: ServerResponse, status: number, body: unknown) {
  response.statusCode = status;
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  response.end(JSON.stringify(body));
}

function asRecord(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

export async function handleWebHttpRequest(
  request: IncomingMessage,
  response: ServerResponse,
  pathname: string
): Promise<boolean> {
  if (!pathname.startsWith("/void-web")) return false;
  if (request.method !== "POST") {
    sendJson(response, 405, { ok: false, error: { code: "INVALID_REQUEST", message: "仅支持 POST" } });
    return true;
  }
  if (pathname === "/void-web/search") {
    try {
      const body = asRecord(await readJsonBody(request));
      const query = typeof body.query === "string" ? body.query.trim() : "";
      const limit = typeof body.limit === "number" ? body.limit : 8;
      if (!query) throw Object.assign(new Error("缺少 query"), { webCode: "INVALID_REQUEST" });
      const data = await webSearch(query, limit);
      sendJson(response, 200, { ok: true, data });
    } catch (error) {
      if (isRequestBodyTooLarge(error)) {
        sendJson(response, 413, { ok: false, error: { code: "REQUEST_BODY_TOO_LARGE", message: (error as Error).message } });
        return true;
      }
      if (isInvalidJsonBody(error)) {
        sendJson(response, 400, { ok: false, error: { code: "INVALID_REQUEST", message: (error as Error).message } });
        return true;
      }
      const code = (error as { webCode?: string }).webCode ?? "INTERNAL_ERROR";
      const status = code === "INVALID_REQUEST" ? 400 : code === "TIMEOUT" ? 504 : 500;
      sendJson(response, status, { ok: false, error: { code, message: (error as Error).message || "搜索失败" } });
    }
    return true;
  }

  if (pathname === "/void-web/fetch") {
    try {
      const body = asRecord(await readJsonBody(request));
      const url = typeof body.url === "string" ? body.url.trim() : "";
      if (!url) throw Object.assign(new Error("缺少 url"), { webCode: "INVALID_REQUEST" });
      const data = await webFetch(url);
      sendJson(response, 200, { ok: true, data });
    } catch (error) {
      if (isRequestBodyTooLarge(error)) {
        sendJson(response, 413, { ok: false, error: { code: "REQUEST_BODY_TOO_LARGE", message: (error as Error).message } });
        return true;
      }
      if (isInvalidJsonBody(error)) {
        sendJson(response, 400, { ok: false, error: { code: "INVALID_REQUEST", message: (error as Error).message } });
        return true;
      }
      const code = (error as { webCode?: string }).webCode ?? "INTERNAL_ERROR";
      const status = code === "INVALID_REQUEST" ? 400 : code === "TIMEOUT" ? 504 : code === "TOO_LARGE" ? 413 : 500;
      sendJson(response, status, { ok: false, error: { code, message: (error as Error).message || "抓取失败" } });
    }
    return true;
  }
  sendJson(response, 404, { ok: false, error: { code: "INVALID_REQUEST", message: `未知 web 路由：${pathname}` } });
  return true;
}

/**
 * P1 MCP HTTP 路由：/void-mcp/*（回环 + token，与其它 sidecar 模块同契约）。
 * 成功 { ok:true, data }，失败 { ok:false, error:{ code, message } }。
 *
 * - servers：列出 .mcp.json 可用 server（不含 disabled/示例）；
 * - tools/list：连接指定 server 列工具（mcp__<server>__<tool> 命名）；
 * - tools/call：调用工具。MCP 工具默认 ask：默认模式记账放行并审计，
 *   VOID_DESKTOP_STRICT_ASK=1（与桌面同一开关）时需 body.confirmed=true；
 *   第三方 server 默认沙箱语义：stdio 进程无网络（由 server 自身约束），http 走 SSRF 守卫。
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import { BRIDGE_TOKEN_HEADER } from "../bridge/bridgeAuth";
import { isInvalidJsonBody, isRequestBodyTooLarge, readJsonBody } from "../http/httpRequest";
import { appendToolAudit, fingerprintToken } from "../audit/toolAuditLog";
import {
  callMcpTool,
  listMcpTools,
  loadMcpServersConfigSync,
  parseMcpToolName
} from "./mcpClientManager";

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  if (response.destroyed || response.writableEnded) return;
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

function callerFingerprint(request: IncomingMessage): string {
  const token = request.headers[BRIDGE_TOKEN_HEADER];
  return fingerprintToken(typeof token === "string" ? token : "");
}

function isStrictAsk(): boolean {
  return process.env.VOID_DESKTOP_STRICT_ASK === "1";
}

export async function handleMcpHttpRequest(
  request: IncomingMessage,
  response: ServerResponse,
  pathname: string
): Promise<boolean> {
  if (!pathname.startsWith("/void-mcp")) return false;

  if (request.method === "GET" && (pathname === "/void-mcp/servers" || pathname === "/void-mcp")) {
    try {
      const servers = loadMcpServersConfigSync();
      sendJson(response, 200, {
        ok: true,
        data: {
          servers: Object.entries(servers).map(([name, config]) => ({
            name,
            kind: config.kind,
            // 不回显完整 args（可能含路径参数），只给数量；url 脱敏 query。
            argCount: config.args?.length ?? 0,
            url: typeof config.url === "string" ? config.url.split("?")[0] : undefined
          })),
          strictAsk: isStrictAsk()
        }
      });
    } catch (error) {
      sendJson(response, 500, {
        ok: false,
        error: { code: "MCP_CONFIG_FAILED", message: error instanceof Error ? error.message : "MCP 配置读取失败" }
      });
    }
    return true;
  }

  if (request.method !== "POST") {
    sendJson(response, 405, {
      ok: false,
      error: { code: "INVALID_REQUEST", message: "仅支持 POST/GET servers" }
    });
    return true;
  }

  if (pathname === "/void-mcp/tools/list") {
    try {
      const body = asRecord(await readJsonBody(request));
      const server = typeof body.server === "string" ? body.server.trim() : "";
      if (!server) {
        sendJson(response, 400, { ok: false, error: { code: "INVALID_REQUEST", message: "缺少 server" } });
        return true;
      }
      const servers = loadMcpServersConfigSync();
      const config = servers[server];
      if (!config) {
        sendJson(response, 404, { ok: false, error: { code: "MCP_SERVER_NOT_FOUND", message: `未知 MCP server：${server}` } });
        return true;
      }
      const started = Date.now();
      const tools = await listMcpTools(server, config);
      appendToolAudit({
        at: Date.now(),
        module: "mcp",
        action: `mcp__${server}__list`,
        decision: "allow",
        reason: "工具列表只读",
        callerFingerprint: callerFingerprint(request),
        durationMs: Date.now() - started
      });
      sendJson(response, 200, { ok: true, data: { server, tools, count: tools.length } });
    } catch (error) {
      sendJson(response, 502, {
        ok: false,
        error: { code: "MCP_LIST_FAILED", message: error instanceof Error ? error.message : "MCP 工具列举失败" }
      });
    }
    return true;
  }

  if (pathname === "/void-mcp/tools/call") {
    const started = Date.now();
    try {
      const body = asRecord(await readJsonBody(request));
      const name = typeof body.name === "string" ? body.name.trim() : "";
      const parsed = parseMcpToolName(name);
      if (!parsed) {
        sendJson(response, 400, {
          ok: false,
          error: { code: "INVALID_REQUEST", message: "工具名必须是 mcp__<server>__<tool> 形态" }
        });
        return true;
      }
      if (isStrictAsk() && body.confirmed !== true) {
        appendToolAudit({
          at: Date.now(),
          module: "mcp",
          action: name,
          decision: "needs-confirmation",
          reason: "MCP 第三方工具默认 ask",
          callerFingerprint: callerFingerprint(request),
          durationMs: Date.now() - started,
          errorCode: "NEEDS_CONFIRMATION"
        });
        sendJson(response, 409, {
          ok: false,
          error: { code: "NEEDS_CONFIRMATION", message: "MCP 工具需确认后重试（body.confirmed=true）" }
        });
        return true;
      }
      const servers = loadMcpServersConfigSync();
      const config = servers[parsed.server];
      if (!config) {
        sendJson(response, 404, { ok: false, error: { code: "MCP_SERVER_NOT_FOUND", message: `未知 MCP server：${parsed.server}` } });
        return true;
      }
      const args = asRecord(body.arguments ?? body.input);
      const result = await callMcpTool(parsed.server, config, parsed.tool, args);
      appendToolAudit({
        at: Date.now(),
        module: "mcp",
        action: name,
        decision: "ask-allow",
        reason: "MCP 第三方工具默认 ask（默认模式记账放行）",
        callerFingerprint: callerFingerprint(request),
        durationMs: Date.now() - started,
        errorCode: result.isError ? "MCP_TOOL_ERROR" : undefined
      });
      sendJson(response, result.isError ? 502 : 200, { ok: !result.isError, data: result.content });
    } catch (error) {
      appendToolAudit({
        at: Date.now(),
        module: "mcp",
        action: "mcp__call",
        decision: "error",
        reason: error instanceof Error ? error.message : "调用失败",
        callerFingerprint: callerFingerprint(request),
        durationMs: Date.now() - started,
        errorCode: "MCP_CALL_FAILED"
      });
      sendJson(response, 502, {
        ok: false,
        error: { code: "MCP_CALL_FAILED", message: error instanceof Error ? error.message : "MCP 工具调用失败" }
      });
    }
    return true;
  }

  sendJson(response, 404, { ok: false, error: { code: "NOT_FOUND", message: "未知 MCP 端点" } });
  return true;
}

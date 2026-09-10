/**
 * P1 MCP 客户端（官方 TS SDK）。
 *
 * 取舍：任务要求 `modelcontextprotocol/typescript-sdk >=0.25`，该包已更名为
 * `@modelcontextprotocol/sdk`（当前 1.30.0，满足 >=0.25 语义），故用新包名。
 * Origin 校验：SDK >=0.25 要求 StreamableHTTP 强制 Origin 头校验；本管理器再加一层：
 * 远程 URL 必须过共享 ssrfGuard（https 公网默认，私网需 VOID_MCP_ALLOW_PRIVATE_HOSTS），
 * 且请求强制携带 Origin（回环 bridge origin），缺失即拒绝。
 *
 * owner：server/mcp/mcpClientManager.ts。
 * 工具命名：mcp__<server>__<tool>（与 toolSafetyPolicy 通配 mcp__* 对接，默认 ask）。
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { assertPublicUrl, readPrivateHostAllowlist } from "../net/ssrfGuard";

export type McpServerKind = "stdio" | "http";

export type McpServerConfig = {
  kind: McpServerKind;
  /** stdio: 启动命令；http: 远端 URL。 */
  command?: string;
  args?: string[];
  url?: string;
  disabled?: boolean;
};

export type McpToolInfo = {
  /** mcp__<server>__<tool> */
  name: string;
  server: string;
  tool: string;
  description?: string;
  inputSchema?: unknown;
};

export type McpCallResult = {
  content: unknown;
  isError?: boolean;
};

const CLIENT_NAME = "void-mcp-client";
const CLIENT_VERSION = "0.2.8";
const TOOL_LIST_TIMEOUT_MS = 15_000;
const TOOL_CALL_TIMEOUT_MS = 60_000;

function readMcpAllowlist(): Set<string> {
  const raw = process.env.VOID_MCP_ALLOWLIST?.trim();
  if (!raw) return new Set();
  return new Set(raw.split(/[\s,;]+/).map((s) => s.trim()).filter(Boolean));
}

function bridgeOriginHeader(): string {
  const port = process.env.VOID_BRIDGE_PORT?.trim() || "17872";
  return `http://127.0.0.1:${port}`;
}

export function toMcpToolName(server: string, tool: string): string {
  const safe = (s: string) => s.trim().replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 64) || "unknown";
  return `mcp__${safe(server)}__${safe(tool)}`;
}

export function parseMcpToolName(name: string): { server: string; tool: string } | null {
  const match = /^mcp__([a-zA-Z0-9_-]{1,64})__([a-zA-Z0-9_-]{1,64})$/.exec(name.trim());
  if (!match) return null;
  return { server: match[1], tool: match[2] };
}

export function loadMcpServersConfigSync(configPath?: string): Record<string, McpServerConfig> {
  const fallback = ".mcp.json";
  const configured = configPath ?? process.env.VOID_MCP_CONFIG?.trim() ?? fallback;
  const resolved = isAbsolute(configured) ? configured : join(process.cwd(), configured);
  if (!existsSync(resolved)) return {};
  const raw = JSON.parse(readFileSync(resolved, "utf8")) as {
    mcpServers?: Record<string, Record<string, unknown>>;
  };
  const servers = raw.mcpServers ?? {};
  const result: Record<string, McpServerConfig> = {};
  for (const [name, entry] of Object.entries(servers)) {
    if (name.startsWith("_") || name.startsWith("example-")) continue;
    if (typeof entry !== "object" || entry === null) continue;
    if ((entry as { disabled?: unknown }).disabled === true) continue;
    if (typeof (entry as { command?: unknown }).command === "string") {
      result[name] = {
        kind: "stdio",
        command: (entry as { command: string }).command,
        args: Array.isArray((entry as { args?: unknown }).args)
          ? ((entry as { args: string[] }).args.filter((x) => typeof x === "string").slice(0, 32))
          : []
      };
    } else if (typeof (entry as { url?: unknown }).url === "string") {
      result[name] = { kind: "http", url: (entry as { url: string }).url };
    }
  }
  return result;
}

async function connectServer(
  serverName: string,
  config: McpServerConfig
): Promise<{ client: Client; close: () => Promise<void> }> {
  const client = new Client({ name: CLIENT_NAME, version: CLIENT_VERSION });
  if (config.kind === "stdio") {
    if (!config.command) throw new Error(`MCP server 缺少 command：${serverName}`);
    const allowlist = readMcpAllowlist();
    if (allowlist.size > 0 && !allowlist.has(serverName)) {
      throw new Error(`MCP server 不在 VOID_MCP_ALLOWLIST 内：${serverName}`);
    }
    const transport = new StdioClientTransport({
      command: config.command,
      args: config.args ?? []
    });
    await client.connect(transport);
    return {
      client,
      close: async () => {
        try {
          await client.close();
        } catch {
          // ignore
        }
        try {
          await transport.close();
        } catch {
          // ignore
        }
      }
    };
  }
  if (!config.url) throw new Error(`MCP server 缺少 url：${serverName}`);
  // 远程：SSRF 守卫 + 强制 Origin（SDK >=0.25 语义的客户端侧对应）。
  const checked = await assertPublicUrl(config.url, {
    allowHttp: false,
    allowlist: readPrivateHostAllowlist("VOID_MCP_ALLOW_PRIVATE_HOSTS")
  });
  const transport = new StreamableHTTPClientTransport(checked, {
    requestInit: {
      headers: { Origin: bridgeOriginHeader() }
    }
  } as unknown as ConstructorParameters<typeof StreamableHTTPClientTransport>[1]);
  await client.connect(transport);
  return {
    client,
    close: async () => {
      try {
        await client.close();
      } catch {
        // ignore
      }
      try {
        await (transport as { close?: () => Promise<void> }).close?.();
      } catch {
        // ignore
      }
    }
  };
}

export async function listMcpTools(
  serverName: string,
  config: McpServerConfig
): Promise<McpToolInfo[]> {
  const { client, close } = await connectServer(serverName, config);
  try {
    const result = await client.listTools(undefined, { timeout: TOOL_LIST_TIMEOUT_MS });
    return (result.tools ?? []).map((tool) => ({
      name: toMcpToolName(serverName, tool.name),
      server: serverName,
      tool: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema
    }));
  } finally {
    await close();
  }
}

export async function callMcpTool(
  serverName: string,
  config: McpServerConfig,
  toolName: string,
  args: Record<string, unknown>
): Promise<McpCallResult> {
  const { client, close } = await connectServer(serverName, config);
  try {
    const result = await client.callTool(
      { name: toolName, arguments: args },
      undefined,
      { timeout: TOOL_CALL_TIMEOUT_MS, resetTimeoutOnProgress: true }
    );
    return { content: result.content, isError: result.isError };
  } finally {
    await close();
  }
}

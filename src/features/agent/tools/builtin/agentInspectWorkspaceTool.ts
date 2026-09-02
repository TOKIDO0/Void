import { listDirectory } from "../../file/fileBridgeClient";
import { throwAsFileToolError } from "../../file/fileToolShared";
import type { ToolDefinition } from "../toolTypes";

export type AgentInspectWorkspaceToolInput = {
  path?: string;
  depth?: number;
  limit?: number;
};

export type AgentInspectWorkspaceToolOutput = {
  status: "ok";
  path: string;
  snapshotAt: number;
  entries: Array<{
    name: string;
    path: string;
    kind: "file" | "directory";
    bytes: number;
    modifiedAt: number;
    extension: string;
  }>;
  total: number;
  truncated: boolean;
  inspectedAt: number;
};

const DEFAULT_WORKSPACE_ROOT = "D:\\AI\\Codex\\void";
const MAX_LIMIT = 120;
const DEFAULT_LIMIT = 60;

export const agentInspectWorkspaceTool: ToolDefinition<AgentInspectWorkspaceToolInput, AgentInspectWorkspaceToolOutput> = {
  name: "agent.inspectWorkspace",
  description: "只读查看工作区/目录的一层文件树快照（含类型、大小、修改时间），用于让模型先看懂项目结构再动手，不读正文。",
  version: "1.0.0",
  riskLevel: "L0",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      path: { type: "string", minLength: 1, maxLength: 1000, description: "绝对路径，缺省为当前工作区根" },
      depth: { type: "number", minimum: 1, maximum: 2, description: "快照深度，1=当前层，2=含子目录一层" },
      limit: { type: "number", minimum: 1, maximum: MAX_LIMIT, description: "最多条目数" }
    }
  },
  outputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["status", "path", "snapshotAt", "entries", "total", "truncated", "inspectedAt"],
    properties: {
      status: { type: "string", enum: ["ok"] },
      path: { type: "string" },
      snapshotAt: { type: "number" },
      entries: {
        type: "array",
        items: {
          type: "object",
          required: ["name", "path", "kind", "bytes", "modifiedAt", "extension"],
          properties: {
            name: { type: "string" },
            path: { type: "string" },
            kind: { type: "string", enum: ["file", "directory"] },
            bytes: { type: "number" },
            modifiedAt: { type: "number" },
            extension: { type: "string" }
          }
        }
      },
      total: { type: "number" },
      truncated: { type: "boolean" },
      inspectedAt: { type: "number" }
    }
  },
  requiredResources: [{ kind: "file", key: "allowed-roots", mode: "shared" }],
  permissions: ["tool.agent.inspectWorkspace"],
  timeoutMs: 10_000,
  cancellable: true,
  idempotency: "safe",
  auditPolicy: { logInputSummary: true, logOutputSummary: true },
  enabled: true,
  maxRetries: 0,
  async execute(input, context) {
    const path = (input.path?.trim() || DEFAULT_WORKSPACE_ROOT).trim();
    const limit = Math.min(Math.max(input.limit ?? DEFAULT_LIMIT, 1), MAX_LIMIT);
    const depth = Math.min(Math.max(input.depth ?? 1, 1), 2);
    try {
      // depth 1: 单层；depth 2: 聚合子目录一层（前端聚合，避免服务端改动）
      const root = await listDirectory({ path }, context.signal);
      const joinPath = (base: string, name: string) => (base.endsWith("\\") || base.endsWith("/") ? `${base}${name}` : `${base}\\${name}`);
      const extOf = (name: string) => {
        const idx = name.lastIndexOf(".");
        return idx > 0 ? name.slice(idx).toLowerCase() : "";
      };
      let entries = root.entries.map((e) => ({
        name: e.name,
        path: joinPath(root.path ?? path, e.name),
        kind: e.kind as "file" | "directory",
        bytes: e.bytes ?? 0,
        modifiedAt: e.modifiedAt,
        extension: extOf(e.name)
      }));
      if (depth === 2) {
        const dirs = entries.filter((e) => e.kind === "directory").slice(0, 8);
        for (const dir of dirs) {
          try {
            const sub = await listDirectory({ path: dir.path }, context.signal);
            for (const se of sub.entries.slice(0, 12)) {
              entries.push({
                name: `${dir.name}/${se.name}`,
                path: joinPath(dir.path, se.name),
                kind: se.kind as "file" | "directory",
                bytes: (se as { bytes?: number }).bytes ?? 0,
                modifiedAt: se.modifiedAt,
                extension: extOf(se.name)
              });
              if (entries.length >= limit) break;
            }
            if (entries.length >= limit) break;
          } catch {}
        }
      }
      // 最近变更优先（辅助模型快速定位）
      entries.sort((a, b) => b.modifiedAt - a.modifiedAt);
      const truncated = entries.length > limit;
      const sliced = truncated ? entries.slice(0, limit) : entries;
      return {
        status: "ok",
        path: root.path ?? path,
        snapshotAt: Date.now(),
        entries: sliced,
        total: sliced.length,
        truncated,
        inspectedAt: Date.now()
      };
    } catch (error) {
      throwAsFileToolError(error);
    }
  }
};

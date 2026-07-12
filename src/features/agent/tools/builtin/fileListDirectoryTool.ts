import { listDirectory } from "../../file/fileBridgeClient";
import type { FileListDirectoryData } from "../../file/fileBridgeTypes";
import { FILE_STATIC_RESOURCES, throwAsFileToolError } from "../../file/fileToolShared";
import type { ToolDefinition } from "../toolTypes";

export type FileListDirectoryToolInput = { path: string };
export type FileListDirectoryToolOutput = FileListDirectoryData;

export const fileListDirectoryTool: ToolDefinition<
  FileListDirectoryToolInput,
  FileListDirectoryToolOutput
> = {
  name: "file.listDirectory",
  description: "列出允许根内指定目录的当前一层，返回名称、类型、大小和修改时间；不会递归扫描。",
  version: "1.0.0",
  riskLevel: "L0",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["path"],
    properties: { path: { type: "string", minLength: 1, maxLength: 1000 } }
  },
  outputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["path", "entries", "count", "truncated"],
    properties: {
      path: { type: "string" },
      entries: {
        type: "array",
        maxItems: 200,
        items: {
          type: "object",
          additionalProperties: false,
          required: ["name", "kind", "modifiedAt"],
          properties: {
            name: { type: "string" },
            kind: { type: "string", enum: ["file", "directory"] },
            bytes: { type: "number", minimum: 0 },
            modifiedAt: { type: "number" }
          }
        }
      },
      count: { type: "number", minimum: 0, maximum: 200 },
      truncated: { type: "boolean" }
    }
  },
  requiredResources: FILE_STATIC_RESOURCES,
  permissions: ["tool.file.listDirectory"],
  timeoutMs: 10_000,
  cancellable: true,
  idempotency: "safe",
  auditPolicy: { logInputSummary: true, logOutputSummary: true },
  enabled: true,
  maxRetries: 0,
  async execute(input, context) {
    try {
      return await listDirectory({ path: input.path.trim() }, context.signal);
    } catch (error) {
      throwAsFileToolError(error);
    }
  }
};

import { createDirectory } from "../../file/fileBridgeClient";
import type { FileCreateDirectoryData } from "../../file/fileBridgeTypes";
import { FILE_STATIC_RESOURCES, throwAsFileToolError } from "../../file/fileToolShared";
import type { ToolDefinition } from "../toolTypes";

export type FileCreateDirectoryToolInput = { path: string };
export type FileCreateDirectoryToolOutput = FileCreateDirectoryData;

export const fileCreateDirectoryTool: ToolDefinition<
  FileCreateDirectoryToolInput,
  FileCreateDirectoryToolOutput
> = {
  name: "file.createDirectory",
  description: "在允许根内创建一个明确目录；父目录必须已存在，不递归创建深层结构。",
  version: "1.0.0",
  riskLevel: "L2",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["path"],
    properties: { path: { type: "string", minLength: 1, maxLength: 1000 } }
  },
  outputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["path", "created", "createdAt"],
    properties: {
      path: { type: "string" },
      created: { type: "boolean" },
      createdAt: { type: "number" }
    }
  },
  requiredResources: FILE_STATIC_RESOURCES,
  permissions: ["tool.file.createDirectory"],
  timeoutMs: 10_000,
  cancellable: true,
  idempotency: "unsafe",
  auditPolicy: { logInputSummary: true, logOutputSummary: true },
  enabled: true,
  maxRetries: 0,
  async execute(input, context) {
    try {
      return await createDirectory({ path: input.path.trim() }, context.signal);
    } catch (error) {
      throwAsFileToolError(error);
    }
  }
};

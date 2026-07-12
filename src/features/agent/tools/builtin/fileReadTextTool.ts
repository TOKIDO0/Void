import { readText } from "../../file/fileBridgeClient";
import type { FileReadTextData } from "../../file/fileBridgeTypes";
import { FILE_STATIC_RESOURCES, throwAsFileToolError } from "../../file/fileToolShared";
import type { ToolDefinition } from "../toolTypes";

export type FileReadTextToolInput = { path: string };
export type FileReadTextToolOutput = FileReadTextData;

export const fileReadTextTool: ToolDefinition<FileReadTextToolInput, FileReadTextToolOutput> = {
  name: "file.readText",
  description: "读取允许根内的严格 UTF-8 小型文本文件；拒绝二进制、非法 UTF-8 和超限文件。",
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
    required: ["path", "fileName", "content", "bytes", "characters", "truncated"],
    properties: {
      path: { type: "string" },
      fileName: { type: "string" },
      content: { type: "string", maxLength: 200000 },
      bytes: { type: "number", minimum: 0, maximum: 1048576 },
      characters: { type: "number", minimum: 0, maximum: 200000 },
      truncated: { type: "boolean" }
    }
  },
  requiredResources: FILE_STATIC_RESOURCES,
  permissions: ["tool.file.readText"],
  timeoutMs: 10_000,
  cancellable: true,
  idempotency: "safe",
  auditPolicy: {
    logInputSummary: true,
    logOutputSummary: false,
    redactOutputKeys: ["content"]
  },
  enabled: true,
  maxRetries: 0,
  async execute(input, context) {
    try {
      return await readText({ path: input.path.trim() }, context.signal);
    } catch (error) {
      throwAsFileToolError(error);
    }
  }
};

import { readText } from "../../file/fileBridgeClient";
import type { FileReadTextData } from "../../file/fileBridgeTypes";
import { FILE_STATIC_RESOURCES, throwAsFileToolError } from "../../file/fileToolShared";
import type { ToolDefinition } from "../toolTypes";

export type FileReadTextToolInput = { path: string };
export type FileReadTextToolOutput = FileReadTextData;

export const fileReadTextTool: ToolDefinition<FileReadTextToolInput, FileReadTextToolOutput> = {
  name: "file.readText",
  description: "读取允许根内的小型文本/PDF/DOCX 内容；文本要求严格 UTF-8，PDF/DOCX 只抽取可见文字层；拒绝二进制、非法 UTF-8、扫描件/损坏文档和超限文件。",
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
      bytes: { type: "number", minimum: 0, maximum: 12582912 },
      characters: { type: "number", minimum: 0, maximum: 200000 },
      truncated: { type: "boolean" },
      sourceKind: { type: "string", enum: ["text", "pdf", "docx"] }
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

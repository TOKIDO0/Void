import { writeText } from "../../file/fileBridgeClient";
import type { FileWriteTextData, TextWriteConflictPolicy } from "../../file/fileBridgeTypes";
import { FILE_STATIC_RESOURCES, throwAsFileToolError } from "../../file/fileToolShared";
import { createToolError } from "../toolErrors";
import type { ToolDefinition } from "../toolTypes";

export type FileWriteTextToolInput = {
  /** 绝对路径；与 fileName 二选一。 */
  path?: string;
  /** 仅文件名；缺省保存到 D:\AI\void-runtime\downloads。 */
  fileName?: string;
  content: string;
  conflictPolicy?: TextWriteConflictPolicy;
};
export type FileWriteTextToolOutput = FileWriteTextData;

export const fileWriteTextTool: ToolDefinition<
  FileWriteTextToolInput,
  FileWriteTextToolOutput
> = {
  name: "file.writeText",
  description:
    "把用户明确给出的文本写入允许根内的常见文本文件。提供绝对 path，或只提供普通 fileName（会保存到 D:\\AI\\void-runtime\\downloads）。默认 conflictPolicy=refuse，目标已存在则失败；可选 rename 自动改名或 overwrite 覆盖。拒绝二进制/超大内容/非文本扩展名，不删除文件。",
  version: "1.0.0",
  riskLevel: "L2",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["content"],
    anyOf: [
      { type: "object", required: ["path"] },
      { type: "object", required: ["fileName"] }
    ],
    properties: {
      path: { type: "string", minLength: 1, maxLength: 1000 },
      fileName: { type: "string", minLength: 1, maxLength: 240 },
      content: { type: "string", maxLength: 200000 },
      conflictPolicy: { type: "string", enum: ["refuse", "overwrite", "rename"] }
    }
  },
  outputSchema: {
    type: "object",
    additionalProperties: false,
    required: [
      "path",
      "fileName",
      "bytes",
      "characters",
      "conflictPolicy",
      "created",
      "overwritten",
      "renamedForConflict",
      "writtenAt"
    ],
    properties: {
      path: { type: "string" },
      fileName: { type: "string" },
      bytes: { type: "number", minimum: 0 },
      characters: { type: "number", minimum: 0 },
      conflictPolicy: { type: "string", enum: ["refuse", "overwrite", "rename"] },
      created: { type: "boolean" },
      overwritten: { type: "boolean" },
      renamedForConflict: { type: "boolean" },
      writtenAt: { type: "number" }
    }
  },
  requiredResources: FILE_STATIC_RESOURCES,
  permissions: ["tool.file.writeText"],
  timeoutMs: 10_000,
  cancellable: true,
  idempotency: "unsafe",
  auditPolicy: {
    logInputSummary: true,
    logOutputSummary: true,
    redactInputKeys: ["content"]
  },
  enabled: true,
  maxRetries: 0,
  async execute(input, context) {
    const path = input.path?.trim();
    const fileName = input.fileName?.trim();
    if (!path && !fileName) {
      throw createToolError("SCHEMA_INVALID", "file.writeText 缺少 path 或 fileName", undefined, false);
    }
    if (path && fileName) {
      throw createToolError("SCHEMA_INVALID", "file.writeText 的 path 与 fileName 只能提供一个", undefined, false);
    }

    try {
      return await writeText({
        path,
        fileName,
        content: input.content,
        conflictPolicy: input.conflictPolicy ?? "refuse"
      }, context.signal);
    } catch (error) {
      throwAsFileToolError(error);
    }
  }
};

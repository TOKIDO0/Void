import { editText } from "../../file/fileBridgeClient";
import type { FileEditTextData } from "../../file/fileBridgeTypes";
import { FILE_STATIC_RESOURCES, throwAsFileToolError } from "../../file/fileToolShared";
import { createToolError } from "../toolErrors";
import type { ToolDefinition } from "../toolTypes";

export type FileEditTextToolInput = {
  /** 允许根内的绝对文件路径。 */
  path: string;
  /** 原文片段（必须在文件中恰好出现一次，否则拒绝）。 */
  oldText: string;
  /** 替换后的新文本。 */
  newText: string;
};
export type FileEditTextToolOutput = FileEditTextData;

export const fileEditTextTool: ToolDefinition<
  FileEditTextToolInput,
  FileEditTextToolOutput
> = {
  name: "file.editText",
  description:
    "行级编辑允许根内的文本文件：oldText 必须在文件中恰好出现一次，命中则替换为 newText。0 次报 EDIT_TARGET_NOT_FOUND（先 readText 确认原文），多次报 EDIT_AMBIGUOUS（加长上下文使之唯一）。只改一处，不做模糊匹配；拒绝二进制/超大文件/非文本扩展名。",
  version: "1.0.0",
  riskLevel: "L2",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["path", "oldText", "newText"],
    properties: {
      path: { type: "string", minLength: 1, maxLength: 1000 },
      oldText: { type: "string", minLength: 1, maxLength: 20000 },
      newText: { type: "string", maxLength: 200000 }
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
      "replacements",
      "editedAt"
    ],
    properties: {
      path: { type: "string" },
      fileName: { type: "string" },
      bytes: { type: "number", minimum: 0 },
      characters: { type: "number", minimum: 0 },
      replacements: { type: "number", minimum: 1, maximum: 1 },
      editedAt: { type: "number" }
    }
  },
  requiredResources: FILE_STATIC_RESOURCES,
  permissions: ["tool.file.editText"],
  timeoutMs: 10_000,
  cancellable: true,
  idempotency: "unsafe",
  auditPolicy: {
    logInputSummary: true,
    logOutputSummary: true,
    redactInputKeys: ["oldText", "newText"]
  },
  enabled: true,
  maxRetries: 0,
  async execute(input, context) {
    const path = input.path?.trim();
    if (!path) {
      throw createToolError("SCHEMA_INVALID", "file.editText 缺少 path", undefined, false);
    }
    if (!input.oldText) {
      throw createToolError("SCHEMA_INVALID", "file.editText 缺少 oldText", undefined, false);
    }
    if (input.newText === undefined) {
      throw createToolError("SCHEMA_INVALID", "file.editText 缺少 newText", undefined, false);
    }

    try {
      return await editText({
        path,
        oldText: input.oldText,
        newText: input.newText
      }, context.signal);
    } catch (error) {
      throwAsFileToolError(error);
    }
  }
};

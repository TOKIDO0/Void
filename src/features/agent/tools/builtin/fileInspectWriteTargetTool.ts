import { inspectWriteTarget } from "../../file/fileBridgeClient";
import type {
  FileInspectWriteTargetData,
  TextWriteConflictPolicy
} from "../../file/fileBridgeTypes";
import {
  FILE_STATIC_RESOURCES,
  throwAsFileToolError
} from "../../file/fileToolShared";
import { createToolError } from "../toolErrors";
import type { ToolDefinition } from "../toolTypes";

export type FileInspectWriteTargetToolInput = {
  /** 绝对路径；与 fileName 二选一。 */
  path?: string;
  /** 仅文件名；缺省检查 D:\AI\void-runtime\downloads 下的目标。 */
  fileName?: string;
  conflictPolicy?: TextWriteConflictPolicy;
};

export type FileInspectWriteTargetToolOutput = FileInspectWriteTargetData;

export const fileInspectWriteTargetTool: ToolDefinition<
  FileInspectWriteTargetToolInput,
  FileInspectWriteTargetToolOutput
> = {
  name: "file.inspectWriteTarget",
  description:
    "只读预检 file.writeText 的目标路径或默认目录 fileName：检查允许根、文本扩展名、父目录、目标是否存在、冲突策略会创建/覆盖/改名还是阻塞，以及真实写入是否会需要确认。不传正文、不读取文件内容、不写入、不改名。",
  version: "1.0.0",
  riskLevel: "L0",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    anyOf: [
      { type: "object", required: ["path"] },
      { type: "object", required: ["fileName"] }
    ],
    properties: {
      path: { type: "string", minLength: 1, maxLength: 1000 },
      fileName: { type: "string", minLength: 1, maxLength: 240 },
      conflictPolicy: { type: "string", enum: ["refuse", "overwrite", "rename"] }
    }
  },
  outputSchema: {
    type: "object",
    additionalProperties: false,
    required: [
      "status",
      "path",
      "fileName",
      "parentPath",
      "extension",
      "conflictPolicy",
      "targetExists",
      "targetKind",
      "resolvedPath",
      "resolvedFileName",
      "wouldCreate",
      "wouldOverwrite",
      "wouldRename",
      "writable",
      "requiresConfirmation",
      "inspectedAt"
    ],
    properties: {
      status: { type: "string", enum: ["ok"] },
      path: { type: "string" },
      fileName: { type: "string" },
      parentPath: { type: "string" },
      extension: { type: "string", maxLength: 32 },
      conflictPolicy: { type: "string", enum: ["refuse", "overwrite", "rename"] },
      targetExists: { type: "boolean" },
      targetKind: { type: "string", enum: ["file", "directory", "other", "missing"] },
      targetBytes: { type: "number", minimum: 0 },
      resolvedPath: { type: "string" },
      resolvedFileName: { type: "string" },
      wouldCreate: { type: "boolean" },
      wouldOverwrite: { type: "boolean" },
      wouldRename: { type: "boolean" },
      writable: { type: "boolean" },
      blockingCode: { type: "string", enum: ["DESTINATION_EXISTS", "INVALID_REQUEST"] },
      blockingReason: { type: "string", maxLength: 260 },
      requiresConfirmation: { type: "boolean" },
      inspectedAt: { type: "number" }
    }
  },
  requiredResources: FILE_STATIC_RESOURCES,
  permissions: ["tool.file.inspectWriteTarget"],
  timeoutMs: 10_000,
  cancellable: true,
  idempotency: "safe",
  auditPolicy: {
    logInputSummary: true,
    logOutputSummary: true
  },
  enabled: true,
  maxRetries: 0,
  async execute(input, context) {
    const path = input.path?.trim();
    const fileName = input.fileName?.trim();
    if (!path && !fileName) {
      throw createToolError("SCHEMA_INVALID", "file.inspectWriteTarget 缺少 path 或 fileName", undefined, false);
    }
    if (path && fileName) {
      throw createToolError("SCHEMA_INVALID", "file.inspectWriteTarget 的 path 与 fileName 只能提供一个", undefined, false);
    }

    try {
      return await inspectWriteTarget(
        {
          path,
          fileName,
          conflictPolicy: input.conflictPolicy ?? "refuse"
        },
        context.signal
      );
    } catch (error) {
      throwAsFileToolError(error);
    }
  }
};

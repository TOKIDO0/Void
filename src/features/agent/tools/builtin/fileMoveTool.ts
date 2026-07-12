import { moveFile } from "../../file/fileBridgeClient";
import type { FileMoveData, MoveConflictPolicy } from "../../file/fileBridgeTypes";
import { FILE_STATIC_RESOURCES, throwAsFileToolError } from "../../file/fileToolShared";
import type { ToolDefinition } from "../toolTypes";

export type FileMoveToolInput = {
  sourcePath: string;
  destinationPath: string;
  conflictPolicy?: MoveConflictPolicy;
};
export type FileMoveToolOutput = FileMoveData;

export const fileMoveTool: ToolDefinition<FileMoveToolInput, FileMoveToolOutput> = {
  name: "file.move",
  description: "在同一允许根/同一磁盘内原子移动或重命名；冲突默认 refuse，可选 rename，绝不覆盖。下载后整理：把 placeDownload 的 finalPath 移入 createDirectory 新建的子目录。",
  version: "1.0.0",
  riskLevel: "L2",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["sourcePath", "destinationPath"],
    properties: {
      sourcePath: { type: "string", minLength: 1, maxLength: 1000 },
      destinationPath: { type: "string", minLength: 1, maxLength: 1000 },
      conflictPolicy: { type: "string", enum: ["refuse", "rename"] }
    }
  },
  outputSchema: {
    type: "object",
    additionalProperties: false,
    required: [
      "sourcePath",
      "destinationPath",
      "mediaKind",
      "bytes",
      "conflictPolicy",
      "renamedForConflict",
      "movedAt"
    ],
    properties: {
      sourcePath: { type: "string" },
      destinationPath: { type: "string" },
      mediaKind: { type: "string" },
      bytes: { type: "number", minimum: 0 },
      conflictPolicy: { type: "string", enum: ["refuse", "rename"] },
      renamedForConflict: { type: "boolean" },
      movedAt: { type: "number" }
    }
  },
  requiredResources: FILE_STATIC_RESOURCES,
  permissions: ["tool.file.move"],
  timeoutMs: 10_000,
  cancellable: true,
  idempotency: "unsafe",
  auditPolicy: { logInputSummary: true, logOutputSummary: true },
  enabled: true,
  maxRetries: 0,
  async execute(input, context) {
    try {
      return await moveFile({
        sourcePath: input.sourcePath.trim(),
        destinationPath: input.destinationPath.trim(),
        conflictPolicy: input.conflictPolicy ?? "refuse"
      }, context.signal);
    } catch (error) {
      throwAsFileToolError(error);
    }
  }
};

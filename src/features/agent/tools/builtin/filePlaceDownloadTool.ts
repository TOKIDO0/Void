// L2：用户确认目标目录与覆盖策略后，把临时文件移动到最终目录。

import { placeDownload } from "../../file/fileBridgeClient";
import type {
  FilePlaceDownloadData,
  OverwritePolicy
} from "../../file/fileBridgeTypes";
import {
  FILE_STATIC_RESOURCES,
  resolveTaskIdFromInput,
  throwAsFileToolError
} from "../../file/fileToolShared";
import type { ToolDefinition } from "../toolTypes";

export type FilePlaceDownloadToolInput = {
  tempPath: string;
  destinationDirectory: string;
  fileName?: string;
  overwritePolicy: OverwritePolicy;
  taskId?: string;
};

export type FilePlaceDownloadToolOutput = FilePlaceDownloadData;

export const filePlaceDownloadTool: ToolDefinition<
  FilePlaceDownloadToolInput,
  FilePlaceDownloadToolOutput
> = {
  name: "file.placeDownload",
  description:
    "在用户确认目标目录与覆盖策略后，将临时下载文件移动到白名单最终目录。返回 finalPath/fileName/bytes/mediaKind。默认不猜目录；目录不在白名单会 PATH_NOT_ALLOWED。",
  version: "1.1.0",
  riskLevel: "L2",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["tempPath", "destinationDirectory", "overwritePolicy"],
    properties: {
      tempPath: {
        type: "string",
        minLength: 1,
        maxLength: 1000
      },
      destinationDirectory: {
        type: "string",
        minLength: 1,
        maxLength: 1000,
        description: "最终目录绝对路径（须在白名单内）"
      },
      fileName: {
        type: "string",
        minLength: 1,
        maxLength: 180
      },
      overwritePolicy: {
        type: "string",
        enum: ["refuse", "overwrite", "rename"]
      },
      taskId: {
        type: "string",
        minLength: 1,
        maxLength: 120
      }
    }
  },
  outputSchema: {
    type: "object",
    additionalProperties: false,
    required: [
      "taskId",
      "tempPath",
      "finalPath",
      "fileName",
      "bytes",
      "overwritePolicy",
      "renamed",
      "movedAt"
    ],
    properties: {
      taskId: { type: "string" },
      tempPath: { type: "string" },
      finalPath: { type: "string" },
      fileName: { type: "string" },
      bytes: { type: "number", minimum: 0 },
      mediaKind: { type: "string" },
      overwritePolicy: { type: "string", enum: ["refuse", "overwrite", "rename"] },
      renamed: { type: "boolean" },
      movedAt: { type: "number" }
    }
  },
  requiredResources: FILE_STATIC_RESOURCES,
  permissions: ["tool.file.placeDownload"],
  timeoutMs: 30_000,
  cancellable: true,
  idempotency: "unsafe",
  auditPolicy: {
    logInputSummary: true,
    logOutputSummary: true,
    redactInputKeys: ["cookie", "password", "token"],
    redactOutputKeys: ["cookie", "password", "token"]
  },
  enabled: true,
  maxRetries: 0,
  async execute(input, context) {
    const taskId = resolveTaskIdFromInput(input, context);
    try {
      return await placeDownload(
        {
          taskId,
          tempPath: input.tempPath.trim(),
          destinationDirectory: input.destinationDirectory.trim(),
          fileName: input.fileName?.trim(),
          overwritePolicy: input.overwritePolicy
        },
        context.signal
      );
    } catch (error) {
      throwAsFileToolError(error);
    }
  }
};

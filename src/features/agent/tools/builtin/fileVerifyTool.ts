// L0：校验文件存在、大小、媒体类型（结构化汇报）。

import { verifyFile } from "../../file/fileBridgeClient";
import type { FileVerifyData } from "../../file/fileBridgeTypes";
import {
  FILE_STATIC_RESOURCES,
  throwAsFileToolError
} from "../../file/fileToolShared";
import type { ToolDefinition } from "../toolTypes";

export type FileVerifyToolInput = {
  path: string;
};

export type FileVerifyToolOutput = FileVerifyData;

export const fileVerifyTool: ToolDefinition<
  FileVerifyToolInput,
  FileVerifyToolOutput
> = {
  name: "file.verify",
  description:
    "校验本地文件是否存在，并返回大小(bytes)、扩展名与媒体类型猜测。只读。",
  version: "1.0.0",
  riskLevel: "L0",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["path"],
    properties: {
      path: {
        type: "string",
        minLength: 1,
        maxLength: 1000
      }
    }
  },
  requiredResources: FILE_STATIC_RESOURCES,
  permissions: ["tool.file.verify"],
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
    try {
      return await verifyFile({ path: input.path.trim() }, context.signal);
    } catch (error) {
      throwAsFileToolError(error);
    }
  }
};

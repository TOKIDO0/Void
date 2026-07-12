// L2：下载到任务临时目录（不直接写最终目录）。

import {
  downloadToTemp
} from "../../file/fileBridgeClient";
import type { FileDownloadToTempData } from "../../file/fileBridgeTypes";
import {
  FILE_STATIC_RESOURCES,
  resolveTaskIdFromInput,
  throwAsFileToolError
} from "../../file/fileToolShared";
import type { ToolDefinition } from "../toolTypes";

export type FileDownloadToTempToolInput = {
  url: string;
  taskId?: string;
  suggestedFileName?: string;
};

export type FileDownloadToTempToolOutput = FileDownloadToTempData;

export const fileDownloadToTempTool: ToolDefinition<
  FileDownloadToTempToolInput,
  FileDownloadToTempToolOutput
> = {
  name: "file.downloadToTemp",
  description:
    "将任意 http(s) 文件直链下载到任务独立临时目录（通用文件能力，非某类安装包专用）。URL 必须是可直接 GET 的文件地址（常见 .exe/.msi/.zip 等），不是官网 HTML 页；不会自动点击网页下载按钮。返回 fileName/bytes/mediaKind/tempPath；不会写入最终目录，后续需 file.placeDownload 并经用户确认。",
  version: "1.1.0",
  riskLevel: "L2",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["url"],
    properties: {
      url: {
        type: "string",
        minLength: 8,
        maxLength: 2000,
        description: "下载地址"
      },
      taskId: {
        type: "string",
        minLength: 1,
        maxLength: 120
      },
      suggestedFileName: {
        type: "string",
        minLength: 1,
        maxLength: 180
      }
    }
  },
  outputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["taskId", "url", "tempPath", "fileName", "bytes", "downloadedAt"],
    properties: {
      taskId: { type: "string" },
      url: { type: "string" },
      tempPath: { type: "string" },
      fileName: { type: "string" },
      bytes: { type: "number", minimum: 0 },
      contentType: { type: "string" },
      mediaKind: { type: "string" },
      downloadedAt: { type: "number" }
    }
  },
  requiredResources: FILE_STATIC_RESOURCES,
  permissions: ["tool.file.downloadToTemp"],
  timeoutMs: 120_000,
  cancellable: true,
  idempotency: "unknown",
  auditPolicy: {
    logInputSummary: true,
    logOutputSummary: true,
    redactInputKeys: ["cookie", "password", "token", "authorization"],
    redactOutputKeys: ["cookie", "password", "token"]
  },
  enabled: true,
  maxRetries: 1,
  async execute(input, context) {
    const taskId = resolveTaskIdFromInput(input, context);
    try {
      return await downloadToTemp(
        {
          taskId,
          url: input.url.trim(),
          suggestedFileName: input.suggestedFileName?.trim()
        },
        context.signal
      );
    } catch (error) {
      throwAsFileToolError(error);
    }
  }
};

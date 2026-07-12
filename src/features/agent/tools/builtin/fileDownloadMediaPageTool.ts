// L2：从受支持媒体页（首期仅 B 站视频页）下载到任务临时目录。
// 固定走本机 yt-dlp，不是任意 Shell，也不替代 file.downloadToTemp 直链下载。

import { downloadMediaPage } from "../../file/fileBridgeClient";
import type { FileDownloadMediaPageData } from "../../file/fileBridgeTypes";
import {
  FILE_STATIC_RESOURCES,
  resolveTaskIdFromInput,
  throwAsFileToolError
} from "../../file/fileToolShared";
import type { ToolDefinition } from "../toolTypes";

export type FileDownloadMediaPageToolInput = {
  pageUrl: string;
  taskId?: string;
  suggestedFileName?: string;
};

export type FileDownloadMediaPageToolOutput = FileDownloadMediaPageData;

export const fileDownloadMediaPageTool: ToolDefinition<
  FileDownloadMediaPageToolInput,
  FileDownloadMediaPageToolOutput
> = {
  name: "file.downloadMediaPage",
  description:
    "从受支持的媒体页下载视频到任务临时目录（首期仅 B 站 https://www.bilibili.com/video/BVxxx 或 av 号页）。依赖本机 yt-dlp（PATH / VOID_YTDLP_PATH / D:\\\\AI\\\\void-runtime\\\\bin\\\\yt-dlp.exe）。返回 tempPath/fileName/bytes/mediaKind；不会写入最终目录，后续需用户确认后 file.placeDownload。不要用本工具下载普通安装包直链——直链请用 file.downloadToTemp。",
  version: "1.0.0",
  riskLevel: "L2",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["pageUrl"],
    properties: {
      pageUrl: {
        type: "string",
        minLength: 12,
        maxLength: 500,
        description: "B 站视频页 URL，例如 https://www.bilibili.com/video/BVxxxx"
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
    required: [
      "taskId",
      "pageUrl",
      "site",
      "tempPath",
      "fileName",
      "bytes",
      "downloader",
      "downloadedAt"
    ],
    properties: {
      taskId: { type: "string" },
      pageUrl: { type: "string" },
      site: { type: "string", enum: ["bilibili"] },
      videoId: { type: "string" },
      tempPath: { type: "string" },
      fileName: { type: "string" },
      bytes: { type: "number", minimum: 0 },
      mediaKind: { type: "string" },
      downloader: { type: "string", enum: ["yt-dlp"] },
      downloadedAt: { type: "number" }
    }
  },
  requiredResources: FILE_STATIC_RESOURCES,
  permissions: ["tool.file.downloadMediaPage"],
  timeoutMs: 15 * 60_000,
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
      return await downloadMediaPage(
        {
          taskId,
          pageUrl: input.pageUrl.trim(),
          suggestedFileName: input.suggestedFileName?.trim()
        },
        context.signal
      );
    } catch (error) {
      throwAsFileToolError(error);
    }
  }
};

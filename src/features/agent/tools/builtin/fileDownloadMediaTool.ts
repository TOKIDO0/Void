// 通用媒体下载（阶段 AE-P1）：任意 https URL 走 yt-dlp，支持音频提取。

import { downloadMedia } from "../../file/fileBridgeClient";
import type { FileDownloadMediaPageData } from "../../file/fileBridgeTypes";
import { FILE_STATIC_RESOURCES, throwAsFileToolError } from "../../file/fileToolShared";
import { createToolError } from "../toolErrors";
import type { ToolDefinition } from "../toolTypes";

export type FileDownloadMediaToolInput = {
  url: string;
  extractAudio?: boolean;
  fileName?: string;
};

export type FileDownloadMediaToolOutput = FileDownloadMediaPageData;

export const fileDownloadMediaTool: ToolDefinition<FileDownloadMediaToolInput, FileDownloadMediaToolOutput> = {
  name: "file.downloadMedia",
  description:
    "下载任意网页媒体（视频/音频/直播回放等）到临时目录：任意 https URL 走 yt-dlp，站点支持性由 yt-dlp 决定；extractAudio=true 时仅提取音频为 mp3。成功后用 file.placeDownload 落盘。内网/本地地址会被拒绝。",
  version: "1.0.0",
  riskLevel: "L2",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["url"],
    properties: {
      url: { type: "string", minLength: 8, maxLength: 2000 },
      extractAudio: { type: "boolean" },
      fileName: { type: "string", minLength: 1, maxLength: 180 }
    }
  },
  outputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["taskId", "pageUrl", "site", "tempPath", "fileName", "bytes", "mediaKind", "downloader", "downloadedAt"],
    properties: {
      taskId: { type: "string" },
      pageUrl: { type: "string" },
      site: { type: "string" },
      videoId: { type: "string" },
      tempPath: { type: "string" },
      fileName: { type: "string" },
      bytes: { type: "number", minimum: 0 },
      mediaKind: { type: "string" },
      downloader: { type: "string" },
      downloadedAt: { type: "number" }
    }
  },
  requiredResources: FILE_STATIC_RESOURCES,
  permissions: ["tool.file.downloadMedia"],
  timeoutMs: 300_000,
  cancellable: true,
  idempotency: "unsafe",
  auditPolicy: { logInputSummary: true, logOutputSummary: true },
  enabled: true,
  maxRetries: 0,
  async execute(input, context) {
    const url = input.url?.trim();
    if (!url) throw createToolError("SCHEMA_INVALID", "file.downloadMedia 缺少 url", undefined, false);
    try {
      return await downloadMedia({ url, extractAudio: input.extractAudio, fileName: input.fileName }, context.signal);
    } catch (error) {
      throwAsFileToolError(error);
    }
  }
};

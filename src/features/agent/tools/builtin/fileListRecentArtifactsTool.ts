import { listRecentArtifacts } from "../../file/fileBridgeClient";
import type { FileListRecentArtifactsData } from "../../file/fileBridgeTypes";
import {
  FILE_STATIC_RESOURCES,
  throwAsFileToolError
} from "../../file/fileToolShared";
import type { ToolDefinition } from "../toolTypes";

export type FileListRecentArtifactsToolInput = {
  /** 最多返回多少条最近产物；缺省 20，服务端上限 50。 */
  limit?: number;
};

export type FileListRecentArtifactsToolOutput = FileListRecentArtifactsData;

export const fileListRecentArtifactsTool: ToolDefinition<
  FileListRecentArtifactsToolInput,
  FileListRecentArtifactsToolOutput
> = {
  name: "file.listRecentArtifacts",
  description:
    "只读列出 VOID 默认下载/保存目录 D:\\AI\\void-runtime\\downloads 的最近产物，按修改时间倒序返回文件名、路径、大小、类型和修改时间。不能指定任意路径，不读取文件正文，不递归扫描。适合回答“刚才保存/下载的文件在哪”“最近生成了哪些文件”。",
  version: "1.0.0",
  riskLevel: "L0",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      limit: { type: "number", minimum: 1, maximum: 50 }
    }
  },
  outputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["rootPath", "entries", "count", "limit", "truncated", "listedAt"],
    properties: {
      rootPath: { type: "string" },
      entries: {
        type: "array",
        maxItems: 50,
        items: {
          type: "object",
          additionalProperties: false,
          required: ["path", "fileName", "kind", "mediaKind", "modifiedAt"],
          properties: {
            path: { type: "string" },
            fileName: { type: "string" },
            kind: { type: "string", enum: ["file", "directory"] },
            bytes: { type: "number", minimum: 0 },
            extension: { type: "string", maxLength: 32 },
            mediaKind: {
              type: "string",
              enum: ["image", "audio", "video", "document", "archive", "text", "binary", "unknown"]
            },
            modifiedAt: { type: "number" }
          }
        }
      },
      count: { type: "number", minimum: 0, maximum: 50 },
      limit: { type: "number", minimum: 1, maximum: 50 },
      truncated: { type: "boolean" },
      listedAt: { type: "number" }
    }
  },
  requiredResources: FILE_STATIC_RESOURCES,
  permissions: ["tool.file.listRecentArtifacts"],
  timeoutMs: 10_000,
  cancellable: true,
  idempotency: "safe",
  auditPolicy: { logInputSummary: true, logOutputSummary: true },
  enabled: true,
  maxRetries: 0,
  async execute(input, context) {
    try {
      return await listRecentArtifacts({ limit: input.limit }, context.signal);
    } catch (error) {
      throwAsFileToolError(error);
    }
  }
};

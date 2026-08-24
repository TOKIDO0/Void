import { findByName } from "../../file/fileBridgeClient";
import type {
  FileFindByNameData,
  FileFindByNameRequest
} from "../../file/fileBridgeTypes";
import { FILE_STATIC_RESOURCES, throwAsFileToolError } from "../../file/fileToolShared";
import type { ToolDefinition } from "../toolTypes";

export type FileFindByNameToolInput = FileFindByNameRequest;
export type FileFindByNameToolOutput = FileFindByNameData;

export const fileFindByNameTool: ToolDefinition<
  FileFindByNameToolInput,
  FileFindByNameToolOutput
> = {
  name: "file.findByName",
  description:
    "在允许根内按文件/目录名做字面量查找，返回匹配路径、类型、大小、扩展名和修改时间。只搜索名称，不读取文件正文，不做全盘扫描，不跟随符号链接或 junction，不写入磁盘。默认递归深度 4、最多 40 条结果。",
  version: "1.0.0",
  riskLevel: "L0",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["path", "query"],
    properties: {
      path: { type: "string", minLength: 1, maxLength: 1000 },
      query: { type: "string", minLength: 1, maxLength: 160 },
      caseSensitive: { type: "boolean" },
      maxResults: { type: "number", minimum: 1, maximum: 100 },
      maxDepth: { type: "number", minimum: 1, maximum: 6 },
      kind: { type: "string", enum: ["any", "file", "directory"] }
    }
  },
  outputSchema: {
    type: "object",
    additionalProperties: false,
    required: [
      "path",
      "query",
      "caseSensitive",
      "kindFilter",
      "matches",
      "matchCount",
      "entriesScanned",
      "directoriesScanned",
      "truncated",
      "skipped",
      "searchedAt"
    ],
    properties: {
      path: { type: "string" },
      query: { type: "string" },
      caseSensitive: { type: "boolean" },
      kindFilter: { type: "string", enum: ["any", "file", "directory"] },
      matches: {
        type: "array",
        maxItems: 100,
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
      matchCount: { type: "number", minimum: 0, maximum: 100 },
      entriesScanned: { type: "number", minimum: 0, maximum: 2000 },
      directoriesScanned: { type: "number", minimum: 0 },
      truncated: { type: "boolean" },
      skipped: {
        type: "object",
        additionalProperties: false,
        required: ["directories", "files", "symbolicLinks", "notAllowed"],
        properties: {
          directories: { type: "number", minimum: 0 },
          files: { type: "number", minimum: 0 },
          symbolicLinks: { type: "number", minimum: 0 },
          notAllowed: { type: "number", minimum: 0 }
        }
      },
      searchedAt: { type: "number" }
    }
  },
  requiredResources: FILE_STATIC_RESOURCES,
  permissions: ["tool.file.findByName"],
  timeoutMs: 15_000,
  cancellable: true,
  idempotency: "safe",
  auditPolicy: { logInputSummary: true, logOutputSummary: true },
  enabled: true,
  maxRetries: 0,
  async execute(input, context) {
    try {
      return await findByName({
        path: input.path.trim(),
        query: input.query.trim(),
        caseSensitive: input.caseSensitive,
        maxResults: input.maxResults,
        maxDepth: input.maxDepth,
        kind: input.kind
      }, context.signal);
    } catch (error) {
      throwAsFileToolError(error);
    }
  }
};

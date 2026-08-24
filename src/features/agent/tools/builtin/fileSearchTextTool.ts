import { searchText } from "../../file/fileBridgeClient";
import type {
  FileSearchTextData,
  FileSearchTextRequest
} from "../../file/fileBridgeTypes";
import { FILE_STATIC_RESOURCES, throwAsFileToolError } from "../../file/fileToolShared";
import type { ToolDefinition } from "../toolTypes";

export type FileSearchTextToolInput = FileSearchTextRequest;
export type FileSearchTextToolOutput = FileSearchTextData;

export const fileSearchTextTool: ToolDefinition<
  FileSearchTextToolInput,
  FileSearchTextToolOutput
> = {
  name: "file.searchText",
  description:
    "在允许根内的目录或单个小型文本文件中搜索字面量文本，返回匹配文件、行号、列号和短片段。默认递归深度 4、最多 40 条结果；不搜索二进制、密钥文件、PDF/DOCX 或超大文件，不跟随符号链接。",
  version: "1.0.0",
  riskLevel: "L0",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["path", "query"],
    properties: {
      path: { type: "string", minLength: 1, maxLength: 1000 },
      query: { type: "string", minLength: 1, maxLength: 200 },
      caseSensitive: { type: "boolean" },
      maxResults: { type: "number", minimum: 1, maximum: 100 },
      maxDepth: { type: "number", minimum: 1, maximum: 6 },
      extensions: {
        type: "array",
        minItems: 1,
        maxItems: 20,
        items: { type: "string", minLength: 1, maxLength: 16 }
      }
    }
  },
  outputSchema: {
    type: "object",
    additionalProperties: false,
    required: [
      "path",
      "query",
      "caseSensitive",
      "matches",
      "matchCount",
      "filesScanned",
      "filesMatched",
      "directoriesScanned",
      "truncated",
      "skipped",
      "searchedAt"
    ],
    properties: {
      path: { type: "string" },
      query: { type: "string" },
      caseSensitive: { type: "boolean" },
      matches: {
        type: "array",
        maxItems: 100,
        items: {
          type: "object",
          additionalProperties: false,
          required: ["path", "fileName", "lineNumber", "column", "preview"],
          properties: {
            path: { type: "string" },
            fileName: { type: "string" },
            lineNumber: { type: "number", minimum: 1 },
            column: { type: "number", minimum: 1 },
            preview: { type: "string", maxLength: 240 }
          }
        }
      },
      matchCount: { type: "number", minimum: 0, maximum: 100 },
      filesScanned: { type: "number", minimum: 0, maximum: 600 },
      filesMatched: { type: "number", minimum: 0, maximum: 600 },
      directoriesScanned: { type: "number", minimum: 0 },
      truncated: { type: "boolean" },
      skipped: {
        type: "object",
        additionalProperties: false,
        required: [
          "directories",
          "files",
          "binaryOrInvalidUtf8",
          "tooLarge",
          "unsupportedExtension",
          "hiddenSensitive",
          "symbolicLinks"
        ],
        properties: {
          directories: { type: "number", minimum: 0 },
          files: { type: "number", minimum: 0 },
          binaryOrInvalidUtf8: { type: "number", minimum: 0 },
          tooLarge: { type: "number", minimum: 0 },
          unsupportedExtension: { type: "number", minimum: 0 },
          hiddenSensitive: { type: "number", minimum: 0 },
          symbolicLinks: { type: "number", minimum: 0 }
        }
      },
      searchedAt: { type: "number" }
    }
  },
  requiredResources: FILE_STATIC_RESOURCES,
  permissions: ["tool.file.searchText"],
  timeoutMs: 20_000,
  cancellable: true,
  idempotency: "safe",
  auditPolicy: {
    logInputSummary: true,
    logOutputSummary: false,
    redactOutputKeys: ["preview"]
  },
  enabled: true,
  maxRetries: 0,
  async execute(input, context) {
    try {
      return await searchText({
        path: input.path.trim(),
        query: input.query.trim(),
        caseSensitive: input.caseSensitive,
        maxResults: input.maxResults,
        maxDepth: input.maxDepth,
        extensions: input.extensions
      }, context.signal);
    } catch (error) {
      throwAsFileToolError(error);
    }
  }
};

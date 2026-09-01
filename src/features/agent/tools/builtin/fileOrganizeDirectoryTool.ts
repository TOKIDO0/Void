import { organizeDirectory } from "../../file/fileBridgeClient";
import type { FileOrganizeDirectoryData } from "../../file/fileBridgeTypes";
import { FILE_STATIC_RESOURCES, throwAsFileToolError } from "../../file/fileToolShared";
import type { ToolDefinition } from "../toolTypes";

export type FileOrganizeDirectoryToolInput = {
  path?: string;
  dryRun?: boolean;
  strategy?: "byExtension" | "byDate";
};

export type FileOrganizeDirectoryToolOutput = FileOrganizeDirectoryData;

export const fileOrganizeDirectoryTool: ToolDefinition<FileOrganizeDirectoryToolInput, FileOrganizeDirectoryToolOutput> = {
  name: "file.organizeDirectory",
  description: "整理指定目录内的散落文件，byExtension 按扩展名分类到 Images/Documents 等，byDate 按修改时间归档到 YYYY-MM；dryRun=true 时仅预览不移动，敏感文件/符号链接/目录不移动。",
  version: "1.0.0",
  riskLevel: "L2",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      path: { type: "string", minLength: 1, maxLength: 1000 },
      dryRun: { type: "boolean" },
      strategy: { type: "string", enum: ["byExtension", "byDate"] }
    }
  },
  outputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["path", "strategy", "dryRun", "totalFiles", "movedCount", "skippedCount", "categories", "moves", "skipped", "organizedAt"],
    properties: {
      path: { type: "string" },
      strategy: { type: "string", enum: ["byExtension", "byDate"] },
      dryRun: { type: "boolean" },
      totalFiles: { type: "number", minimum: 0 },
      movedCount: { type: "number", minimum: 0 },
      skippedCount: { type: "number", minimum: 0 },
      categories: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["category", "count", "targetDir"],
          properties: {
            category: { type: "string" },
            count: { type: "number", minimum: 0 },
            targetDir: { type: "string" }
          }
        }
      },
      moves: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["from", "to", "category"],
          properties: {
            from: { type: "string" },
            to: { type: "string" },
            category: { type: "string" }
          }
        }
      },
      skipped: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["path", "reason"],
          properties: {
            path: { type: "string" },
            reason: { type: "string" }
          }
        }
      },
      organizedAt: { type: "number" }
    }
  },
  requiredResources: FILE_STATIC_RESOURCES,
  permissions: ["tool.file.organizeDirectory"],
  timeoutMs: 30_000,
  cancellable: true,
  idempotency: "unsafe",
  auditPolicy: { logInputSummary: true, logOutputSummary: true },
  enabled: true,
  maxRetries: 0,
  async execute(input, context) {
    try {
      return await organizeDirectory({ path: input.path?.trim(), dryRun: input.dryRun === true, strategy: input.strategy }, context.signal);
    } catch (error) {
      throwAsFileToolError(error);
    }
  }
};

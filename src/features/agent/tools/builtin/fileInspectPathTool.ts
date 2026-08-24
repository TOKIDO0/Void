import { inspectPath } from "../../file/fileBridgeClient";
import type { FileInspectPathData } from "../../file/fileBridgeTypes";
import {
  FILE_STATIC_RESOURCES,
  throwAsFileToolError
} from "../../file/fileToolShared";
import type { ToolDefinition } from "../toolTypes";

export type FileInspectPathToolInput = {
  /** 允许根内的绝对路径；只检查元数据，不读取正文。 */
  path: string;
};

export type FileInspectPathToolOutput = FileInspectPathData;

export const fileInspectPathTool: ToolDefinition<
  FileInspectPathToolInput,
  FileInspectPathToolOutput
> = {
  name: "file.inspectPath",
  description:
    "只读检查允许根内路径的存在性、类型、大小、媒体类型、修改时间、是否像敏感文件，以及是否适合后续 file.readText。不会读取文件正文，不递归目录，不跟随符号链接或 junction，不写入磁盘。适合回答“这个路径存在吗/是什么类型/多大/能不能读/是否敏感”。",
  version: "1.0.0",
  riskLevel: "L0",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["path"],
    properties: {
      path: { type: "string", minLength: 1, maxLength: 1000 }
    }
  },
  outputSchema: {
    type: "object",
    additionalProperties: false,
    required: [
      "status",
      "path",
      "fileName",
      "parentPath",
      "exists",
      "kind",
      "isSymbolicLink",
      "mediaKind",
      "readTextLikelySupported",
      "sensitiveHint",
      "safetyNotes",
      "inspectedAt"
    ],
    properties: {
      status: { type: "string", enum: ["ok"] },
      path: { type: "string" },
      fileName: { type: "string" },
      parentPath: { type: "string" },
      exists: { type: "boolean" },
      kind: { type: "string", enum: ["file", "directory", "missing", "symlink", "other"] },
      isSymbolicLink: { type: "boolean" },
      bytes: { type: "number", minimum: 0 },
      extension: { type: "string", maxLength: 32 },
      mediaKind: {
        type: "string",
        enum: ["image", "audio", "video", "document", "archive", "text", "binary", "unknown"]
      },
      modifiedAt: { type: "number" },
      readTextLikelySupported: { type: "boolean" },
      readTextByteLimit: { type: "number", minimum: 1 },
      readTextSizeAllowed: { type: "boolean" },
      sensitiveHint: { type: "boolean" },
      safetyNotes: {
        type: "array",
        maxItems: 8,
        items: { type: "string", maxLength: 240 }
      },
      inspectedAt: { type: "number" }
    }
  },
  requiredResources: FILE_STATIC_RESOURCES,
  permissions: ["tool.file.inspectPath"],
  timeoutMs: 10_000,
  cancellable: true,
  idempotency: "safe",
  auditPolicy: { logInputSummary: true, logOutputSummary: true },
  enabled: true,
  maxRetries: 0,
  async execute(input, context) {
    try {
      return await inspectPath({ path: input.path.trim() }, context.signal);
    } catch (error) {
      throwAsFileToolError(error);
    }
  }
};

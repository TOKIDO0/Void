import { createDocx } from "../../file/fileBridgeClient";
import type { FileCreateDocxData } from "../../file/fileBridgeTypes";
import { FILE_STATIC_RESOURCES, throwAsFileToolError } from "../../file/fileToolShared";
import type { ToolDefinition } from "../toolTypes";

export type FileCreateDocxToolInput = {
  fileName: string;
  title?: string;
  subtitle?: string;
  sections: Array<{ heading: string; paragraphs?: string[]; bullets?: string[]; table?: { headers: string[]; rows: (string | number)[][]; caption?: string }; quote?: string }>;
  templateId?: string;
};

export type FileCreateDocxToolOutput = FileCreateDocxData;

export const fileCreateDocxTool: ToolDefinition<FileCreateDocxToolInput, FileCreateDocxToolOutput> = {
  name: "file.createDocx",
  description: "按模板生成精美 Word 文档（.docx），支持封面、章节、要点、表格、引用，落盘到下载白名单根内，需用户确认。",
  version: "1.0.0",
  riskLevel: "L2",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["fileName", "sections"],
    properties: {
      fileName: { type: "string", minLength: 5, maxLength: 180 },
      title: { type: "string", minLength: 1, maxLength: 120 },
      subtitle: { type: "string", minLength: 1, maxLength: 160 },
      sections: {
        type: "array",
        minItems: 1,
        maxItems: 20,
        items: {
          type: "object",
          additionalProperties: false,
          required: ["heading"],
          properties: {
            heading: { type: "string", minLength: 1, maxLength: 120 },
            paragraphs: { type: "array", maxItems: 8, items: { type: "string", minLength: 1, maxLength: 600 } },
            bullets: { type: "array", maxItems: 12, items: { type: "string", minLength: 1, maxLength: 300 } },
            quote: { type: "string", minLength: 1, maxLength: 400 },
            table: {
              type: "object",
              additionalProperties: false,
              required: ["headers", "rows"],
              properties: {
                headers: { type: "array", minItems: 1, maxItems: 8, items: { type: "string", minLength: 1, maxLength: 40 } },
                rows: { type: "array", minItems: 1, maxItems: 50, items: { type: "array", minItems: 1, maxItems: 8, items: { anyOf: [{ type: "string" }, { type: "number" }] } } },
                caption: { type: "string", minLength: 1, maxLength: 80 }
              }
            }
          }
        }
      },
      templateId: { type: "string", enum: ["void-dark", "void-light", "void-vivid"] }
    }
  },
  outputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["path", "fileName", "bytes", "sections", "templateId", "writtenAt"],
    properties: {
      path: { type: "string" },
      fileName: { type: "string" },
      bytes: { type: "number", minimum: 0 },
      sections: { type: "number", minimum: 1 },
      templateId: { type: "string" },
      writtenAt: { type: "number" }
    }
  },
  requiredResources: FILE_STATIC_RESOURCES,
  permissions: ["tool.file.createDocx"],
  timeoutMs: 30_000,
  cancellable: true,
  idempotency: "unsafe",
  auditPolicy: { logInputSummary: true, logOutputSummary: true },
  enabled: true,
  maxRetries: 0,
  async execute(input, context) {
    try {
      return await createDocx(
        { fileName: input.fileName.trim(), title: input.title, subtitle: input.subtitle, sections: input.sections, templateId: input.templateId },
        context.signal
      );
    } catch (error) {
      throwAsFileToolError(error);
    }
  }
};

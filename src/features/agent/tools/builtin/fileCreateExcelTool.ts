import { createExcel } from "../../file/fileBridgeClient";
import type { FileCreateExcelData } from "../../file/fileBridgeTypes";
import { FILE_STATIC_RESOURCES, throwAsFileToolError } from "../../file/fileToolShared";
import { resolveOfficeTemplatePreferenceFromMemory } from "../../file/officeTemplatePreference";
import type { ToolDefinition } from "../toolTypes";

export type FileCreateExcelToolInput = {
  fileName: string;
  sheets: Array<{ name: string; headers: string[]; rows: (string | number)[][]; chart?: { type: "bar" | "pie"; title: string; xColumn: number; yColumn: number } }>;
  templateId?: string;
  title?: string;
};

export type FileCreateExcelToolOutput = FileCreateExcelData;

export const fileCreateExcelTool: ToolDefinition<FileCreateExcelToolInput, FileCreateExcelToolOutput> = {
  name: "file.createExcel",
  description: "按模板生成精美 Excel（xlsx），支持多 Sheet、表头样式、隔行斑马纹、筛选冻结、列宽自适应与图表占位；落盘到下载白名单根内，需用户确认。",
  version: "1.0.0",
  riskLevel: "L2",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["fileName", "sheets"],
    properties: {
      fileName: { type: "string", minLength: 5, maxLength: 180 },
      sheets: {
        type: "array",
        minItems: 1,
        maxItems: 10,
        items: {
          type: "object",
          additionalProperties: false,
          required: ["name", "headers", "rows"],
          properties: {
            name: { type: "string", minLength: 1, maxLength: 31 },
            headers: { type: "array", minItems: 1, maxItems: 20, items: { type: "string", minLength: 1, maxLength: 50 } },
            rows: { type: "array", maxItems: 5000, items: { type: "array", items: { anyOf: [{ type: "string" }, { type: "number" }] } } },
            chart: {
              type: "object",
              additionalProperties: false,
              required: ["type", "title", "xColumn", "yColumn"],
              properties: {
                type: { type: "string", enum: ["bar", "pie"] },
                title: { type: "string", minLength: 1, maxLength: 80 },
                xColumn: { type: "number", minimum: 0, maximum: 19 },
                yColumn: { type: "number", minimum: 0, maximum: 19 }
              }
            }
          }
        }
      },
      templateId: { type: "string", enum: ["void-dark", "void-light", "void-vivid"] },
      title: { type: "string", minLength: 1, maxLength: 120 }
    }
  },
  outputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["path", "fileName", "bytes", "sheets", "templateId", "writtenAt"],
    properties: {
      path: { type: "string" },
      fileName: { type: "string" },
      bytes: { type: "number", minimum: 0 },
      sheets: { type: "number", minimum: 1 },
      templateId: { type: "string" },
      writtenAt: { type: "number" }
    }
  },
  requiredResources: FILE_STATIC_RESOURCES,
  permissions: ["tool.file.createExcel"],
  timeoutMs: 30_000,
  cancellable: true,
  idempotency: "unsafe",
  auditPolicy: { logInputSummary: true, logOutputSummary: true },
  enabled: true,
  maxRetries: 0,
  async execute(input, context) {
    try {
      const resolvedTemplateId = input.templateId ?? resolveOfficeTemplatePreferenceFromMemory(input.title ?? input.sheets[0]?.name);
      return await createExcel({ fileName: input.fileName.trim(), sheets: input.sheets, templateId: resolvedTemplateId, title: input.title }, context.signal);
    } catch (error) {
      throwAsFileToolError(error);
    }
  }
};

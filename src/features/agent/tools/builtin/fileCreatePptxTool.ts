import { createPptx } from "../../file/fileBridgeClient";
import type { FileCreatePptxData } from "../../file/fileBridgeTypes";
import { FILE_STATIC_RESOURCES, throwAsFileToolError } from "../../file/fileToolShared";
import { resolveOfficeTemplatePreferenceFromMemory } from "../../file/officeTemplatePreference";
import type { ToolDefinition } from "../toolTypes";

export type FileCreatePptxToolInput = {
  fileName: string;
  title?: string;
  slides: Array<{ title: string; bullets?: string[]; body?: string; chart?: { type: "bar" | "pie"; title: string; labels: string[]; values: number[] }; layout?: string }>;
  templateId?: string;
};

export type FileCreatePptxToolOutput = FileCreatePptxData;

export const fileCreatePptxTool: ToolDefinition<FileCreatePptxToolInput, FileCreatePptxToolOutput> = {
  name: "file.createPptx",
  description: "按模板生成精美 PPTX 演示文稿，支持封面、标题、要点、原生图表，落盘到下载白名单根内，需用户确认。",
  version: "1.0.0",
  riskLevel: "L2",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["fileName", "slides"],
    properties: {
      fileName: { type: "string", minLength: 5, maxLength: 180 },
      title: { type: "string", minLength: 1, maxLength: 120 },
      slides: {
        type: "array",
        minItems: 1,
        maxItems: 30,
        items: {
          type: "object",
          additionalProperties: false,
          required: ["title"],
          properties: {
            title: { type: "string", minLength: 1, maxLength: 120 },
            bullets: { type: "array", maxItems: 12, items: { type: "string", minLength: 1, maxLength: 200 } },
            body: { type: "string", minLength: 1, maxLength: 800 },
            chart: {
              type: "object",
              additionalProperties: false,
              required: ["type", "title", "labels", "values"],
              properties: {
                type: { type: "string", enum: ["bar", "pie"] },
                title: { type: "string", minLength: 1, maxLength: 80 },
                labels: { type: "array", minItems: 1, maxItems: 12, items: { type: "string", minLength: 1, maxLength: 30 } },
                values: { type: "array", minItems: 1, maxItems: 12, items: { type: "number" } }
              }
            },
            layout: { type: "string", enum: ["title", "bullets", "chart", "titleBody"] }
          }
        }
      },
      templateId: { type: "string", enum: ["void-dark", "void-light", "void-vivid"] }
    }
  },
  outputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["path", "fileName", "bytes", "slides", "templateId", "writtenAt"],
    properties: {
      path: { type: "string" },
      fileName: { type: "string" },
      bytes: { type: "number", minimum: 0 },
      slides: { type: "number", minimum: 1 },
      templateId: { type: "string" },
      writtenAt: { type: "number" }
    }
  },
  requiredResources: FILE_STATIC_RESOURCES,
  permissions: ["tool.file.createPptx"],
  timeoutMs: 30_000,
  cancellable: true,
  idempotency: "unsafe",
  auditPolicy: { logInputSummary: true, logOutputSummary: true },
  enabled: true,
  maxRetries: 0,
  async execute(input, context) {
    try {
      const resolvedTemplateId = input.templateId ?? resolveOfficeTemplatePreferenceFromMemory(input.title ?? input.slides[0]?.title);
      return await createPptx({ fileName: input.fileName.trim(), title: input.title, slides: input.slides, templateId: resolvedTemplateId }, context.signal);
    } catch (error) {
      throwAsFileToolError(error);
    }
  }
};

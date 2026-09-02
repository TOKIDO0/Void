import { openFile } from "../../desktop/desktopBridgeClient";
import type { DesktopOpenFileData } from "../../desktop/desktopBridgeTypes";
import { DESKTOP_APP_RESOURCES, throwAsDesktopToolError } from "../../desktop/desktopToolShared";
import type { ToolDefinition } from "../toolTypes";

export type DesktopOpenFileToolInput = { path: string };
export type DesktopOpenFileToolOutput = DesktopOpenFileData;

export const desktopOpenFileTool: ToolDefinition<DesktopOpenFileToolInput, DesktopOpenFileToolOutput> = {
  name: "desktop.openFile",
  description: "用系统关联应用打开允许根内的文件（白名单：txt/md/csv/json/log/pdf/png/jpg/jpeg/bmp/gif/webp/xlsx/pptx/docx，12MB 以内，拒绝符号链接与可执行文件），敏感操作需确认。",
  version: "1.0.0",
  riskLevel: "L2",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["path"],
    properties: { path: { type: "string", minLength: 1, maxLength: 1000, description: "允许根内的绝对文件路径" } }
  },
  outputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["openedPath", "revealedPath", "openMode", "revealedAt"],
    properties: {
      openedPath: { type: "string" },
      revealedPath: { type: "string" },
      openMode: { type: "string", enum: ["open"] },
      revealedAt: { type: "number" }
    }
  },
  requiredResources: DESKTOP_APP_RESOURCES,
  permissions: ["tool.desktop.openFile"],
  timeoutMs: 8000,
  cancellable: true,
  idempotency: "safe",
  auditPolicy: { logInputSummary: true, logOutputSummary: true },
  enabled: true,
  maxRetries: 0,
  async execute(input, context) {
    try {
      const path = input.path.trim();
      if (!path) throw Object.assign(new Error("缺少 path"), { desktopCode: "INVALID_REQUEST" });
      return await openFile({ path }, context.signal);
    } catch (error) {
      throwAsDesktopToolError(error);
    }
  }
};

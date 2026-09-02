import { closeWindow } from "../../desktop/desktopBridgeClient";
import type { DesktopCloseWindowData } from "../../desktop/desktopBridgeTypes";
import { DESKTOP_APP_RESOURCES, throwAsDesktopToolError } from "../../desktop/desktopToolShared";
import type { ToolDefinition } from "../toolTypes";

export type DesktopCloseWindowToolInput = { hwnd?: string; pid?: number; title?: string };
export type DesktopCloseWindowToolOutput = DesktopCloseWindowData;

export const desktopCloseWindowTool: ToolDefinition<DesktopCloseWindowToolInput, DesktopCloseWindowToolOutput> = {
  name: "desktop.closeWindow",
  description: "关闭指定窗口（按 hwnd/pid/title 任一匹配，先尝试优雅关闭，超时后强制结束），敏感操作需确认。",
  version: "1.0.0",
  riskLevel: "L2",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      hwnd: { type: "string", minLength: 1, maxLength: 32 },
      pid: { type: "number", minimum: 1 },
      title: { type: "string", minLength: 1, maxLength: 240 }
    },
    anyOf: [{ required: ["hwnd"] }, { required: ["pid"] }, { required: ["title"] }]
  },
  outputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["closed", "pid", "title", "closedAt"],
    properties: {
      closed: { type: "boolean" },
      pid: { type: "number" },
      title: { type: "string" },
      closedAt: { type: "number" }
    }
  },
  requiredResources: DESKTOP_APP_RESOURCES,
  permissions: ["tool.desktop.closeWindow"],
  timeoutMs: 10000,
  cancellable: true,
  idempotency: "unsafe",
  auditPolicy: { logInputSummary: true, logOutputSummary: true },
  enabled: true,
  maxRetries: 0,
  async execute(input, context) {
    try {
      if (!input.hwnd && !input.pid && !input.title) throw Object.assign(new Error("需提供 hwnd/pid/title"), { desktopCode: "INVALID_REQUEST" });
      return await closeWindow(input as { hwnd?: string; pid?: number; title?: string }, context.signal);
    } catch (error) {
      throwAsDesktopToolError(error);
    }
  }
};

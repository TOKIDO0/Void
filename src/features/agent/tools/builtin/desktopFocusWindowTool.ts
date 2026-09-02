import { focusWindow } from "../../desktop/desktopBridgeClient";
import type { DesktopFocusWindowData } from "../../desktop/desktopBridgeTypes";
import { DESKTOP_APP_RESOURCES, throwAsDesktopToolError } from "../../desktop/desktopToolShared";
import type { ToolDefinition } from "../toolTypes";

export type DesktopFocusWindowToolInput = { hwnd?: string; pid?: number; title?: string };
export type DesktopFocusWindowToolOutput = DesktopFocusWindowData;

export const desktopFocusWindowTool: ToolDefinition<DesktopFocusWindowToolInput, DesktopFocusWindowToolOutput> = {
  name: "desktop.focusWindow",
  description: "将指定窗口置为前台（按 hwnd/pid/title 任一匹配，title 支持包含匹配），用于切换已打开的软件。",
  version: "1.0.0",
  riskLevel: "L1",
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
    required: ["hwnd", "pid", "processName", "title", "focusedAt"],
    properties: {
      hwnd: { type: "string" },
      pid: { type: "number" },
      processName: { type: "string" },
      title: { type: "string" },
      focusedAt: { type: "number" }
    }
  },
  requiredResources: DESKTOP_APP_RESOURCES,
  permissions: ["tool.desktop.focusWindow"],
  timeoutMs: 8000,
  cancellable: true,
  idempotency: "safe",
  auditPolicy: { logInputSummary: true, logOutputSummary: true },
  enabled: true,
  maxRetries: 0,
  async execute(input, context) {
    try {
      if (!input.hwnd && !input.pid && !input.title) throw Object.assign(new Error("需提供 hwnd/pid/title"), { desktopCode: "INVALID_REQUEST" });
      return await focusWindow(input as { hwnd?: string; pid?: number; title?: string }, context.signal);
    } catch (error) {
      throwAsDesktopToolError(error);
    }
  }
};

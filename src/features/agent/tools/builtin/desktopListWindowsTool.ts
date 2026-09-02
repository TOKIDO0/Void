import { listWindows } from "../../desktop/desktopBridgeClient";
import type { DesktopListWindowsData } from "../../desktop/desktopBridgeTypes";
import { DESKTOP_APP_RESOURCES, throwAsDesktopToolError } from "../../desktop/desktopToolShared";
import type { ToolDefinition } from "../toolTypes";

export type DesktopListWindowsToolInput = Record<string, never>;
export type DesktopListWindowsToolOutput = DesktopListWindowsData;

export const desktopListWindowsTool: ToolDefinition<DesktopListWindowsToolInput, DesktopListWindowsToolOutput> = {
  name: "desktop.listWindows",
  description: "只读列出当前可见窗口（标题、进程名、pid、hwnd），上限 80，用于切换或关闭前的选择。",
  version: "1.0.0",
  riskLevel: "L0",
  inputSchema: { type: "object", additionalProperties: false, properties: {} },
  outputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["windows", "count", "scannedAt"],
    properties: {
      windows: {
        type: "array",
        maxItems: 80,
        items: {
          type: "object",
          additionalProperties: false,
          required: ["hwnd", "pid", "processName", "title"],
          properties: { hwnd: { type: "string" }, pid: { type: "number" }, processName: { type: "string" }, title: { type: "string" } }
        }
      },
      count: { type: "number" },
      scannedAt: { type: "number" }
    }
  },
  requiredResources: DESKTOP_APP_RESOURCES,
  permissions: ["tool.desktop.listWindows"],
  timeoutMs: 8000,
  cancellable: true,
  idempotency: "safe",
  auditPolicy: { logInputSummary: true, logOutputSummary: true },
  enabled: true,
  maxRetries: 0,
  async execute(_input, context) {
    try {
      return await listWindows(context.signal);
    } catch (error) {
      throwAsDesktopToolError(error);
    }
  }
};

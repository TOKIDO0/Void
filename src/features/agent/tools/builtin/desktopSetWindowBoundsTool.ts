import { setWindowBounds } from "../../desktop/desktopBridgeClient";
import type { DesktopSetWindowBoundsData } from "../../desktop/desktopBridgeTypes";
import { DESKTOP_APP_RESOURCES, throwAsDesktopToolError } from "../../desktop/desktopToolShared";
import type { ToolDefinition } from "../toolTypes";

export type DesktopSetWindowBoundsToolInput = {
  hwnd?: string;
  pid?: number;
  title?: string;
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  action?: "maximize" | "minimize" | "restore" | "moveResize";
};

export type DesktopSetWindowBoundsToolOutput = DesktopSetWindowBoundsData;

export const desktopSetWindowBoundsTool: ToolDefinition<DesktopSetWindowBoundsToolInput, DesktopSetWindowBoundsToolOutput> = {
  name: "desktop.setWindowBounds",
  description: "调整窗口大小与位置（按 hwnd/pid/title 匹配）：action=maximize/minimize/restore 或 moveResize（x,y,width,height，自动钳制到屏幕范围内）。",
  version: "1.0.0",
  riskLevel: "L1",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      hwnd: { type: "string", minLength: 1, maxLength: 32 },
      pid: { type: "number", minimum: 1 },
      title: { type: "string", minLength: 1, maxLength: 240 },
      x: { type: "number" },
      y: { type: "number" },
      width: { type: "number", minimum: 200, maximum: 7680 },
      height: { type: "number", minimum: 120, maximum: 4320 },
      action: { type: "string", enum: ["maximize", "minimize", "restore", "moveResize"] }
    },
    anyOf: [{ required: ["hwnd"] }, { required: ["pid"] }, { required: ["title"] }]
  },
  outputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["hwnd", "pid", "processName", "title", "action", "appliedAt"],
    properties: {
      hwnd: { type: "string" },
      pid: { type: "number" },
      processName: { type: "string" },
      title: { type: "string" },
      action: { type: "string" },
      bounds: { type: "object", properties: { x: { type: "number" }, y: { type: "number" }, width: { type: "number" }, height: { type: "number" } } },
      appliedAt: { type: "number" }
    }
  },
  requiredResources: DESKTOP_APP_RESOURCES,
  permissions: ["tool.desktop.setWindowBounds"],
  timeoutMs: 8000,
  cancellable: true,
  idempotency: "safe",
  auditPolicy: { logInputSummary: true, logOutputSummary: true },
  enabled: true,
  maxRetries: 0,
  async execute(input, context) {
    try {
      if (!input.hwnd && !input.pid && !input.title) throw Object.assign(new Error("需提供 hwnd/pid/title"), { desktopCode: "INVALID_REQUEST" });
      return await setWindowBounds(input as never, context.signal);
    } catch (error) {
      throwAsDesktopToolError(error);
    }
  }
};

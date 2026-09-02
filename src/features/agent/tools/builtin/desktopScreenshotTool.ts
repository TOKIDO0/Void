import { takeScreenshot } from "../../desktop/desktopBridgeClient";
import type { DesktopScreenshotData } from "../../desktop/desktopBridgeTypes";
import { DESKTOP_APP_RESOURCES, throwAsDesktopToolError } from "../../desktop/desktopToolShared";
import type { ToolDefinition } from "../toolTypes";

export type DesktopScreenshotToolInput = Record<string, never>;
export type DesktopScreenshotToolOutput = DesktopScreenshotData;

export const desktopScreenshotTool: ToolDefinition<DesktopScreenshotToolInput, DesktopScreenshotToolOutput> = {
  name: "desktop.screenshot",
  description: "只读截取主屏当前画面并落盘到 D:\\AI\\void-runtime\\desktop-screenshots，返回路径与分辨率，用于让模型看屏幕后再决定下一步。",
  version: "1.0.0",
  riskLevel: "L0",
  inputSchema: { type: "object", additionalProperties: false, properties: {} },
  outputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["path", "width", "height", "capturedAt"],
    properties: {
      path: { type: "string" },
      width: { type: "number" },
      height: { type: "number" },
      capturedAt: { type: "number" }
    }
  },
  requiredResources: DESKTOP_APP_RESOURCES,
  permissions: ["tool.desktop.screenshot"],
  timeoutMs: 12000,
  cancellable: true,
  idempotency: "safe",
  auditPolicy: { logInputSummary: true, logOutputSummary: true },
  enabled: true,
  maxRetries: 0,
  async execute(_input, context) {
    try {
      return await takeScreenshot(context.signal);
    } catch (error) {
      throwAsDesktopToolError(error);
    }
  }
};

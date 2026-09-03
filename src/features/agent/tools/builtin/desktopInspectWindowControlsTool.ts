// P3-A UIA 只读探针：枚举目标窗口的控件树（名称/类型/矩形），不投递任何输入。
// 用途：先看懂窗口里有什么（联系人列表/输入框/按钮），再决定 B 段如何投递。

import { inspectWindowControls } from "../../desktop/desktopBridgeClient";
import type { DesktopInspectControlsData } from "../../desktop/desktopBridgeTypes";
import { DESKTOP_APP_RESOURCES, throwAsDesktopToolError } from "../../desktop/desktopToolShared";
import type { ToolDefinition } from "../toolTypes";

export type DesktopInspectWindowControlsToolInput = {
  hwnd?: string;
  pid?: number;
  title?: string;
  depth?: number;
  limit?: number;
};

export type DesktopInspectWindowControlsToolOutput = DesktopInspectControlsData;

const CONTROL_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["name", "controlType", "automationId", "depth", "rect"],
  properties: {
    name: { type: "string" },
    controlType: { type: "string" },
    automationId: { type: "string" },
    depth: { type: "number" },
    rect: {
      type: "object",
      properties: {
        x: { type: "number" },
        y: { type: "number" },
        width: { type: "number" },
        height: { type: "number" }
      }
    }
  }
// eslint-disable-next-line @typescript-eslint/no-explicit-any
} as any;

export const desktopInspectWindowControlsTool: ToolDefinition<
  DesktopInspectWindowControlsToolInput,
  DesktopInspectWindowControlsToolOutput
> = {
  name: "desktop.inspectWindowControls",
  description:
    "只读查看指定窗口的控件树（名称、类型、AutomationId、位置矩形），用于看懂窗口里有什么再动手，不点击、不输入。",
  version: "1.0.0",
  riskLevel: "L0",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      hwnd: { type: "string", minLength: 1, maxLength: 32 },
      pid: { type: "number", minimum: 1 },
      title: { type: "string", minLength: 1, maxLength: 240 },
      depth: { type: "number", minimum: 1, maximum: 3 },
      limit: { type: "number", minimum: 1, maximum: 80 }
    },
    anyOf: [{ required: ["hwnd"] }, { required: ["pid"] }, { required: ["title"] }]
  },
  outputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["hwnd", "pid", "processName", "title", "controls", "truncated", "inspectedAt"],
    properties: {
      hwnd: { type: "string" },
      pid: { type: "number" },
      processName: { type: "string" },
      title: { type: "string" },
      controls: { type: "array", items: CONTROL_SCHEMA },
      truncated: { type: "boolean" },
      inspectedAt: { type: "number" }
    }
  },
  requiredResources: DESKTOP_APP_RESOURCES,
  permissions: ["tool.desktop.inspectWindowControls"],
  timeoutMs: 15_000,
  cancellable: true,
  idempotency: "safe",
  auditPolicy: { logInputSummary: true, logOutputSummary: true },
  enabled: true,
  maxRetries: 0,
  async execute(input, context) {
    try {
      if (!input.hwnd && !input.pid && !input.title) {
        throw Object.assign(new Error("需提供 hwnd/pid/title"), { desktopCode: "INVALID_REQUEST" });
      }
      return await inspectWindowControls(
        input as { hwnd?: string; pid?: number; title?: string; depth?: number; limit?: number },
        context.signal
      );
    } catch (error) {
      throwAsDesktopToolError(error);
    }
  }
};

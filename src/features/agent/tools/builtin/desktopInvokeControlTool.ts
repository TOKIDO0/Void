// P3-B 后台触发：对已定位按钮类控件触发点击（UIA InvokePattern），不抢焦点。
// L1 自动（用户已决策一句话直发），硬护栏：目标窗口 + 控件双明确。

import { invokeControl } from "../../desktop/desktopBridgeClient";
import type { DesktopInvokeControlData } from "../../desktop/desktopBridgeTypes";
import { DESKTOP_APP_RESOURCES, throwAsDesktopToolError } from "../../desktop/desktopToolShared";
import type { ToolDefinition } from "../toolTypes";

export type DesktopInvokeControlToolInput = {
  hwnd?: string;
  pid?: number;
  title?: string;
  control: {
    automationId?: string;
    nameContains?: string;
    controlType?: string;
  };
};

export type DesktopInvokeControlToolOutput = DesktopInvokeControlData;

const CONTROL_SELECTOR_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    automationId: { type: "string", minLength: 1, maxLength: 200 },
    nameContains: { type: "string", minLength: 1, maxLength: 200 },
    controlType: { type: "string", minLength: 1, maxLength: 60 }
  }
// eslint-disable-next-line @typescript-eslint/no-explicit-any
} as any;

export const desktopInvokeControlTool: ToolDefinition<
  DesktopInvokeControlToolInput,
  DesktopInvokeControlToolOutput
> = {
  name: "desktop.invokeControl",
  description:
    "后台触发指定窗口的按钮类控件（UIA InvokePattern，不抢焦点）。必须双明确：目标窗口(hwnd/pid/title 之一)+控件之一；缺任一不得调用，先用 inspectWindowControls 定位。不支持的控件会如实拒绝，绝不盲点坐标。",
  version: "1.0.0",
  riskLevel: "L1",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["control"],
    properties: {
      hwnd: { type: "string", minLength: 1, maxLength: 32 },
      pid: { type: "number", minimum: 1 },
      title: { type: "string", minLength: 1, maxLength: 240 },
      control: CONTROL_SELECTOR_SCHEMA
    },
    anyOf: [{ required: ["hwnd"] }, { required: ["pid"] }, { required: ["title"] }]
  },
  outputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["hwnd", "name", "controlType", "automationId", "actedAt"],
    properties: {
      hwnd: { type: "string" },
      name: { type: "string" },
      controlType: { type: "string" },
      automationId: { type: "string" },
      actedAt: { type: "number" }
    }
  },
  requiredResources: DESKTOP_APP_RESOURCES,
  permissions: ["tool.desktop.invokeControl"],
  timeoutMs: 20_000,
  cancellable: true,
  idempotency: "unknown",
  auditPolicy: { logInputSummary: true, logOutputSummary: true },
  enabled: true,
  maxRetries: 0,
  async execute(input, context) {
    try {
      if (!input.hwnd && !input.pid && !input.title) {
        throw Object.assign(new Error("需提供 hwnd/pid/title"), { desktopCode: "INVALID_REQUEST" });
      }
      const control = input.control ?? {};
      if (!control.automationId && !control.nameContains && !control.controlType) {
        throw Object.assign(new Error("control 至少指定一项定位条件"), { desktopCode: "INVALID_REQUEST" });
      }
      return await invokeControl(
        { hwnd: input.hwnd, pid: input.pid, title: input.title, control },
        context.signal
      );
    } catch (error) {
      throwAsDesktopToolError(error);
    }
  }
};

// P3-B 后台设值：对已定位控件设文本，全程不抢焦点、不动真实光标。
// L1 自动（用户已决策一句话直发），硬护栏：目标窗口 + 控件 + 非空文本三明确，500 字上限。

import { setControlText } from "../../desktop/desktopBridgeClient";
import type { DesktopSetControlTextData } from "../../desktop/desktopBridgeTypes";
import { DESKTOP_APP_RESOURCES, throwAsDesktopToolError } from "../../desktop/desktopToolShared";
import type { ToolDefinition } from "../toolTypes";

export type DesktopSetControlTextToolInput = {
  hwnd?: string;
  pid?: number;
  title?: string;
  control: {
    automationId?: string;
    nameContains?: string;
    controlType?: string;
  };
  text: string;
};

export type DesktopSetControlTextToolOutput = DesktopSetControlTextData;

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

export const desktopSetControlTextTool: ToolDefinition<
  DesktopSetControlTextToolInput,
  DesktopSetControlTextToolOutput
> = {
  name: "desktop.setControlText",
  description:
    "后台给指定窗口的输入框设文本（UIA ValuePattern，不抢焦点）。必须三明确：目标窗口(hwnd/pid/title 之一)+控件(automationId/nameContains/controlType 之一)+非空文本(≤500字)；缺任一不得调用，先用 inspectWindowControls 定位。",
  version: "1.0.0",
  riskLevel: "L1",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["control", "text"],
    properties: {
      hwnd: { type: "string", minLength: 1, maxLength: 32 },
      pid: { type: "number", minimum: 1 },
      title: { type: "string", minLength: 1, maxLength: 240 },
      control: CONTROL_SELECTOR_SCHEMA,
      text: { type: "string", minLength: 1, maxLength: 500 }
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
  permissions: ["tool.desktop.setControlText"],
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
      if (!input.text?.trim()) {
        throw Object.assign(new Error("text 不能为空"), { desktopCode: "INVALID_REQUEST" });
      }
      return await setControlText(
        {
          hwnd: input.hwnd,
          pid: input.pid,
          title: input.title,
          control,
          text: input.text
        },
        context.signal
      );
    } catch (error) {
      throwAsDesktopToolError(error);
    }
  }
};

// P6 高权限接管：一键停止（L1，安全动作默认可执行）。

import { takeoverStop } from "../../takeover/takeoverBridgeClient";
import { TAKEOVER_INPUT_RESOURCES, throwAsTakeoverToolError } from "../../takeover/takeoverToolShared";
import type { ToolDefinition } from "../toolTypes";

export const desktopTakeoverStopTool: ToolDefinition<Record<string, never>, Record<string, unknown>> = {
  name: "desktop.takeoverStop",
  description: "立即停止键鼠接管模式，会话作废，后续输入全部拒绝。",
  version: "1.0.0",
  riskLevel: "L1",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    properties: {}
  },
  outputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["stopped"],
    properties: {
      stopped: { type: "boolean" }
    }
  },
  requiredResources: TAKEOVER_INPUT_RESOURCES,
  permissions: ["tool.desktop.takeoverStop"],
  timeoutMs: 10_000,
  cancellable: true,
  idempotency: "unknown",
  auditPolicy: { logInputSummary: true, logOutputSummary: true },
  enabled: true,
  maxRetries: 0,
  async execute() {
    try {
      const stopped = await takeoverStop();
      return { stopped } as unknown as Record<string, unknown>;
    } catch (error) {
      throwAsTakeoverToolError(error);
    }
  }
};

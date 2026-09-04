// P6 高权限接管：只读查看会话状态与审计尾巴（L0）。

import { takeoverStatus } from "../../takeover/takeoverBridgeClient";
import { TAKEOVER_INPUT_RESOURCES, throwAsTakeoverToolError } from "../../takeover/takeoverToolShared";
import type { ToolDefinition } from "../toolTypes";

export const desktopTakeoverStatusTool: ToolDefinition<Record<string, never>, Record<string, unknown>> = {
  name: "desktop.takeoverStatus",
  description: "只读查看键鼠接管会话是否有效、剩余时间、白名单与最近审计，不执行输入。",
  version: "1.0.0",
  riskLevel: "L0",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    properties: {}
  },
  outputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["active", "expiresInSec", "allow", "auditTail"],
    properties: {
      active: { type: "boolean" },
      sessionId: { type: "string" },
      expiresInSec: { type: "number" },
      allow: { type: "array", items: { type: "string" } },
      auditTail: {
        type: "array",
        maxItems: 10,
        items: {
          type: "object",
          additionalProperties: false,
          required: ["at", "action", "foregroundExe"],
          properties: {
            at: { type: "number" },
            action: { type: "string" },
            foregroundExe: { type: "string" }
          }
        }
      }
    }
  },
  requiredResources: TAKEOVER_INPUT_RESOURCES,
  permissions: ["tool.desktop.takeoverStatus"],
  timeoutMs: 10_000,
  cancellable: true,
  idempotency: "safe",
  auditPolicy: { logInputSummary: true, logOutputSummary: true },
  enabled: true,
  maxRetries: 0,
  async execute() {
    try {
      return await takeoverStatus() as unknown as Record<string, unknown>;
    } catch (error) {
      throwAsTakeoverToolError(error);
    }
  }
};

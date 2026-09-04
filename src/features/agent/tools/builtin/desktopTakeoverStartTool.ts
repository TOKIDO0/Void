// P6 高权限接管：显式开启（L3 确认），白名单 + 限时 scope，Rust 侧 fail-closed。

import { takeoverStart } from "../../takeover/takeoverBridgeClient";
import { TAKEOVER_INPUT_RESOURCES, throwAsTakeoverToolError } from "../../takeover/takeoverToolShared";
import { createToolError } from "../toolErrors";
import type { ToolDefinition } from "../toolTypes";

export type DesktopTakeoverStartToolInput = {
  ttlMinutes?: number;
  allowProcesses: string[];
};

export const desktopTakeoverStartTool: ToolDefinition<DesktopTakeoverStartToolInput, Record<string, unknown>> = {
  name: "desktop.takeoverStart",
  description:
    "开启高权限键鼠接管模式（L3 确认）：需白名单应用（≥1 个进程名片段）+ 限时（5～120 分钟）；前台命中白名单且不在反作弊黑名单才执行输入，全程审计。",
  version: "1.0.0",
  riskLevel: "L3",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["allowProcesses"],
    properties: {
      ttlMinutes: { type: "number", minimum: 5, maximum: 120 },
      allowProcesses: {
        type: "array",
        minItems: 1,
        maxItems: 10,
        items: { type: "string", minLength: 1, maxLength: 60 }
      }
    }
  },
  outputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["sessionId", "expiresInSec", "allow"],
    properties: {
      sessionId: { type: "string" },
      expiresInSec: { type: "number" },
      allow: { type: "array", items: { type: "string" } }
    }
  },
  requiredResources: TAKEOVER_INPUT_RESOURCES,
  permissions: ["tool.desktop.takeoverStart"],
  timeoutMs: 10_000,
  cancellable: true,
  idempotency: "unknown",
  auditPolicy: { logInputSummary: true, logOutputSummary: true },
  enabled: true,
  maxRetries: 0,
  async execute(input) {
    const allow = (input.allowProcesses ?? []).map((item) => item.trim()).filter(Boolean);
    if (!allow.length) {
      throw createToolError("SCHEMA_INVALID", "allowProcesses 至少指定一个白名单应用", undefined, false);
    }
    try {
      return await takeoverStart(input.ttlMinutes, allow) as unknown as Record<string, unknown>;
    } catch (error) {
      throwAsTakeoverToolError(error);
    }
  }
};

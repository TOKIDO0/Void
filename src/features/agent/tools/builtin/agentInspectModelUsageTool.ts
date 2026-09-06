// C 模型用量自检：今天/近7日 tokens + 每日上限（L0 只读，供"我花了多少"问询）。

import { fetchModelUsage } from "../../usage/modelUsageBridgeClient";
import { createToolError } from "../toolErrors";
import type { ToolDefinition } from "../toolTypes";

const DAY_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["date", "calls", "promptTokens", "completionTokens", "totalTokens", "responseBytes", "models"],
  properties: {
    date: { type: "string" },
    calls: { type: "number" },
    promptTokens: { type: "number" },
    completionTokens: { type: "number" },
    totalTokens: { type: "number" },
    responseBytes: { type: "number" },
    models: { type: "object" }
  }
// eslint-disable-next-line @typescript-eslint/no-explicit-any
} as any;

export const agentInspectModelUsageTool: ToolDefinition<Record<string, never>, Record<string, unknown>> = {
  name: "agent.inspectModelUsage",
  description: "只读查看模型用量台账：今日/近7日 tokens 与 calls、每日上限，不执行任务。",
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
    required: ["today", "last7", "dailyTokenCap"],
    properties: {
      today: DAY_SCHEMA,
      last7: { type: "array", maxItems: 7, items: DAY_SCHEMA },
      dailyTokenCap: { type: "number" }
    }
  },
  requiredResources: [
    {
      kind: "network",
      key: "void-bridge",
      mode: "shared"
    }
  ],
  permissions: ["tool.agent.inspectModelUsage"],
  timeoutMs: 15_000,
  cancellable: true,
  idempotency: "safe",
  auditPolicy: { logInputSummary: true, logOutputSummary: true },
  enabled: true,
  maxRetries: 0,
  async execute(_input, context) {
    try {
      const overview = await fetchModelUsage(context.signal);
      return overview as unknown as Record<string, unknown>;
    } catch (error) {
      throw createToolError(
        "EXECUTION_FAILED",
        error instanceof Error ? error.message : "用量查询失败",
        { failureKind: "usage_unreachable" },
        true
      );
    }
  }
};

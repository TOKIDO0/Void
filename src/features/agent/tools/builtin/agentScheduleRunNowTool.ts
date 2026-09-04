// P4 后台调度：立即手动触发一次定时任务（L2 确认），即回 runId，结果进台账。

import { runScheduledJobNow } from "../../scheduler/schedulerBridgeClient";
import { SCHEDULER_BRIDGE_RESOURCES, throwAsSchedulerToolError } from "../../scheduler/schedulerToolShared";
import { createToolError } from "../toolErrors";
import type { ToolDefinition } from "../toolTypes";

export type AgentScheduleRunNowToolInput = {
  id: string;
};

export const agentScheduleRunNowTool: ToolDefinition<AgentScheduleRunNowToolInput, Record<string, unknown>> = {
  name: "agent.scheduleRunNow",
  description: "立即手动触发一次后台定时任务，需 L2 确认；即回 runId 不等完成，结果进任务台账。",
  version: "1.0.0",
  riskLevel: "L2",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["id"],
    properties: {
      id: { type: "string", minLength: 1, maxLength: 80 }
    }
  },
  outputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["runId", "status"],
    properties: {
      runId: { type: "string" },
      status: { type: "string" }
    }
  },
  requiredResources: SCHEDULER_BRIDGE_RESOURCES,
  permissions: ["tool.agent.scheduleRunNow"],
  timeoutMs: 30_000,
  cancellable: true,
  idempotency: "unknown",
  auditPolicy: { logInputSummary: true, logOutputSummary: true },
  enabled: true,
  maxRetries: 0,
  async execute(input, context) {
    const id = input.id?.trim();
    if (!id) {
      throw createToolError("SCHEMA_INVALID", "id 不能为空", undefined, false);
    }
    try {
      return await runScheduledJobNow(id, context.signal) as unknown as Record<string, unknown>;
    } catch (error) {
      throwAsSchedulerToolError(error);
    }
  }
};

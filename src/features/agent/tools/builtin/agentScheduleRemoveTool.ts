// P4 后台调度：删除定时任务（L2 确认）。

import { removeScheduledJob } from "../../scheduler/schedulerBridgeClient";
import { SCHEDULER_BRIDGE_RESOURCES, throwAsSchedulerToolError } from "../../scheduler/schedulerToolShared";
import { createToolError } from "../toolErrors";
import type { ToolDefinition } from "../toolTypes";

export type AgentScheduleRemoveToolInput = {
  id: string;
};

export const agentScheduleRemoveTool: ToolDefinition<AgentScheduleRemoveToolInput, Record<string, unknown>> = {
  name: "agent.scheduleRemove",
  description: "删除后台定时任务，需 L2 确认；不存在的 id 返回 removed=false。",
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
    required: ["removed"],
    properties: {
      removed: { type: "boolean" }
    }
  },
  requiredResources: SCHEDULER_BRIDGE_RESOURCES,
  permissions: ["tool.agent.scheduleRemove"],
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
      return await removeScheduledJob(id, context.signal) as unknown as Record<string, unknown>;
    } catch (error) {
      throwAsSchedulerToolError(error);
    }
  }
};

// P4 后台调度：只读列出定时任务与下次触发时间（L0）。

import { listScheduledJobs } from "../../scheduler/schedulerBridgeClient";
import { SCHEDULER_BRIDGE_RESOURCES, throwAsSchedulerToolError } from "../../scheduler/schedulerToolShared";
import type { ToolDefinition } from "../toolTypes";

export const agentScheduleListTool: ToolDefinition<Record<string, never>, Record<string, unknown>> = {
  name: "agent.scheduleList",
  description: "只读列出后台定时任务（含下次触发时间与上次状态），不执行任何任务。",
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
    required: ["jobs", "count"],
    properties: {
      jobs: {
        type: "array",
        maxItems: 50,
        items: {
          type: "object",
          additionalProperties: false,
          required: ["id", "name", "kind", "enabled", "createdAt"],
          properties: {
            id: { type: "string" },
            name: { type: "string" },
            prompt: { type: "string" },
            kind: { type: "string", enum: ["at", "every"] },
            enabled: { type: "boolean" },
            createdAt: { type: "number" },
            atMs: { type: "number" },
            everyMs: { type: "number" },
            anchorMs: { type: "number" },
            allowedToolNames: { type: "array", items: { type: "string" } },
            timeoutMs: { type: "number" },
            speakOnDeliver: { type: "boolean" },
            nextRunAtMs: { type: "number" },
            lastRunAtMs: { type: "number" },
            lastStatus: { type: "string" },
            missedCount: { type: "number" },
            failStreak: { type: "number" }
          }
        }
      },
      count: { type: "number", minimum: 0 }
    }
  },
  requiredResources: SCHEDULER_BRIDGE_RESOURCES,
  permissions: ["tool.agent.scheduleList"],
  timeoutMs: 30_000,
  cancellable: true,
  idempotency: "safe",
  auditPolicy: { logInputSummary: true, logOutputSummary: true },
  enabled: true,
  maxRetries: 0,
  async execute(_input, context) {
    try {
      const jobs = await listScheduledJobs(context.signal);
      return { jobs, count: jobs.length } as unknown as Record<string, unknown>;
    } catch (error) {
      throwAsSchedulerToolError(error);
    }
  }
};

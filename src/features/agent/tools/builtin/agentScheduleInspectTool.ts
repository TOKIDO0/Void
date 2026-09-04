// P4d 后台台账：任务 + 近期 runs + 调度器状态一次看清（L0 只读）。

import {
  fetchRecentRuns,
  getSchedulerStatus,
  listScheduledJobs
} from "../../scheduler/schedulerBridgeClient";
import { SCHEDULER_BRIDGE_RESOURCES, throwAsSchedulerToolError } from "../../scheduler/schedulerToolShared";
import type { ToolDefinition } from "../toolTypes";

export const agentScheduleInspectTool: ToolDefinition<Record<string, never>, Record<string, unknown>> = {
  name: "agent.scheduleInspect",
  description: "只读查看后台调度台账：任务列表、下次触发、近期执行记录与调度器状态，不执行任务。",
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
    required: ["status", "jobs", "recentRuns", "jobCount"],
    properties: {
      status: {
        type: "object",
        additionalProperties: false,
        required: ["unlocked", "running", "jobCount", "enabledCount"],
        properties: {
          unlocked: { type: "boolean" },
          running: { type: "number" },
          jobCount: { type: "number" },
          enabledCount: { type: "number" }
        }
      },
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
      recentRuns: {
        type: "array",
        maxItems: 20,
        items: {
          type: "object",
          additionalProperties: false,
          required: ["id", "jobId", "startedAt", "status", "delivered"],
          properties: {
            id: { type: "string" },
            jobId: { type: "string" },
            jobName: { type: "string" },
            startedAt: { type: "number" },
            finishedAt: { type: "number" },
            status: { type: "string" },
            summary: { type: "string" },
            delivered: { type: "boolean" }
          }
        }
      },
      jobCount: { type: "number", minimum: 0 }
    }
  },
  requiredResources: SCHEDULER_BRIDGE_RESOURCES,
  permissions: ["tool.agent.scheduleInspect"],
  timeoutMs: 30_000,
  cancellable: true,
  idempotency: "safe",
  auditPolicy: { logInputSummary: true, logOutputSummary: true },
  enabled: true,
  maxRetries: 0,
  async execute(_input, context) {
    try {
      const [status, jobs, recentRuns] = await Promise.all([
        getSchedulerStatus(context.signal),
        listScheduledJobs(context.signal),
        fetchRecentRuns(10, context.signal)
      ]);
      return { status, jobs, recentRuns, jobCount: jobs.length } as unknown as Record<string, unknown>;
    } catch (error) {
      throwAsSchedulerToolError(error);
    }
  }
};

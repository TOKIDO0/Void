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
            expr: { type: "string" },
            tz: { type: "string" },
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
          required: ["id", "jobId", "startedAt", "status", "delivered", "deliveryState"],
          properties: {
            id: { type: "string" },
            jobId: { type: "string" },
            jobName: { type: "string" },
            startedAt: { type: "number" },
            finishedAt: { type: "number" },
            status: { type: "string" },
            summary: { type: "string" },
            /** 派生字段：等价于 deliveryState === "sent"，保持旧工具契约可用。 */
            delivered: { type: "boolean" },
            deliveryState: {
              type: "string",
              enum: ["pending", "delivering", "sent", "failed", "expired", "suppressed"]
            },
            deliveryAttempts: { type: "number" },
            deliveryErrorCode: { type: "string" }
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
      // PRO-06：投递状态是结构化对象；对模型保留派生布尔 delivered，避免破坏既有契约。
      const runs = recentRuns.map((run) => ({
        id: run.id,
        jobId: run.jobId,
        jobName: run.jobName,
        startedAt: run.startedAt,
        finishedAt: run.finishedAt,
        status: run.status,
        summary: run.summary,
        delivered: run.delivery.state === "sent",
        deliveryState: run.delivery.state,
        deliveryAttempts: run.delivery.attempts,
        deliveryErrorCode: run.delivery.errorCode
      }));
      return { status, jobs, recentRuns: runs, jobCount: jobs.length } as unknown as Record<string, unknown>;
    } catch (error) {
      throwAsSchedulerToolError(error);
    }
  }
};

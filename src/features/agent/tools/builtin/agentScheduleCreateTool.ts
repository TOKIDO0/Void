// P4 后台调度：创建定时任务（一次 at / 间隔 every），L2 确认一次授 scope。
// 无人值守 run 不再二次确认；Key 经 unlock 进 sidecar 内存，不落盘。

import { loadModelConfig } from "../../../settings/modelConfig";
import { createScheduledJob, ensureSchedulerUnlocked } from "../../scheduler/schedulerBridgeClient";
import { SCHEDULER_BRIDGE_RESOURCES, throwAsSchedulerToolError } from "../../scheduler/schedulerToolShared";
import { createToolError } from "../toolErrors";
import type { ToolDefinition } from "../toolTypes";

export type AgentScheduleCreateToolInput = {
  name?: string;
  prompt: string;
  kind: "at" | "every" | "cron";
  at?: string | number;
  every?: number | string;
  expr?: string;
  tz?: string;
  anchor?: string | number;
  allowedToolNames?: string[];
  timeoutMs?: number;
  speakOnDeliver?: boolean;
  when?: string;
};

const JOB_VIEW_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["id", "name", "kind", "enabled", "createdAt"],
  properties: {
    id: { type: "string" },
    name: { type: "string" },
    prompt: { type: "string" },
    kind: { type: "string", enum: ["at", "every", "cron"] },
    atMs: { type: "number" },
    everyMs: { type: "number" },
    anchorMs: { type: "number" },
    expr: { type: "string" },
    tz: { type: "string" },
    allowedToolNames: { type: "array", items: { type: "string" } },
    timeoutMs: { type: "number" },
    speakOnDeliver: { type: "boolean" },
    enabled: { type: "boolean" },
    createdAt: { type: "number" },
    nextRunAtMs: { type: "number" },
    lastRunAtMs: { type: "number" },
    lastStatus: { type: "string" },
    missedCount: { type: "number" },
    failStreak: { type: "number" }
  }
// eslint-disable-next-line @typescript-eslint/no-explicit-any
} as any;

export const agentScheduleCreateTool: ToolDefinition<AgentScheduleCreateToolInput, Record<string, unknown>> = {
  name: "agent.scheduleCreate",
  description:
    "创建后台定时任务（一次 at / 间隔 every / 日历 cron / 自然语言 when）：到期由 sidecar 隔离执行并落账，需 L2 确认一次授 scope；Key 仅内存。适合提醒、定时检查、到点播报。",
  version: "1.0.0",
  riskLevel: "L2",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["prompt", "kind"],
    properties: {
      name: { type: "string", minLength: 1, maxLength: 80 },
      prompt: { type: "string", minLength: 1, maxLength: 2000 },
      kind: { type: "string", enum: ["at", "every", "cron"] },
      at: {
        anyOf: [
          { type: "string", minLength: 1, maxLength: 64 },
          { type: "number" }
        ]
      },
      every: {
        anyOf: [
          { type: "string", minLength: 1, maxLength: 16 },
          { type: "number" }
        ]
      },
      anchor: {
        anyOf: [
          { type: "string", minLength: 1, maxLength: 64 },
          { type: "number" }
        ]
      },
      expr: { type: "string", minLength: 1, maxLength: 64 },
      tz: { type: "string", minLength: 1, maxLength: 64 },
      allowedToolNames: { type: "array", maxItems: 20, items: { type: "string", minLength: 1, maxLength: 80 } },
      timeoutMs: { type: "number", minimum: 60000, maximum: 3600000 },
      speakOnDeliver: { type: "boolean" },
      when: { type: "string", minLength: 1, maxLength: 64 }
    }
  },
  outputSchema: JOB_VIEW_SCHEMA,
  requiredResources: SCHEDULER_BRIDGE_RESOURCES,
  permissions: ["tool.agent.scheduleCreate"],
  timeoutMs: 30_000,
  cancellable: true,
  idempotency: "unknown",
  auditPolicy: { logInputSummary: true, logOutputSummary: true },
  enabled: true,
  maxRetries: 0,
  async execute(input, context) {
    const prompt = input.prompt?.trim();
    if (!prompt) {
      throw createToolError("SCHEMA_INVALID", "prompt 不能为空", undefined, false);
    }
    if (input.kind !== "at" && input.kind !== "every" && input.kind !== "cron") {
      throw createToolError("SCHEMA_INVALID", "kind 仅支持 at/every/cron", undefined, false);
    }
    if (input.kind === "at" && input.at === undefined) {
      throw createToolError("SCHEMA_INVALID", "at 任务必须给 at 时间", undefined, false);
    }
    if (input.kind === "every" && input.every === undefined) {
      throw createToolError("SCHEMA_INVALID", "every 任务必须给 every 间隔", undefined, false);
    }
    if (input.kind === "cron" && !input.expr?.trim()) {
      throw createToolError("SCHEMA_INVALID", "cron 任务必须给 expr 表达式", undefined, false);
    }
    const modelConfig = loadModelConfig();
    if (!modelConfig.apiKey?.trim()) {
      throw createToolError("EXECUTION_FAILED", "未配置模型 Key，无法创建后台任务", undefined, false);
    }
    try {
      await ensureSchedulerUnlocked(modelConfig, context.signal);
      return await createScheduledJob(
        {
          name: input.name?.trim() || undefined,
          prompt,
          kind: input.kind,
          at: input.at,
          every: input.every,
          anchor: input.anchor,
          allowedToolNames: input.allowedToolNames,
          timeoutMs: input.timeoutMs,
          speakOnDeliver: input.speakOnDeliver,
          expr: input.expr?.trim() || undefined,
          tz: input.tz?.trim() || undefined,
          when: input.when?.trim() || undefined,
        },
        context.signal
      ) as unknown as Record<string, unknown>;
    } catch (error) {
      throwAsSchedulerToolError(error);
    }
  }
};

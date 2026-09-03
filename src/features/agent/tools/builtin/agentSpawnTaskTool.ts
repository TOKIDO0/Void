// P2 agent.spawnTask：子任务隔离执行（对标 Claude Task 子代理轻量版）。
// 把一个独立的只读子调用放到隔离 stepId 下执行，主上下文只收结论摘要，
// 脏中间过程不污染主轮。v1 仅允许 L0 工具，避免嵌套确认死锁。

import { getTool } from "../toolRegistry";
import { getCurrentPermissionGrants } from "../../permissions/permissionGrants";
import type { ToolDefinition } from "../toolTypes";

export type AgentSpawnTaskToolInput = {
  toolName: string;
  input?: Record<string, unknown>;
  purpose?: string;
};

export type AgentSpawnTaskToolOutput = {
  status: "done" | "failed";
  toolName: string;
  summary: string | null;
  data: unknown;
  error: { code: string; message: string } | null;
  finishedAt: number;
};

export const agentSpawnTaskTool: ToolDefinition<AgentSpawnTaskToolInput, AgentSpawnTaskToolOutput> = {
  name: "agent.spawnTask",
  description:
    "派生隔离子任务执行一个只读（L0）工具：独立步骤 ID，主轮只收结论，不收中间过程。适合把独立检索/查看外包出去。禁止 L2 以上与自身嵌套。",
  version: "1.0.0",
  riskLevel: "L1",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["toolName"],
    properties: {
      toolName: { type: "string", minLength: 1, maxLength: 80 },
      input: { type: "object" },
      purpose: { type: "string", minLength: 1, maxLength: 200 }
    }
  },
  outputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["status", "toolName", "summary", "data", "error", "finishedAt"],
    properties: {
      status: { type: "string", enum: ["done", "failed"] },
      toolName: { type: "string" },
      summary: { anyOf: [{ type: "string" }, { type: "null" }] },
      data: { type: "object" },
      error: {
        anyOf: [
          { type: "null" },
          {
            type: "object",
            required: ["code", "message"],
            properties: { code: { type: "string" }, message: { type: "string" } }
          }
        ]
      },
      finishedAt: { type: "number" }
    }
  },
  requiredResources: [],
  permissions: ["tool.agent.spawnTask"],
  timeoutMs: 60_000,
  cancellable: true,
  idempotency: "unknown",
  auditPolicy: { logInputSummary: true, logOutputSummary: false },
  enabled: true,
  maxRetries: 0,
  async execute(input, context) {
    const targetName = input.toolName.trim();
    if (targetName === "agent.spawnTask") {
      throw new Error("禁止 spawnTask 嵌套自身");
    }
    const target = getTool(targetName);
    if (!target || target.enabled === false) {
      throw new Error(`子任务目标工具不可用：${targetName}`);
    }
    if (target.riskLevel !== "L0") {
      throw new Error(`子任务只允许 L0 只读工具，${targetName} 为 ${target.riskLevel}`);
    }
    // 动态导入避免与 toolExecutor 的模块循环
    const { executeToolCall } = await import("../../execution/toolExecutor");
    const subStepId = `sub_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
    const result = await executeToolCall({
      taskId: context.taskId,
      stepId: subStepId,
      toolName: targetName,
      input: input.input ?? {},
      signal: context.signal,
      attempt: 1,
      permissionGrants: getCurrentPermissionGrants()
    });
    if (result.ok) {
      return {
        status: "done",
        toolName: targetName,
        summary: result.summary,
        data: result.data,
        error: null,
        finishedAt: Date.now()
      };
    }
    return {
      status: "failed",
      toolName: targetName,
      summary: null,
      data: {},
      error: { code: result.error.code, message: result.error.message },
      finishedAt: Date.now()
    };
  }
};

// P2 agent.spawnTask v2：子任务组隔离执行（对标 Claude Task 子代理轻量版）。
// v1 仅单个 L0；v2 支持一批 calls（最多 5 个，L0/L1/L2，禁 L3/禁嵌套自身）。
// 安全根因：子调用走 executeToolCall（无确认通道），风险必须在派生前一次收齐 ——
// 由 toolSafetyPolicy.spawn 整批提级（L2 整批确认），执行期再对 L3 硬拒绝。批内串行保序，
// 批间并发走 P5（spawn 本身无锁要求，与其它 L0 同批可并发）。

import { getTool } from "../toolRegistry";
import { getCurrentPermissionGrants } from "../../permissions/permissionGrants";
import { createToolError } from "../toolErrors";
import type { ToolDefinition } from "../toolTypes";

export const SPAWN_MAX_CALLS = 5;

export type AgentSpawnTaskCallInput = {
  toolName: string;
  input?: Record<string, unknown>;
  purpose?: string;
};

export type AgentSpawnTaskToolInput = {
  calls?: AgentSpawnTaskCallInput[];
  /** v1 兼容：单调用形式（等价于 calls 仅一项）。 */
  toolName?: string;
  input?: Record<string, unknown>;
  purpose?: string;
};

export type AgentSpawnTaskResultItem = {
  toolName: string;
  ok: boolean;
  purpose: string | null;
  summary: string | null;
  data: unknown;
  error: { code: string; message: string } | null;
};

export type AgentSpawnTaskToolOutput = {
  status: "done" | "partial" | "failed";
  results: AgentSpawnTaskResultItem[];
  finishedAt: number;
};

const CALL_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["toolName"],
  properties: {
    toolName: { type: "string", minLength: 1, maxLength: 80 },
    input: { type: "object" },
    purpose: { type: "string", minLength: 1, maxLength: 200 }
  }
// eslint-disable-next-line @typescript-eslint/no-explicit-any
} as any;

export const agentSpawnTaskTool: ToolDefinition<
  AgentSpawnTaskToolInput,
  AgentSpawnTaskToolOutput
> = {
  name: "agent.spawnTask",
  description:
    "派生隔离子任务组（最多 5 个调用）：独立步骤 ID，主轮只收结论，不收中间过程。L0/L1 自动，含 L2 整批确认一次；禁 L3 与自身嵌套。适合把独立检索/查看/小批量读写外包出去。",
  version: "2.0.0",
  riskLevel: "L1",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      calls: { type: "array", minItems: 1, maxItems: SPAWN_MAX_CALLS, items: CALL_SCHEMA },
      toolName: { type: "string", minLength: 1, maxLength: 80 },
      input: { type: "object" },
      purpose: { type: "string", minLength: 1, maxLength: 200 }
    },
    anyOf: [{ required: ["calls"] }, { required: ["toolName"] }]
  },
  outputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["status", "results", "finishedAt"],
    properties: {
      status: { type: "string", enum: ["done", "partial", "failed"] },
      results: {
        type: "array",
        maxItems: SPAWN_MAX_CALLS,
        items: {
          type: "object",
          additionalProperties: false,
          required: ["toolName", "ok", "purpose", "summary", "data", "error"],
          properties: {
            toolName: { type: "string" },
            ok: { type: "boolean" },
            purpose: { anyOf: [{ type: "string" }, { type: "null" }] },
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
            }
          }
        }
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
    const calls = normalizeCalls(input);
    // 动态导入避免与 toolExecutor 的模块循环
    const { executeToolCall } = await import("../../execution/toolExecutor");
    const results: AgentSpawnTaskResultItem[] = [];
    for (const call of calls) {
      if (call.toolName === "agent.spawnTask") {
        throw createToolError("SCHEMA_INVALID", "禁止 spawnTask 嵌套自身", undefined, false);
      }
      const target = getTool(call.toolName);
      if (!target || target.enabled === false) {
        throw createToolError("SCHEMA_INVALID", `子任务目标工具不可用：${call.toolName}`, undefined, false);
      }
      if (target.riskLevel === "L3") {
        throw createToolError("SCHEMA_INVALID", `子任务禁止 L3 工具：${call.toolName}`, undefined, false);
      }
      const subStepId = `sub_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
      const result = await executeToolCall({
        taskId: context.taskId,
        stepId: subStepId,
        toolName: call.toolName,
        input: call.input ?? {},
        signal: context.signal,
        attempt: 1,
        permissionGrants: getCurrentPermissionGrants()
      });
      if (result.ok) {
        results.push({
          toolName: call.toolName,
          ok: true,
          purpose: call.purpose ?? null,
          summary: result.summary,
          data: typeof result.data === "object" && result.data !== null ? result.data : { value: result.data },
          error: null
        });
      } else {
        results.push({
          toolName: call.toolName,
          ok: false,
          purpose: call.purpose ?? null,
          summary: null,
          data: {},
          error: { code: result.error.code, message: result.error.message }
        });
      }
    }
    const succeeded = results.filter((item) => item.ok).length;
    return {
      status: succeeded === results.length ? "done" : succeeded > 0 ? "partial" : "failed",
      results,
      finishedAt: Date.now()
    };
  }
};

function normalizeCalls(input: AgentSpawnTaskToolInput): Array<{ toolName: string; input: Record<string, unknown>; purpose?: string }> {
  if (input.calls !== undefined) {
    if (!Array.isArray(input.calls) || input.calls.length === 0 || input.calls.length > SPAWN_MAX_CALLS) {
      throw createToolError("SCHEMA_INVALID", `calls 需 1～${SPAWN_MAX_CALLS} 项`, undefined, false);
    }
    return input.calls.map((call) => ({
      toolName: (call.toolName ?? "").trim(),
      input: call.input ?? {},
      purpose: call.purpose
    }));
  }
  return [{
    toolName: (input.toolName ?? "").trim(),
    input: input.input ?? {},
    purpose: input.purpose
  }];
}

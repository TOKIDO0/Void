// MEM-04：手动触发记忆固结（L1）。
// 为什么是工具而不是设置面板按钮：VOID 的主路径是自然语言/语音，用户说「整理一下我的记忆」就该能跑。

import { runMemoryConsolidation } from "../../../memory/memoryConsolidationRunner";
import type { ToolDefinition } from "../toolTypes";

type ConsolidateInput = {
  dryRun?: boolean;
};

export const agentConsolidateMemoryTool: ToolDefinition<ConsolidateInput, Record<string, unknown>> = {
  name: "agent.consolidateMemory",
  description:
    "整理长期记忆：合并完全重复的条目、用新偏好覆盖旧偏好、清理已过期条目。"
    + "健康档案、人际关系与关系事件永不自动删除。整理前会自动存快照，可回滚。",
  version: "1.0.0",
  riskLevel: "L1",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      dryRun: {
        type: "boolean",
        description: "true 只预览会删多少条，不改动数据；缺省 false"
      }
    }
  },
  outputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["applied", "dryRun", "removed", "stats"],
    properties: {
      applied: { type: "boolean", description: "false 表示没有需要整理的内容，或快照失败已放弃" },
      dryRun: { type: "boolean" },
      snapshotId: { type: "string", description: "回滚用；缺失表示未改动数据" },
      removed: { type: "number", minimum: 0 },
      updated: { type: "number", minimum: 0 },
      stats: {
        type: "object",
        additionalProperties: false,
        required: ["totalEntries", "mergeGroups", "supersedeGroups", "removedEntries"],
        properties: {
          totalEntries: { type: "number", minimum: 0 },
          mergeGroups: { type: "number", minimum: 0 },
          supersedeGroups: { type: "number", minimum: 0 },
          removedEntries: { type: "number", minimum: 0 }
        }
      }
    }
  },
  requiredResources: [
    { kind: "memory", key: "void-memory", mode: "exclusive" }
  ],
  permissions: ["tool.agent.consolidateMemory"],
  timeoutMs: 20_000,
  cancellable: true,
  idempotency: "safe",
  auditPolicy: { logInputSummary: true, logOutputSummary: true },
  enabled: true,
  maxRetries: 0,
  async execute(input) {
    const result = runMemoryConsolidation({
      dryRun: input.dryRun === true,
      reason: input.dryRun === true ? "consolidate-preview" : "consolidate"
    });
    return {
      applied: result.applied,
      dryRun: result.dryRun,
      snapshotId: result.snapshotId ?? undefined,
      removed: result.removed,
      updated: result.updated,
      stats: result.plan.stats
    } as unknown as Record<string, unknown>;
  }
};

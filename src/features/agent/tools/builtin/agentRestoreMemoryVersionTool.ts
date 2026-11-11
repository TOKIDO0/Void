// MEM-04：记忆快照回滚（L2）与版本列表（L0）。
// 为什么回滚必须 L2：会整体替换当前记忆，属不可逆破坏性操作，必须显式确认。

import { restoreMemoryVersionSnapshot } from "../../../memory/memoryConsolidationRunner";
import { listMemoryVersions } from "../../../memory/memoryVersionStore";
import type { ToolDefinition } from "../toolTypes";

type RestoreInput = {
  versionId: string;
};

export const agentRestoreMemoryVersionTool: ToolDefinition<RestoreInput, Record<string, unknown>> = {
  name: "agent.restoreMemoryVersion",
  description:
    "把长期记忆回滚到某个快照版本。会整体替换当前记忆；回滚前会自动再存一份当前状态。"
    + "先用 agent.listMemoryVersions 拿到版本 id。",
  version: "1.0.0",
  riskLevel: "L2",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["versionId"],
    properties: {
      versionId: { type: "string", description: "快照 id，形如 memv_xxx" }
    }
  },
  outputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["restored", "entryCount"],
    properties: {
      restored: { type: "boolean", description: "false 表示版本不存在" },
      entryCount: { type: "number", minimum: 0 },
      safetySnapshotId: { type: "string", description: "回滚前的自动快照，可再用它回滚回来" }
    }
  },
  requiredResources: [{ kind: "memory", key: "void-memory", mode: "exclusive" }],
  permissions: ["tool.agent.restoreMemoryVersion"],
  timeoutMs: 20_000,
  cancellable: true,
  idempotency: "unsafe",
  auditPolicy: { logInputSummary: true, logOutputSummary: true },
  enabled: true,
  maxRetries: 0,
  async execute(input) {
    const result = restoreMemoryVersionSnapshot(input.versionId);
    return {
      restored: result.restored,
      entryCount: result.entryCount,
      safetySnapshotId: result.safetySnapshotId ?? undefined
    } as unknown as Record<string, unknown>;
  }
};

export const agentListMemoryVersionsTool: ToolDefinition<Record<string, never>, Record<string, unknown>> = {
  name: "agent.listMemoryVersions",
  description: "只读列出记忆快照版本（时间、原因、条目数），不修改任何数据。",
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
    required: ["versions", "count"],
    properties: {
      versions: {
        type: "array",
        maxItems: 10,
        items: {
          type: "object",
          additionalProperties: false,
          required: ["id", "reason", "createdAt", "entryCount"],
          properties: {
            id: { type: "string" },
            reason: { type: "string" },
            createdAt: { type: "number" },
            entryCount: { type: "number" }
          }
        }
      },
      count: { type: "number", minimum: 0 }
    }
  },
  requiredResources: [{ kind: "memory", key: "void-memory", mode: "shared" }],
  permissions: ["tool.agent.listMemoryVersions"],
  timeoutMs: 5_000,
  cancellable: true,
  idempotency: "safe",
  auditPolicy: { logInputSummary: true, logOutputSummary: true },
  enabled: true,
  maxRetries: 0,
  async execute() {
    const versions = listMemoryVersions();
    return { versions, count: versions.length } as unknown as Record<string, unknown>;
  }
};

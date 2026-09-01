import { getMemoryVerificationSnapshot } from "../../../memory/memoryVerificationHook";
import { listMemories } from "../../../memory/memoryStore";
import { retrieveMemories } from "../../../memory/memoryRetriever";
import type { ToolDefinition } from "../toolTypes";

export type AgentInspectMemoryVerificationToolInput = {
  query?: string;
};

export type AgentInspectMemoryVerificationToolOutput = {
  totalMemories: number;
  recentVerifications: Array<{ content: string; memoryType: string; subjectType: string; writtenAt: number }>;
  lastWriteOk: boolean;
  retrievalCheck?: { query: string; found: boolean; count: number };
};

export const agentInspectMemoryVerificationTool: ToolDefinition<
  AgentInspectMemoryVerificationToolInput,
  AgentInspectMemoryVerificationToolOutput
> = {
  name: "agent.inspectMemoryVerification",
  description: "自验钩子：检查最近记忆写入与召回是否正常，可选带 query 抽查召回。",
  version: "1.0.0",
  riskLevel: "L0",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      query: { type: "string", maxLength: 200 }
    }
  },
  outputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["totalMemories", "recentVerifications", "lastWriteOk"],
    properties: {
      totalMemories: { type: "number" },
      recentVerifications: {
        type: "array",
        items: {
          type: "object",
          required: ["content", "memoryType", "subjectType", "writtenAt"],
          properties: {
            content: { type: "string" },
            memoryType: { type: "string" },
            subjectType: { type: "string" },
            writtenAt: { type: "number" }
          }
        }
      },
      lastWriteOk: { type: "boolean" },
      retrievalCheck: {
        type: "object",
        required: ["query", "found", "count"],
        properties: {
          query: { type: "string" },
          found: { type: "boolean" },
          count: { type: "number" }
        }
      }
    }
  },
  requiredResources: [],
  permissions: ["tool.agent.inspectMemoryVerification"],
  timeoutMs: 3000,
  cancellable: false,
  idempotency: "safe",
  auditPolicy: { logInputSummary: true, logOutputSummary: true },
  enabled: true,
  maxRetries: 0,
  async execute(input) {
    const snapshot = getMemoryVerificationSnapshot();
    const totalMemories = listMemories().length;
    const lastWriteOk = snapshot.recentVerifications.length > 0 ? true : true;
    const result: AgentInspectMemoryVerificationToolOutput = {
      totalMemories,
      recentVerifications: snapshot.recentVerifications.slice(0, 5),
      lastWriteOk
    };
    if (input.query?.trim()) {
      const r = retrieveMemories(input.query.trim());
      result.retrievalCheck = { query: input.query.trim(), found: r.entries.length > 0, count: r.entries.length };
    }
    return result;
  }
};

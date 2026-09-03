// P2 agent.goal：一句话目标跨轮保持（对标 CCB /goal 轻量版）。
// set 后每轮 system prompt 自动带【本轮目标】对账；完成后 clear。

import { clearAgentGoal, getAgentGoal, setAgentGoal } from "../../tasks/agentGoalStore";
import type { ToolDefinition } from "../toolTypes";

export type AgentGoalToolInput = {
  action: "set" | "clear" | "status";
  goal?: string;
};

export type AgentGoalToolOutput = {
  status: "ok";
  action: "set" | "clear" | "status";
  goal: string | null;
  updatedAt: number;
};

export const agentGoalTool: ToolDefinition<AgentGoalToolInput, AgentGoalToolOutput> = {
  name: "agent.goal",
  description:
    "管理一句话跨轮目标：set 设定（覆盖旧目标），status 查看当前目标，clear 清除。设定后每轮会自动对账进度，完成后记得 clear。",
  version: "1.0.0",
  riskLevel: "L0",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["action"],
    properties: {
      action: { type: "string", enum: ["set", "clear", "status"] },
      goal: { type: "string", minLength: 1, maxLength: 500 }
    }
  },
  outputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["status", "action", "goal", "updatedAt"],
    properties: {
      status: { type: "string", enum: ["ok"] },
      action: { type: "string", enum: ["set", "clear", "status"] },
      goal: { anyOf: [{ type: "string" }, { type: "null" }] },
      updatedAt: { type: "number" }
    }
  },
  requiredResources: [],
  permissions: ["tool.agent.goal"],
  timeoutMs: 3_000,
  cancellable: true,
  idempotency: "safe",
  auditPolicy: { logInputSummary: true, logOutputSummary: true },
  enabled: true,
  maxRetries: 0,
  async execute(input) {
    if (input.action === "clear") {
      clearAgentGoal();
      return { status: "ok", action: input.action, goal: null, updatedAt: Date.now() };
    }
    if (input.action === "status") {
      return {
        status: "ok",
        action: input.action,
        goal: getAgentGoal()?.goal ?? null,
        updatedAt: Date.now()
      };
    }
    if (!input.goal || !input.goal.trim()) {
      throw new Error("action=set 时必须提供非空 goal");
    }
    const saved = setAgentGoal(input.goal);
    return { status: "ok", action: input.action, goal: saved.goal, updatedAt: saved.updatedAt };
  }
};

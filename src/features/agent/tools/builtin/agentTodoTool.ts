// P2 agent.todo：本轮任务清单落盘（对标 Claude TodoWrite 短期记忆）。
// L0 只读/本地状态，不碰文件系统与网络；崩溃/换窗口可恢复。

import {
  clearAgentTodos,
  listAgentTodos,
  setAgentTodos,
  type AgentTodoItem
} from "../../tasks/agentTodoStore";
import type { ToolDefinition } from "../toolTypes";

export type AgentTodoToolInput = {
  action: "set" | "get" | "clear";
  todos?: Array<{ id?: string; content: string; status?: "pending" | "in_progress" | "completed" }>;
};

export type AgentTodoToolOutput = {
  status: "ok";
  action: "set" | "get" | "clear";
  todos: AgentTodoItem[];
  updatedAt: number;
};

export const agentTodoTool: ToolDefinition<AgentTodoToolInput, AgentTodoToolOutput> = {
  name: "agent.todo",
  description:
    "读写本轮任务清单（短期记忆）：多步任务先 set 拆解步骤，完成后更新状态；换轮可 get 恢复进度，做完 clear 归档。不碰文件与网络。",
  version: "1.0.0",
  riskLevel: "L0",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["action"],
    properties: {
      action: { type: "string", enum: ["set", "get", "clear"] },
      todos: {
        type: "array",
        minItems: 1,
        maxItems: 20,
        items: {
          type: "object",
          additionalProperties: false,
          required: ["content"],
          properties: {
            id: { type: "string", minLength: 1, maxLength: 40 },
            content: { type: "string", minLength: 1, maxLength: 200 },
            status: { type: "string", enum: ["pending", "in_progress", "completed"] }
          }
        }
      }
    }
  },
  outputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["status", "action", "todos", "updatedAt"],
    properties: {
      status: { type: "string", enum: ["ok"] },
      action: { type: "string", enum: ["set", "get", "clear"] },
      todos: {
        type: "array",
        maxItems: 20,
        items: {
          type: "object",
          additionalProperties: false,
          required: ["id", "content", "status"],
          properties: {
            id: { type: "string" },
            content: { type: "string" },
            status: { type: "string", enum: ["pending", "in_progress", "completed"] }
          }
        }
      },
      updatedAt: { type: "number" }
    }
  },
  requiredResources: [],
  permissions: ["tool.agent.todo"],
  timeoutMs: 3_000,
  cancellable: true,
  idempotency: "safe",
  auditPolicy: { logInputSummary: true, logOutputSummary: true },
  enabled: true,
  maxRetries: 0,
  async execute(input) {
    if (input.action === "clear") {
      clearAgentTodos();
      return { status: "ok", action: input.action, todos: [], updatedAt: Date.now() };
    }
    if (input.action === "get") {
      return { status: "ok", action: input.action, todos: listAgentTodos(), updatedAt: Date.now() };
    }
    if (!input.todos || input.todos.length === 0) {
      throw new Error("action=set 时必须提供非空 todos");
    }
    const todos = setAgentTodos(input.todos);
    return { status: "ok", action: input.action, todos, updatedAt: Date.now() };
  }
};

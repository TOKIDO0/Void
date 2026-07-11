// 阶段 B 假工具：验证 计划→确认→执行→日志→汇报 全链路，不操作电脑。
// 风险默认 L0；可通过 input.requireConfirm 升到 L2 以验证确认流。

import type { ToolDefinition } from "../toolTypes";

export type EchoToolInput = {
  message: string;
  /** 为 true 时把本步风险视为 L2，强制走用户确认 */
  requireConfirm?: boolean;
};

export type EchoToolOutput = {
  echoed: string;
  length: number;
  at: number;
};

/**
 * echo 工具定义。注册后由执行器统一调度。
 */
export const echoTool: ToolDefinition<EchoToolInput, EchoToolOutput> = {
  name: "echo",
  description: "把输入消息原样回显，仅用于验证 Agent 工具运行时骨架。",
  version: "1.0.0",
  riskLevel: "L0",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["message"],
    properties: {
      message: {
        type: "string",
        minLength: 1,
        maxLength: 2000,
        description: "需要回显的文本"
      },
      requireConfirm: {
        type: "boolean",
        description: "为 true 时本步需要用户确认（模拟 L2）"
      }
    }
  },
  outputSchema: {
    type: "object",
    required: ["echoed", "length", "at"],
    properties: {
      echoed: { type: "string" },
      length: { type: "number" },
      at: { type: "number" }
    }
  },
  requiredResources: [
    {
      kind: "memory",
      key: "echo",
      mode: "shared"
    }
  ],
  permissions: ["tool.echo"],
  timeoutMs: 3000,
  cancellable: true,
  idempotency: "safe",
  auditPolicy: {
    logInputSummary: true,
    logOutputSummary: true,
    redactInputKeys: ["password", "token", "apiKey", "cookie", "secret"],
    redactOutputKeys: ["password", "token", "apiKey", "cookie", "secret"]
  },
  enabled: true,
  maxRetries: 0,
  async execute(input) {
    // 纯内存回显，无副作用；取消由执行器 timeout/AbortSignal 统一处理。
    const message = input.message.trim();
    return {
      echoed: message,
      length: message.length,
      at: Date.now()
    };
  }
};

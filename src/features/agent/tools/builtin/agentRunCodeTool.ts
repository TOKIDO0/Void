import { getCodeBridgeErrorInfo, runCode } from "../../code/codeBridgeClient";
import { createToolError } from "../toolErrors";
import type { ToolDefinition } from "../toolTypes";

export type AgentRunCodeToolInput = {
  language: "javascript" | "python";
  code: string;
  timeoutMs?: number;
};

export type AgentRunCodeToolOutput = {
  status: "ok";
  language: "javascript" | "python";
  stdout: string;
  stderr: string;
  exitCode: number | null;
  timedOut: boolean;
  durationMs: number;
  truncated: boolean;
  ranAt: number;
};

export const agentRunCodeTool: ToolDefinition<AgentRunCodeToolInput, AgentRunCodeToolOutput> = {
  name: "agent.runCode",
  description: "受限执行 JS/Python 代码（办公计算/数据分析），无文件/网络权限，超时与输出均有上限，需用户确认。",
  version: "1.0.0",
  riskLevel: "L2",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["language", "code"],
    properties: {
      language: { type: "string", enum: ["javascript", "python"] },
      code: { type: "string", minLength: 1, maxLength: 20000 },
      timeoutMs: { type: "number", minimum: 1000, maximum: 10000 }
    }
  },
  outputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["status", "language", "stdout", "stderr", "exitCode", "timedOut", "durationMs", "truncated", "ranAt"],
    properties: {
      status: { type: "string", enum: ["ok"] },
      language: { type: "string", enum: ["javascript", "python"] },
      stdout: { type: "string" },
      stderr: { type: "string" },
      exitCode: { anyOf: [{ type: "number" }, { type: "null" }] },
      timedOut: { type: "boolean" },
      durationMs: { type: "number", minimum: 0 },
      truncated: { type: "boolean" },
      ranAt: { type: "number" }
    }
  },
  requiredResources: [{ kind: "code", key: "sandbox", mode: "shared" }],
  permissions: ["tool.agent.runCode"],
  timeoutMs: 15_000,
  cancellable: true,
  idempotency: "unsafe",
  auditPolicy: { logInputSummary: true, logOutputSummary: true, redactInputKeys: [], redactOutputKeys: [] },
  enabled: true,
  maxRetries: 0,
  async execute(input, context) {
    // 输入已由 schema 校验，仍做 trim 防空
    const language = input.language;
    const code = input.code.trim();
    if (!code) throw createToolError("SCHEMA_INVALID", "code 不能为空", undefined, false);
    try {
      const data = await runCode({ language, code, timeoutMs: input.timeoutMs }, context.signal);
      return {
        status: "ok",
        language: data.language,
        stdout: data.stdout,
        stderr: data.stderr,
        exitCode: data.exitCode,
        timedOut: data.timedOut,
        durationMs: data.durationMs,
        truncated: data.truncated,
        ranAt: data.ranAt
      };
    } catch (error) {
      const info = getCodeBridgeErrorInfo(error);
      // 映射为可重试/不可重试
      const retriable = info.code === "TIMEOUT" || info.code === "BRIDGE_UNREACHABLE";
      throw createToolError(info.code === "PYTHON_NOT_FOUND" ? "DEPENDENCY_FAILED" : info.code === "BLOCKED_PATTERN" || info.code === "INVALID_REQUEST" ? "SCHEMA_INVALID" : "EXECUTION_FAILED", info.message, info.details, retriable);
    }
  }
};

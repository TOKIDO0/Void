// 阶段 B 验收冒烟：不挂正式 UI，不写测试框架，直接走生产结构 API。
// 覆盖：合法调用 / Schema 拦截 / 未注册拒绝 / 取消释放锁 / L2 确认 / 日志脱敏。

import {
  bootstrapAgentRuntime
} from "../runtimeBootstrap";
import {
  clearExecutionObservability,
  listExecutionLogs
} from "../observability";
import {
  clearAllResourceLocks,
  listActiveResourceLocks
} from "../resources";
import {
  clearToolRegistry,
  createToolError,
  listModelToolDefinitions,
  listToolMetadata,
  registerTool
} from "../tools";
import { registerBuiltinTools } from "../tools";
import { runTask } from "../execution";
import { executeToolCall } from "../execution/toolExecutor";
import type { ConfirmationRequest } from "../permissions";
import type { ModelConfig } from "../../settings/modelConfig";
import type {
  ModelProvider,
  ProviderResponse,
  ProviderToolCall
} from "../../../lib/model-providers/providerContract";
import {
  getModelProvider,
  installModelProviderOverride
} from "../../../lib/model-providers/providerRegistry";
import { runAgentToolLoop } from "../loop/agentToolLoop";
import { formatSameToolStreakCloseMessage } from "../loop/toolProgressCopy";

export type SmokeResult = {
  ok: boolean;
  failures: string[];
  notes: string[];
};

function resetRuntime() {
  clearToolRegistry();
  clearAllResourceLocks();
  clearExecutionObservability();
  registerBuiltinTools();
}

export async function runAgentRuntimeSmoke(): Promise<SmokeResult> {
  const failures: string[] = [];
  const notes: string[] = [];

  // 1) 合法 L0 echo：计划 → 执行 → 日志 → 汇报
  resetRuntime();
  bootstrapAgentRuntime();

  const productionTools = listToolMetadata();
  if (productionTools.length !== 25 || productionTools.some((tool) => !tool.outputSchema)) {
    failures.push(`生产工具契约审计应覆盖 25 个工具，实际 ${productionTools.length}`);
  } else {
    notes.push("25 个生产工具通过 outputSchema 契约审计");
  }

  let sawProgressMessage = false;
  const happy = await runTask(
    {
      goal: "回显一句问候",
      steps: [
        {
          id: "s1",
          title: "回显消息",
          toolName: "echo",
          input: { message: "你好，VOID" }
        }
      ]
    },
    {
      onPlanUpdate: (plan) => {
        if (plan.currentStepId || plan.status === "running" || plan.status === "succeeded") {
          sawProgressMessage = true;
        }
      }
    }
  );

  if (happy.plan.status !== "succeeded") {
    failures.push(`合法调用应成功，实际 status=${happy.plan.status}`);
  } else {
    notes.push(`合法调用成功：${happy.report.message}`);
  }
  if (listActiveResourceLocks().length !== 0) {
    failures.push("合法调用结束后仍有资源锁残留");
  }
  const happyLogs = listExecutionLogs(happy.plan.id);
  if (!happyLogs.some((item) => item.event === "tool.execute.success")) {
    failures.push("合法调用缺少 tool.execute.success 日志");
  }
  const { getTaskProgress } = await import("../observability");
  const happyProgress = getTaskProgress(happy.plan.id);
  if (!sawProgressMessage && !happyProgress?.message) {
    failures.push("缺少用户可见进度快照");
  } else {
    notes.push(`进度可见：${happyProgress?.message ?? happy.report.message}`);
  }

  // 2) Schema 非法参数：不得进入工具实现
  clearExecutionObservability();
  const schemaResult = await executeToolCall({
    taskId: "smoke_schema",
    stepId: "s_schema",
    toolName: "echo",
    input: { message: 123 },
    signal: new AbortController().signal,
    attempt: 1
  });
  if (schemaResult.ok || schemaResult.error.code !== "SCHEMA_INVALID") {
    failures.push("非法参数应在 Schema 层拦截为 SCHEMA_INVALID");
  } else {
    notes.push(`Schema 拦截：${schemaResult.error.message}`);
  }

  // 3) 未注册工具明确拒绝
  const missing = await executeToolCall({
    taskId: "smoke_missing",
    stepId: "s_missing",
    toolName: "not.registered.tool",
    input: {},
    signal: new AbortController().signal,
    attempt: 1
  });
  if (missing.ok || missing.error.code !== "TOOL_NOT_FOUND") {
    failures.push("未注册工具应返回 TOOL_NOT_FOUND");
  } else {
    notes.push(`未注册拒绝：${missing.error.message}`);
  }

  // 3b) 权限 grants 同时约束模型可见性与直接执行
  const noGrants = new Set<string>();
  if (listModelToolDefinitions(noGrants).length !== 0) {
    failures.push("空权限 grants 下不应向模型暴露工具");
  }
  const denied = await executeToolCall({
    taskId: "smoke_permission_denied",
    stepId: "s_permission_denied",
    toolName: "echo",
    input: { message: "不得执行" },
    signal: new AbortController().signal,
    attempt: 1,
    permissionGrants: noGrants
  });
  if (denied.ok || denied.error.code !== "PERMISSION_DENIED") {
    failures.push("未授权工具直接调用应返回 PERMISSION_DENIED");
  } else {
    notes.push("未授权工具对模型不可见且直接调用被拒绝");
  }

  // 3c) 坏输出不得进入 success 日志
  registerTool({
    name: "smoke.badOutput",
    description: "仅用于验证输出合同",
    version: "1.0.0",
    riskLevel: "L0",
    inputSchema: { type: "object", additionalProperties: false },
    outputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["value"],
      properties: { value: { type: "string" } }
    },
    requiredResources: [],
    permissions: ["tool.smoke.badOutput"],
    timeoutMs: 3_000,
    cancellable: true,
    idempotency: "safe",
    auditPolicy: {},
    async execute() {
      return { value: 123 };
    }
  });
  const badOutput = await executeToolCall({
    taskId: "smoke_bad_output",
    stepId: "s_bad_output",
    toolName: "smoke.badOutput",
    input: {},
    signal: new AbortController().signal,
    attempt: 1,
    permissionGrants: new Set(["tool.smoke.badOutput"])
  });
  const badOutputLogs = listExecutionLogs("smoke_bad_output");
  if (
    badOutput.ok
    || badOutput.error.code !== "OUTPUT_SCHEMA_INVALID"
    || badOutputLogs.some((log) => log.event === "tool.execute.success")
  ) {
    failures.push("坏输出应返回 OUTPUT_SCHEMA_INVALID 且不得记录 success");
  } else {
    notes.push("坏输出被 OUTPUT_SCHEMA_INVALID 拦截且未记录 success");
  }

  // 4) L2 确认流：requireConfirm=true，先确认再执行
  clearExecutionObservability();
  clearAllResourceLocks();
  let confirmationSeen: ConfirmationRequest | undefined;
  const confirmed = await runTask(
    {
      goal: "需要确认的回显",
      steps: [
        {
          id: "s_confirm",
          title: "确认后回显",
          toolName: "echo",
          input: { message: "敏感回显", requireConfirm: true }
        }
      ]
    },
    {
      requestConfirmation: async (request) => {
        confirmationSeen = request;
        return {
          requestId: request.id,
          approved: true,
          decidedAt: Date.now()
        };
      }
    }
  );
  if (!confirmationSeen) {
    failures.push("L2 步骤未发出确认请求");
  }
  if (confirmed.plan.status !== "succeeded") {
    failures.push(`L2 确认后应成功，实际 status=${confirmed.plan.status}`);
  } else {
    notes.push(`L2 确认通过并执行成功：risk=${confirmationSeen?.riskLevel}`);
  }

  // 4b) L2 未确认不得执行
  clearExecutionObservability();
  const rejected = await runTask(
    {
      goal: "拒绝确认的回显",
      steps: [
        {
          id: "s_reject",
          title: "应被拒绝",
          toolName: "echo",
          input: { message: "不该执行", requireConfirm: true }
        }
      ]
    },
    {
      requestConfirmation: async (request) => ({
        requestId: request.id,
        approved: false,
        decidedAt: Date.now(),
        note: "用户点了取消"
      })
    }
  );
  if (rejected.plan.status === "succeeded") {
    failures.push("L2 拒绝后不应执行成功");
  } else if (rejected.plan.error?.code !== "CONFIRMATION_REJECTED") {
    failures.push(`L2 拒绝后错误码应为 CONFIRMATION_REJECTED，实际 ${rejected.plan.error?.code}`);
  } else {
    notes.push("L2 未确认前未执行（拒绝）");
  }

  // 5) 取消：任务 cancelled，资源锁释放
  clearExecutionObservability();
  clearAllResourceLocks();
  const cancelController = new AbortController();
  // 在确认等待中取消
  const cancelPromise = runTask(
    {
      goal: "取消中的回显",
      steps: [
        {
          id: "s_cancel",
          title: "等待确认时取消",
          toolName: "echo",
          input: { message: "cancel-me", requireConfirm: true }
        }
      ]
    },
    {
      signal: cancelController.signal,
      requestConfirmation: async () => {
        queueMicrotask(() => cancelController.abort());
        return new Promise<never>(() => {});
      }
    }
  );
  const cancelled = await cancelPromise;
  if (cancelled.plan.status !== "cancelled") {
    failures.push(`取消后 status 应为 cancelled，实际 ${cancelled.plan.status}`);
  } else {
    notes.push("取消后任务为 cancelled");
  }
  if (listActiveResourceLocks().length !== 0) {
    failures.push("取消后资源锁未释放");
  } else {
    notes.push("取消后资源锁已释放");
  }

  // 5b) 工具实现不主动响应 signal 时，执行器仍必须立即取消并释放锁
  registerTool({
    name: "smoke.hanging",
    description: "仅用于验证执行中取消",
    version: "1.0.0",
    riskLevel: "L0",
    inputSchema: { type: "object", additionalProperties: false },
    outputSchema: { type: "object" },
    requiredResources: [{ kind: "memory", key: "smoke-hanging", mode: "exclusive" }],
    permissions: ["tool.smoke.hanging"],
    timeoutMs: 30_000,
    cancellable: true,
    idempotency: "safe",
    auditPolicy: {},
    async execute() {
      return new Promise<never>(() => {});
    }
  });
  const executionCancelController = new AbortController();
  const hangingExecution = executeToolCall({
    taskId: "smoke_execution_cancel",
    stepId: "s_execution_cancel",
    toolName: "smoke.hanging",
    input: {},
    signal: executionCancelController.signal,
    attempt: 1,
    permissionGrants: new Set(["tool.smoke.hanging"])
  });
  queueMicrotask(() => executionCancelController.abort());
  const executionCancelled = await hangingExecution;
  if (executionCancelled.ok || executionCancelled.error.code !== "CANCELLED") {
    failures.push("执行中的工具应立即返回 CANCELLED");
  } else if (listActiveResourceLocks().length !== 0) {
    failures.push("执行中取消后资源锁未释放");
  } else {
    notes.push("工具执行中取消后立即结束并释放资源锁");
  }

  registerTool({
    name: "smoke.throwing",
    description: "仅用于验证工具异常终态",
    version: "1.0.0",
    riskLevel: "L0",
    inputSchema: { type: "object", additionalProperties: false },
    outputSchema: { type: "object" },
    requiredResources: [{ kind: "memory", key: "smoke-throwing", mode: "exclusive" }],
    permissions: ["tool.smoke.throwing"],
    timeoutMs: 3_000,
    cancellable: true,
    idempotency: "safe",
    auditPolicy: {},
    async execute() {
      throw new Error("smoke tool failure");
    }
  });
  const toolFailure = await runTask({
    goal: "工具异常终态",
    steps: [{ title: "抛出工具异常", toolName: "smoke.throwing", input: {} }]
  }, { permissionGrants: new Set(["tool.smoke.throwing"]) });
  if (toolFailure.plan.status !== "failed" || listActiveResourceLocks().length !== 0) {
    failures.push("工具异常后应进入 failed 终态并释放资源锁");
  } else {
    notes.push("工具异常后进入 failed 终态并释放资源锁");
  }

  let safeAttempts = 0;
  let unsafeAttempts = 0;
  for (const [name, idempotency] of [
    ["smoke.retrySafe", "safe"],
    ["smoke.retryUnsafe", "unsafe"]
  ] as const) {
    registerTool({
      name,
      description: "仅用于验证重试门禁",
      version: "1.0.0",
      riskLevel: "L0",
      inputSchema: { type: "object", additionalProperties: false },
      outputSchema: { type: "object" },
      requiredResources: [],
      permissions: [`tool.${name}`],
      timeoutMs: 3_000,
      cancellable: true,
      idempotency,
      auditPolicy: {},
      maxRetries: 1,
      async execute() {
        if (idempotency === "safe") {
          safeAttempts += 1;
        } else {
          unsafeAttempts += 1;
        }
        throw createToolError("EXECUTION_FAILED", "可重试失败", undefined, true);
      }
    });
  }
  await runTask({
    goal: "safe 重试",
    steps: [{ title: "safe", toolName: "smoke.retrySafe", input: {} }]
  }, { permissionGrants: new Set(["tool.smoke.retrySafe"]) });
  await runTask({
    goal: "unsafe 不重试",
    steps: [{ title: "unsafe", toolName: "smoke.retryUnsafe", input: {} }]
  }, { permissionGrants: new Set(["tool.smoke.retryUnsafe"]) });
  if (safeAttempts !== 2 || unsafeAttempts !== 1) {
    failures.push(`重试门禁错误：safe=${safeAttempts}，unsafe=${unsafeAttempts}`);
  } else {
    notes.push("safe 工具重试 1 次，unsafe 工具仅执行 1 次");
  }

  // 6) 日志脱敏：不得保存 apiKey/password/token
  clearExecutionObservability();
  await runTask({
    goal: "脱敏检查",
    steps: [
      {
        id: "s_redact",
        title: "带敏感字段名的输入",
        toolName: "echo",
        // message 合法；额外敏感字段会被 additionalProperties:false 拦下，
        // 因此单独写一条日志验证 sanitize
        input: { message: "ok" }
      }
    ]
  });
  const { appendExecutionLog } = await import("../observability");
  appendExecutionLog({
    taskId: "smoke_redact",
    event: "audit.sanitize.check",
    message: "脱敏检查",
    data: {
      apiKey: "sk-this-is-secret-key-value",
      password: "hunter2-password",
      token: "aaaa.bbbb.cccc",
      safe: "hello"
    },
    redactKeys: ["apiKey", "password", "token"]
  });
  const redactLog = listExecutionLogs("smoke_redact").find(
    (item) => item.event === "audit.sanitize.check"
  );
  const data = redactLog?.data ?? {};
  if (data.apiKey !== "[REDACTED]" || data.password !== "[REDACTED]" || data.token !== "[REDACTED]") {
    failures.push("日志脱敏失败，敏感字段未被替换");
  } else if (data.safe !== "hello") {
    failures.push("日志脱敏误伤非敏感字段");
  } else {
    notes.push("日志敏感字段已脱敏");
  }

  // 7) 同工具连续失败熔断：收口文案必须点名工具 + 错误码
  clearExecutionObservability();
  clearAllResourceLocks();
  const streakProbe = await runSameToolStreakCloseProbe();
  if (!streakProbe.ok) {
    failures.push(...streakProbe.failures);
  } else {
    notes.push(...streakProbe.notes);
  }

  const modelFailureProbe = await runModelFailureProbe();
  if (!modelFailureProbe.ok) {
    failures.push(...modelFailureProbe.failures);
  } else {
    notes.push(...modelFailureProbe.notes);
  }

  return {
    ok: failures.length === 0,
    failures,
    notes
  };
}

async function runModelFailureProbe(): Promise<SmokeResult> {
  const originalProvider = getModelProvider("openai-compatible");
  const uninstall = installModelProviderOverride("openai-compatible", {
    ...originalProvider,
    supportsTools: true,
    async sendMessage() {
      throw new Error("smoke model failure");
    }
  });
  clearExecutionObservability();
  clearAllResourceLocks();

  try {
    await runAgentToolLoop({
      messages: [{ role: "user", content: "触发模型异常" }],
      modelConfig: {
        provider: "openai-compatible",
        presetId: "smoke",
        apiKey: "smoke-key",
        baseUrl: "http://127.0.0.1:9",
        modelName: "smoke-model",
        modelStrength: "middle",
        thinkingModeEnabled: false,
        temperature: 0,
        maxOutputTokens: 32,
        streamEnabled: false,
        requestMode: "development-proxy"
      }
    });
    return { ok: false, failures: ["模型异常不应返回成功"], notes: [] };
  } catch {
    const hasFailedTerminal = listExecutionLogs().some((log) => log.event === "task.failed");
    if (!hasFailedTerminal || listActiveResourceLocks().length !== 0) {
      return {
        ok: false,
        failures: ["模型异常后缺少 failed 终态或仍有资源锁"],
        notes: []
      };
    }
    return { ok: true, failures: [], notes: ["模型异常后写入 failed 终态并释放资源"] };
  } finally {
    uninstall();
  }
}

/**
 * P5：强制同工具连错 3 次触发熔断，断言用户收口含工具名与错误码。
 * 用假 provider 注入 tool_calls，不依赖真实 LLM / bridge。
 */
async function runSameToolStreakCloseProbe(): Promise<SmokeResult> {
  const failures: string[] = [];
  const notes: string[] = [];
  const originalProvider = getModelProvider("openai-compatible");
  const stubProvider = createSameToolStreakStubProvider(originalProvider);
  // 临时覆盖 openai-compatible，仅本冒烟进程内生效
  const uninstall = installModelProviderOverride("openai-compatible", stubProvider);

  try {
    const modelConfig: ModelConfig = {
      provider: "openai-compatible",
      presetId: "smoke",
      apiKey: "smoke-key",
      baseUrl: "http://127.0.0.1:9",
      modelName: "smoke-model",
      modelStrength: "middle",
      thinkingModeEnabled: false,
      temperature: 0,
      maxOutputTokens: 256,
      streamEnabled: false,
      requestMode: "development-proxy"
    };

    const loopResult = await runAgentToolLoop({
      messages: [
        { role: "system", content: "测试同工具熔断收口" },
        { role: "user", content: "请连续调用 echo 并故意失败" }
      ],
      modelConfig,
      // 仅暴露 echo，避免无关工具干扰
      tools: [
        {
          type: "function",
          function: {
            name: "echo",
            description: "smoke echo",
            parameters: {
              type: "object",
              properties: {
                message: { type: "string" }
              },
              required: ["message"]
            }
          }
        }
      ],
      maxRounds: 6,
      maxToolInvocations: 8
    });

    const content = loopResult.content ?? "";
    const expectedCode = "SCHEMA_INVALID";
    const expectedTool = "echo";
    if (!content.includes(expectedTool)) {
      failures.push(`熔断收口缺少工具名「${expectedTool}」：${content}`);
    }
    if (!content.includes(expectedCode)) {
      failures.push(`熔断收口缺少错误码「${expectedCode}」：${content}`);
    }
    // 对照 formatSameToolStreakCloseMessage 结构（至少包含连续次数语义）
    if (!/连续\s*\d+\s*次/.test(content) && !content.includes("连续")) {
      failures.push(`熔断收口未体现连续失败次数：${content}`);
    }
    if (failures.length === 0) {
      notes.push(
        `同工具熔断收口可读：${content.slice(0, 120)}`
      );
      notes.push(
        `收口模板样例：${formatSameToolStreakCloseMessage(expectedTool, expectedCode, 3)}`
      );
    }
  } catch (error) {
    failures.push(
      `同工具熔断探测崩溃：${error instanceof Error ? error.message : String(error)}`
    );
  } finally {
    uninstall();
  }

  return {
    ok: failures.length === 0,
    failures,
    notes
  };
}

/**
 * 假 provider：
 * 1) 前 3 次带 tools 时返回 echo 非法参数 tool_call（触发 SCHEMA_INVALID）
 * 2) 第 4 次起若仍带 tools，会再次返回 tool_call 以撞上 streak 熔断
 * 3) forceFinalText（tools 被摘掉）时返回空内容，迫使循环层用可读收口
 */
function createSameToolStreakStubProvider(base: ModelProvider): ModelProvider {
  let toolRound = 0;
  return {
    ...base,
    supportsTools: true,
    async sendMessage(request): Promise<ProviderResponse> {
      const hasTools = Boolean(request.tools && request.tools.length > 0);
      if (!hasTools) {
        // 强制纯文本轮：故意给空内容，验证 ensureStreakCloseContent 兜底
        return { content: "" };
      }

      toolRound += 1;
      const toolCall: ProviderToolCall = {
        id: `call_streak_${toolRound}`,
        type: "function",
        function: {
          // 非法参数：message 必须是 string，这里给 number → SCHEMA_INVALID
          name: "echo",
          arguments: JSON.stringify({ message: 123 })
        }
      };
      return {
        content: "",
        toolCalls: [toolCall]
      };
    },
    mapError(error) {
      return error instanceof Error ? error : new Error(String(error));
    }
  };
}

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
  clearToolRegistry
} from "../tools";
import { registerBuiltinTools } from "../tools";
import { runTask } from "../execution";
import { executeToolCall } from "../execution/toolExecutor";
import type { ConfirmationRequest } from "../permissions";

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
      requestConfirmation: async (request) => {
        cancelController.abort();
        return {
          requestId: request.id,
          approved: false,
          decidedAt: Date.now(),
          note: "任务已取消"
        };
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

  return {
    ok: failures.length === 0,
    failures,
    notes
  };
}

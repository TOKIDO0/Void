// 任务执行器：串联计划状态机、权限确认、工具执行、日志与汇报。
// 设计依据：`.md/18` §5.2、`.md/27` §5.2–5.6 / §7.3。

import {
  createConfirmationRequest,
  DEFAULT_RISK_POLICY,
  requiresUserConfirmation,
  resolveEffectiveRiskLevel,
  type ConfirmationDecision,
  type ConfirmationRequest
} from "../permissions";
import {
  createTaskPlan,
  inspectPlanTools,
  isTerminalTaskStatus,
  listReadyStepIds,
  markBlockedStepsSkipped,
  type CreateTaskRequest,
  type TaskPlan,
  type TaskReport,
  type TaskStatus,
  type TaskStep,
  type TaskStepDraft
} from "../planning";
import {
  appendExecutionLog,
  setTaskProgress
} from "../observability";
import { sanitizeForAudit } from "../observability/auditSanitize";
import { releaseBrowserSessionForTask } from "../browser/browserSessionLifecycle";
import { buildToolConfirmationDescription } from "../loop/toolConfirmationCopy";
import { releaseTaskResources } from "../resources";
import {
  createToolError,
  getTool,
  type RiskLevel,
  type ToolError
} from "../tools";
import { executeToolCall } from "./toolExecutor";
import type { TaskRunnerOptions, TaskRunResult } from "./executionTypes";

/**
 * 运行一个任务计划（从草稿创建并执行到终态）。
 */
export async function runTask(
  request: CreateTaskRequest,
  options: TaskRunnerOptions = {}
): Promise<TaskRunResult> {
  let plan = createTaskPlan(request);
  plan = setTaskStatus(plan, "planning");
  emitPlan(plan, options, "任务进入规划");

  const inspectError = inspectPlanTools(plan);
  if (inspectError) {
    plan = finishAsFailed(plan, inspectError);
    emitPlan(plan, options, inspectError.message);
    return finalize(plan);
  }

  plan = setTaskStatus(plan, "running");
  plan = {
    ...plan,
    startedAt: plan.startedAt ?? Date.now(),
    updatedAt: Date.now()
  };
  emitPlan(plan, options, "任务开始执行");

  const controller = new AbortController();
  const onExternalAbort = () => {
    controller.abort();
  };
  if (options.signal) {
    if (options.signal.aborted) {
      controller.abort();
    } else {
      options.signal.addEventListener("abort", onExternalAbort, { once: true });
    }
  }

  try {
    while (!isTerminalTaskStatus(plan.status)) {
      if (controller.signal.aborted) {
        plan = finishAsCancelled(
          plan,
          createToolError("CANCELLED", "任务已取消", undefined, false)
        );
        emitPlan(plan, options, "任务已取消");
        break;
      }

      plan = markBlockedStepsSkipped(plan);
      const readyStepIds = listReadyStepIds(plan);
      if (readyStepIds.length === 0) {
        plan = concludeWhenNoReadySteps(plan);
        emitPlan(plan, options, plan.report?.message ?? "任务结束");
        break;
      }

      // 阶段 B：按计划顺序串行执行，避免并发复杂度。
      const stepId = pickNextStepId(plan, readyStepIds);
      const step = plan.steps.find((item) => item.id === stepId);
      if (!step) {
        plan = finishAsFailed(
          plan,
          createToolError("INTERNAL_ERROR", `找不到步骤 ${stepId}`, undefined, false)
        );
        emitPlan(plan, options, plan.error?.message ?? "内部错误");
        break;
      }

      plan = await runSingleStep(plan, step, controller, options);
      emitPlan(plan, options, describePlanProgress(plan));
    }
  } catch (error) {
    const failure = error
      && typeof error === "object"
      && "code" in error
      && typeof (error as { code?: unknown }).code === "string"
      && "retriable" in error
      && typeof (error as { retriable?: unknown }).retriable === "boolean"
      ? error as ToolError
      : createToolError(
          controller.signal.aborted ? "CANCELLED" : "EXECUTION_FAILED",
          error instanceof Error ? error.message : "任务执行失败",
          undefined,
          false
        );
    plan = controller.signal.aborted
      ? finishAsCancelled(plan, failure)
      : finishAsFailed(plan, failure);
    emitPlan(plan, options, plan.report?.message ?? failure.message);
  } finally {
    options.signal?.removeEventListener("abort", onExternalAbort);
    releaseTaskResources(plan.id);
    // 阶段 C：仅当本任务用过浏览器工具时关闭 Playwright 上下文，避免无关任务空连 sidecar
    if (plan.steps.some((step) => step.toolName.startsWith("browser."))) {
      await releaseBrowserSessionForTask(plan.id);
    }
  }

  const report = plan.report ?? buildTaskReport(plan);
  plan = {
    ...plan,
    report,
    updatedAt: Date.now()
  };

  appendExecutionLog({
    taskId: plan.id,
    event: "task.finished",
    message: report.message,
    data: {
      status: plan.status,
      report
    }
  });

  return finalize(plan);
}

/**
 * 仅创建计划不执行（便于 UI 预览）。
 */
export function planTask(request: CreateTaskRequest): TaskPlan {
  return createTaskPlan(request);
}

async function runSingleStep(
  plan: TaskPlan,
  step: TaskStep,
  controller: AbortController,
  options: TaskRunnerOptions
): Promise<TaskPlan> {
  const tool = getTool(step.toolName);
  if (!tool) {
    return failStepAndTask(
      plan,
      step.id,
      createToolError("TOOL_NOT_FOUND", `未注册工具：${step.toolName}`, undefined, false)
    );
  }

  const dynamicRisk = resolveDynamicRisk(step, tool.riskLevel, step.input);
  const effectiveRisk = resolveEffectiveRiskLevel(tool.riskLevel, dynamicRisk);
  const policy = options.riskPolicy ?? DEFAULT_RISK_POLICY;

  let nextPlan = updateStep(plan, step.id, (current) => ({
    ...current,
    status: "ready",
    riskLevel: effectiveRisk
  }));
  nextPlan = {
    ...nextPlan,
    currentStepId: step.id,
    updatedAt: Date.now()
  };

  // L2/L3：未确认前绝不执行
  if (requiresUserConfirmation(effectiveRisk, policy)) {
    nextPlan = setTaskStatus(nextPlan, "waiting_confirmation");
    nextPlan = updateStep(nextPlan, step.id, (current) => ({
      ...current,
      status: "waiting_confirmation"
    }));

    const confirmation = createConfirmationRequest({
      taskId: nextPlan.id,
      stepId: step.id,
      toolName: step.toolName,
      riskLevel: effectiveRisk,
      title: step.title,
      description: buildToolConfirmationDescription(
        step.toolName,
        effectiveRisk,
        step.input,
        step.title
      ),
      inputSummary: sanitizeForAudit(
        step.input,
        tool.auditPolicy.redactInputKeys ?? []
      ) as Record<string, unknown>
    });

    appendExecutionLog({
      taskId: nextPlan.id,
      stepId: step.id,
      toolName: step.toolName,
      event: "permission.confirmation.requested",
      message: `等待用户确认：${step.title}`,
      data: {
        confirmationId: confirmation.id,
        riskLevel: effectiveRisk,
        inputSummary: confirmation.inputSummary
      },
      redactKeys: tool.auditPolicy.redactInputKeys
    });
    emitPlan(nextPlan, options, `等待确认：${step.title}`);

    const decision = await waitForConfirmation(confirmation, options, controller.signal);
    if (!decision.approved) {
      const error = createToolError(
        decision.note === "任务已取消" ? "CANCELLED" : "CONFIRMATION_REJECTED",
        decision.note === "任务已取消" ? "任务已取消" : "用户拒绝了该操作",
        { confirmationId: confirmation.id, note: decision.note },
        false
      );

      appendExecutionLog({
        level: "warn",
        taskId: nextPlan.id,
        stepId: step.id,
        toolName: step.toolName,
        event: error.code === "CANCELLED"
          ? "permission.confirmation.cancelled"
          : "permission.confirmation.rejected",
        message: error.message,
        data: { confirmationId: confirmation.id }
      });

      if (error.code === "CANCELLED") {
        return finishAsCancelled(updateStep(nextPlan, step.id, (current) => ({
          ...current,
          status: "cancelled",
          error,
          finishedAt: Date.now()
        })), error);
      }

      return failStepAndTask(nextPlan, step.id, error);
    }

    appendExecutionLog({
      taskId: nextPlan.id,
      stepId: step.id,
      toolName: step.toolName,
      event: "permission.confirmation.approved",
      message: `用户已确认：${step.title}`,
      data: { confirmationId: confirmation.id }
    });

    nextPlan = setTaskStatus(nextPlan, "running");
    nextPlan = updateStep(nextPlan, step.id, (current) => ({
      ...current,
      status: "ready"
    }));
  }

  if (controller.signal.aborted) {
    return finishAsCancelled(
      nextPlan,
      createToolError("CANCELLED", "任务已取消", undefined, false)
    );
  }

  const maxRetries = tool.maxRetries ?? 0;
  let attempt = 0;
  let lastError: ToolError | undefined;

  while (attempt <= maxRetries) {
    attempt += 1;

    nextPlan = updateStep(nextPlan, step.id, (current) => ({
      ...current,
      status: "running",
      attempt,
      startedAt: Date.now(),
      finishedAt: undefined,
      error: undefined,
      result: undefined
    }));
    nextPlan = {
      ...nextPlan,
      currentStepId: step.id,
      updatedAt: Date.now()
    };
    emitPlan(nextPlan, options, `执行中：${step.title}`);

    const result = await executeToolCall({
      taskId: nextPlan.id,
      stepId: step.id,
      toolName: step.toolName,
      input: step.input,
      signal: controller.signal,
      attempt
    });

    if (result.ok) {
      return updateStep(nextPlan, step.id, (current) => ({
        ...current,
        status: "succeeded",
        finishedAt: Date.now(),
        result
      }));
    }

    lastError = result.error;
    const canRetry =
      result.error.retriable
      && attempt <= maxRetries
      && result.error.code !== "CANCELLED"
      && !controller.signal.aborted;

    nextPlan = updateStep(nextPlan, step.id, (current) => ({
      ...current,
      status: result.error.code === "CANCELLED" ? "cancelled" : "failed",
      finishedAt: Date.now(),
      result,
      error: result.error
    }));

    if (result.error.code === "CANCELLED" || controller.signal.aborted) {
      return finishAsCancelled(nextPlan, result.error);
    }

    if (!canRetry) {
      break;
    }

    appendExecutionLog({
      level: "warn",
      taskId: nextPlan.id,
      stepId: step.id,
      toolName: step.toolName,
      event: "tool.execute.retry",
      message: `准备重试 ${step.toolName}（第 ${attempt + 1} 次尝试）`,
      data: { attempt, maxRetries, code: result.error.code }
    });
  }

  let finalError =
    lastError ?? createToolError("EXECUTION_FAILED", "步骤执行失败", undefined, false);

  if (finalError.retriable && attempt > maxRetries) {
    finalError = createToolError(
      "RETRY_EXHAUSTED",
      `重试耗尽：${finalError.message}`,
      { originalCode: finalError.code, attempts: attempt },
      false
    );
    nextPlan = updateStep(nextPlan, step.id, (current) => ({
      ...current,
      status: "failed",
      error: finalError,
      result: { ok: false, error: finalError },
      finishedAt: current.finishedAt ?? Date.now()
    }));
  }

  return failStepAndTask(nextPlan, step.id, finalError);
}

function resolveDynamicRisk(
  step: TaskStep,
  toolRisk: RiskLevel,
  input: unknown
): RiskLevel | undefined {
  if (step.riskLevel) {
    return step.riskLevel;
  }

  // echo 约定：requireConfirm=true 时抬升到 L2，用于验证确认流
  if (
    toolRisk === "L0"
    && input
    && typeof input === "object"
    && (input as { requireConfirm?: unknown }).requireConfirm === true
  ) {
    return "L2";
  }

  return undefined;
}

async function waitForConfirmation(
  request: ConfirmationRequest,
  options: TaskRunnerOptions,
  signal: AbortSignal
): Promise<ConfirmationDecision> {
  if (signal.aborted) {
    return {
      requestId: request.id,
      approved: false,
      decidedAt: Date.now(),
      note: "任务已取消"
    };
  }

  if (!options.requestConfirmation) {
    // 无确认回调时拒绝敏感步骤，绝不静默执行 L2/L3
    return {
      requestId: request.id,
      approved: false,
      decidedAt: Date.now(),
      note: "未提供确认回调，拒绝执行敏感步骤"
    };
  }

  return new Promise<ConfirmationDecision>((resolve) => {
    let settled = false;
    const finish = (decision: ConfirmationDecision) => {
      if (settled) {
        return;
      }
      settled = true;
      signal.removeEventListener("abort", onAbort);
      resolve(decision);
    };
    const onAbort = () => finish({
      requestId: request.id,
      approved: false,
      decidedAt: Date.now(),
      note: "任务已取消"
    });
    signal.addEventListener("abort", onAbort, { once: true });
    void options.requestConfirmation?.(request).then(finish, () => finish({
      requestId: request.id,
      approved: false,
      decidedAt: Date.now(),
      note: "确认请求失败"
    }));
  });
}

function pickNextStepId(plan: TaskPlan, readyStepIds: string[]) {
  for (const step of plan.steps) {
    if (readyStepIds.includes(step.id)) {
      return step.id;
    }
  }
  return readyStepIds[0];
}

function concludeWhenNoReadySteps(plan: TaskPlan): TaskPlan {
  const hasFailed = plan.steps.some((step) => step.status === "failed");
  const hasCancelled = plan.steps.some((step) => step.status === "cancelled");
  const allDone = plan.steps.every(
    (step) =>
      step.status === "succeeded"
      || step.status === "failed"
      || step.status === "cancelled"
      || step.status === "skipped"
  );

  if (!allDone) {
    return finishAsFailed(
      plan,
      createToolError("INTERNAL_ERROR", "没有可执行步骤，任务无法继续", undefined, false)
    );
  }

  if (hasCancelled && !plan.steps.some((step) => step.status === "succeeded") && !hasFailed) {
    return finishAsCancelled(
      plan,
      createToolError("CANCELLED", "任务已取消", undefined, false)
    );
  }

  if (hasFailed) {
    const failedStep = plan.steps.find((step) => step.status === "failed");
    return finishAsFailed(
      plan,
      failedStep?.error
        ?? createToolError("EXECUTION_FAILED", "存在失败步骤", undefined, false)
    );
  }

  if (hasCancelled) {
    // 有成功也有取消：按取消收尾（用户中途取消）
    return finishAsCancelled(
      plan,
      createToolError("CANCELLED", "任务已取消", undefined, false)
    );
  }

  return finishAsSucceeded(plan);
}

function finishAsSucceeded(plan: TaskPlan): TaskPlan {
  const next: TaskPlan = {
    ...plan,
    status: "succeeded",
    finishedAt: Date.now(),
    updatedAt: Date.now()
  };
  return {
    ...next,
    report: buildTaskReport(next)
  };
}

function finishAsFailed(plan: TaskPlan, error: ToolError): TaskPlan {
  const next: TaskPlan = {
    ...plan,
    status: "failed",
    error,
    finishedAt: Date.now(),
    updatedAt: Date.now()
  };
  return {
    ...next,
    report: buildTaskReport(next)
  };
}

function finishAsCancelled(plan: TaskPlan, error: ToolError): TaskPlan {
  const next: TaskPlan = {
    ...plan,
    status: "cancelled",
    error,
    finishedAt: Date.now(),
    updatedAt: Date.now(),
    steps: plan.steps.map((step) => {
      if (
        step.status === "pending"
        || step.status === "ready"
        || step.status === "waiting_confirmation"
        || step.status === "running"
      ) {
        return {
          ...step,
          status: "cancelled" as const,
          finishedAt: Date.now(),
          error
        };
      }
      return step;
    })
  };

  releaseTaskResources(next.id);

  return {
    ...next,
    report: buildTaskReport(next)
  };
}

function failStepAndTask(plan: TaskPlan, stepId: string, error: ToolError): TaskPlan {
  let next = updateStep(plan, stepId, (current) => ({
    ...current,
    status: "failed" as const,
    error,
    result: { ok: false, error },
    finishedAt: current.finishedAt ?? Date.now()
  }));
  next = markBlockedStepsSkipped(next);
  return finishAsFailed(next, error);
}

function setTaskStatus(plan: TaskPlan, status: TaskStatus): TaskPlan {
  if (plan.status === status) {
    return plan;
  }
  return {
    ...plan,
    status,
    updatedAt: Date.now()
  };
}

function updateStep(
  plan: TaskPlan,
  stepId: string,
  updater: (step: TaskStep) => TaskStep
): TaskPlan {
  return {
    ...plan,
    steps: plan.steps.map((step) => (step.id === stepId ? updater(step) : step)),
    updatedAt: Date.now()
  };
}

function buildTaskReport(plan: TaskPlan): TaskReport {
  const succeededStepCount = plan.steps.filter((step) => step.status === "succeeded").length;
  const failedStepCount = plan.steps.filter((step) => step.status === "failed").length;
  const cancelledStepCount = plan.steps.filter((step) => step.status === "cancelled").length;

  let status: TaskReport["status"];
  if (plan.status === "succeeded") {
    status = "succeeded";
  } else if (plan.status === "cancelled" || plan.status === "cancelling") {
    status = "cancelled";
  } else {
    status = "failed";
  }

  const stepSummaries = plan.steps.map((step) => ({
    stepId: step.id,
    title: step.title,
    toolName: step.toolName,
    status: step.status,
    summary: step.result && step.result.ok ? step.result.summary : undefined,
    errorMessage: step.error?.message
      ?? (step.result && !step.result.ok ? step.result.error.message : undefined)
  }));

  let message: string;
  if (status === "succeeded") {
    message = `任务完成：${plan.goal}（${succeededStepCount}/${plan.steps.length} 步成功）`;
  } else if (status === "cancelled") {
    message = `任务已取消：${plan.goal}`;
  } else {
    message = `任务失败：${plan.error?.message ?? plan.goal}`;
  }

  return {
    goal: plan.goal,
    status,
    stepCount: plan.steps.length,
    succeededStepCount,
    failedStepCount,
    cancelledStepCount,
    stepSummaries,
    message
  };
}

function describePlanProgress(plan: TaskPlan) {
  const current = plan.steps.find((step) => step.id === plan.currentStepId);
  if (current) {
    return `当前步骤：${current.title}（${current.status}）`;
  }
  return `任务状态：${plan.status}`;
}

function emitPlan(plan: TaskPlan, options: TaskRunnerOptions, message: string) {
  const current = plan.steps.find((step) => step.id === plan.currentStepId);
  const completedSteps = plan.steps.filter(
    (step) =>
      step.status === "succeeded"
      || step.status === "failed"
      || step.status === "cancelled"
      || step.status === "skipped"
  ).length;

  setTaskProgress({
    taskId: plan.id,
    status: plan.status,
    goal: plan.goal,
    currentStepId: plan.currentStepId,
    currentStepTitle: current?.title,
    currentToolName: current?.toolName,
    completedSteps,
    totalSteps: plan.steps.length,
    message,
    updatedAt: Date.now()
  });

  options.onPlanUpdate?.(plan);
}

function finalize(plan: TaskPlan): TaskRunResult {
  const report = plan.report ?? buildTaskReport(plan);
  return {
    plan: {
      ...plan,
      report
    },
    report
  };
}

// 供冒烟脚本构造多步草稿时复用类型导出路径
export type { TaskStepDraft };

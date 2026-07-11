// 任务规划器：把步骤草稿编译成可检查的 TaskPlan。
// 阶段 B 不接模型自动规划；由调用方给出显式步骤。

import { getTool } from "../tools/toolRegistry";
import { createToolError } from "../tools/toolErrors";
import type { CreateTaskRequest, TaskPlan, TaskStep, TaskStepDraft } from "./taskTypes";

let taskSequence = 0;
let stepSequence = 0;

function nextTaskId() {
  taskSequence += 1;
  return `task_${Date.now().toString(36)}_${taskSequence}`;
}

function nextStepId() {
  stepSequence += 1;
  return `step_${Date.now().toString(36)}_${stepSequence}`;
}

/**
 * 创建初始任务计划。仅做结构与工具存在性检查，Schema 校验留给执行器。
 */
export function createTaskPlan(request: CreateTaskRequest): TaskPlan {
  const goal = request.goal.trim();
  if (!goal) {
    throw new Error("任务 goal 不能为空");
  }
  if (!request.steps.length) {
    throw new Error("任务至少需要一个步骤");
  }

  const now = Date.now();
  const steps = compileSteps(request.steps);
  validateDependencies(steps);

  return {
    id: request.taskId?.trim() || nextTaskId(),
    goal,
    version: 1,
    status: "queued",
    steps,
    createdAt: now,
    updatedAt: now
  };
}

/**
 * 进入 planning 态时做一次静态体检：工具是否注册/启用。
 * 返回 null 表示通过；否则返回失败用的 ToolError。
 */
export function inspectPlanTools(plan: TaskPlan) {
  for (const step of plan.steps) {
    const tool = getTool(step.toolName);
    if (!tool) {
      return createToolError(
        "TOOL_NOT_FOUND",
        `未注册工具：${step.toolName}`,
        { stepId: step.id, toolName: step.toolName },
        false
      );
    }
    if (tool.enabled === false) {
      return createToolError(
        "TOOL_DISABLED",
        `工具已禁用：${step.toolName}`,
        { stepId: step.id, toolName: step.toolName },
        false
      );
    }
  }
  return null;
}

/**
 * 根据当前步骤状态，找出依赖已满足且仍 pending 的下一步。
 */
export function listReadyStepIds(plan: TaskPlan): string[] {
  const statusById = new Map(plan.steps.map((step) => [step.id, step.status]));
  const ready: string[] = [];

  for (const step of plan.steps) {
    if (step.status !== "pending" && step.status !== "ready") {
      continue;
    }

    const dependenciesMet = step.dependsOn.every((dependencyId) => {
      return statusById.get(dependencyId) === "succeeded";
    });

    if (dependenciesMet) {
      ready.push(step.id);
    }
  }

  return ready;
}

/**
 * 依赖失败时，标记尚未开始的下游步骤为 skipped。
 */
export function markBlockedStepsSkipped(plan: TaskPlan): TaskPlan {
  const statusById = new Map(plan.steps.map((step) => [step.id, step.status]));
  const nextSteps = plan.steps.map((step) => {
    if (step.status !== "pending" && step.status !== "ready" && step.status !== "waiting_confirmation") {
      return step;
    }

    const hasFailedDependency = step.dependsOn.some((dependencyId) => {
      const dependencyStatus = statusById.get(dependencyId);
      return dependencyStatus === "failed" || dependencyStatus === "cancelled" || dependencyStatus === "skipped";
    });

    if (!hasFailedDependency) {
      return step;
    }

    return {
      ...step,
      status: "skipped" as const,
      finishedAt: Date.now(),
      error: createToolError(
        "DEPENDENCY_FAILED",
        "依赖步骤未成功，本步已跳过",
        { dependsOn: step.dependsOn },
        false
      )
    };
  });

  return {
    ...plan,
    steps: nextSteps,
    updatedAt: Date.now()
  };
}

function compileSteps(drafts: TaskStepDraft[]): TaskStep[] {
  const usedIds = new Set<string>();

  return drafts.map((draft, index) => {
    const toolName = draft.toolName.trim();
    if (!toolName) {
      throw new Error(`第 ${index + 1} 步 toolName 不能为空`);
    }
    if (!draft.title.trim()) {
      throw new Error(`第 ${index + 1} 步 title 不能为空`);
    }

    let id = draft.id?.trim() || nextStepId();
    if (usedIds.has(id)) {
      throw new Error(`步骤 id 重复：${id}`);
    }
    usedIds.add(id);

    return {
      id,
      title: draft.title.trim(),
      toolName,
      input: draft.input,
      dependsOn: [...(draft.dependsOn ?? [])],
      riskLevel: draft.riskLevel,
      status: "pending",
      attempt: 0
    };
  });
}

function validateDependencies(steps: TaskStep[]) {
  const ids = new Set(steps.map((step) => step.id));

  for (const step of steps) {
    for (const dependencyId of step.dependsOn) {
      if (!ids.has(dependencyId)) {
        throw new Error(`步骤 ${step.id} 依赖不存在的步骤：${dependencyId}`);
      }
      if (dependencyId === step.id) {
        throw new Error(`步骤 ${step.id} 不能依赖自己`);
      }
    }
  }

  // 简单环检测：Kahn
  const indegree = new Map<string, number>();
  const graph = new Map<string, string[]>();
  for (const step of steps) {
    indegree.set(step.id, 0);
    graph.set(step.id, []);
  }
  for (const step of steps) {
    for (const dependencyId of step.dependsOn) {
      graph.get(dependencyId)?.push(step.id);
      indegree.set(step.id, (indegree.get(step.id) ?? 0) + 1);
    }
  }

  const queue = steps.filter((step) => (indegree.get(step.id) ?? 0) === 0).map((step) => step.id);
  let visited = 0;
  while (queue.length > 0) {
    const current = queue.shift() as string;
    visited += 1;
    for (const next of graph.get(current) ?? []) {
      const nextDegree = (indegree.get(next) ?? 0) - 1;
      indegree.set(next, nextDegree);
      if (nextDegree === 0) {
        queue.push(next);
      }
    }
  }

  if (visited !== steps.length) {
    throw new Error("步骤依赖存在环");
  }
}

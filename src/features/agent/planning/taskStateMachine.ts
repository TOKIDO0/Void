// 集中状态机：任务/步骤合法迁移。非法迁移直接抛错，避免静默跳状态。

import type { StepStatus, TaskStatus } from "./taskTypes";

const TASK_TRANSITIONS: Record<TaskStatus, readonly TaskStatus[]> = {
  queued: ["planning", "cancelled"],
  planning: ["waiting_confirmation", "running", "failed", "cancelled"],
  waiting_confirmation: ["running", "cancelled", "failed"],
  running: ["paused", "cancelling", "succeeded", "failed", "cancelled"],
  paused: ["running", "cancelling", "cancelled"],
  cancelling: ["cancelled"],
  succeeded: [],
  failed: [],
  cancelled: []
};

const STEP_TRANSITIONS: Record<StepStatus, readonly StepStatus[]> = {
  pending: ["waiting_confirmation", "ready", "running", "skipped", "cancelled"],
  waiting_confirmation: ["ready", "running", "cancelled", "failed"],
  ready: ["running", "cancelled", "skipped"],
  running: ["succeeded", "failed", "cancelled"],
  succeeded: [],
  failed: [],
  cancelled: [],
  skipped: []
};

export function canTransitionTask(from: TaskStatus, to: TaskStatus) {
  return TASK_TRANSITIONS[from].includes(to);
}

export function canTransitionStep(from: StepStatus, to: StepStatus) {
  return STEP_TRANSITIONS[from].includes(to);
}

export function assertTaskTransition(from: TaskStatus, to: TaskStatus) {
  if (!canTransitionTask(from, to)) {
    throw new Error(`非法任务状态迁移：${from} → ${to}`);
  }
}

export function assertStepTransition(from: StepStatus, to: StepStatus) {
  if (!canTransitionStep(from, to)) {
    throw new Error(`非法步骤状态迁移：${from} → ${to}`);
  }
}

export function isTerminalTaskStatus(status: TaskStatus) {
  return status === "succeeded" || status === "failed" || status === "cancelled";
}

export function isTerminalStepStatus(status: StepStatus) {
  return (
    status === "succeeded"
    || status === "failed"
    || status === "cancelled"
    || status === "skipped"
  );
}

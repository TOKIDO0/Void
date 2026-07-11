// 任务计划与步骤状态类型。
// 设计依据：`.md/27` §5.2 / §7.3。

import type { RiskLevel, ToolError, ToolResult } from "../tools/toolTypes";

/**
 * 任务级状态机：
 * queued → planning → waiting_confirmation → running
 * running → paused / cancelling / succeeded / failed / cancelled
 */
export type TaskStatus =
  | "queued"
  | "planning"
  | "waiting_confirmation"
  | "running"
  | "paused"
  | "cancelling"
  | "succeeded"
  | "failed"
  | "cancelled";

/**
 * 步骤级状态。
 */
export type StepStatus =
  | "pending"
  | "waiting_confirmation"
  | "ready"
  | "running"
  | "succeeded"
  | "failed"
  | "cancelled"
  | "skipped";

/**
 * 计划中的单一步骤。
 */
export type TaskStep = {
  id: string;
  title: string;
  toolName: string;
  input: unknown;
  /** 依赖的步骤 id；全部 succeeded 后才可执行 */
  dependsOn: string[];
  /** 步骤风险；缺省时使用工具定义的 riskLevel */
  riskLevel?: RiskLevel;
  status: StepStatus;
  attempt: number;
  startedAt?: number;
  finishedAt?: number;
  result?: ToolResult;
  error?: ToolError;
};

/**
 * 完整任务计划。
 */
export type TaskPlan = {
  id: string;
  goal: string;
  version: number;
  status: TaskStatus;
  steps: TaskStep[];
  createdAt: number;
  updatedAt: number;
  startedAt?: number;
  finishedAt?: number;
  /** 用户可见的当前步骤说明 */
  currentStepId?: string;
  /** 任务失败时的顶层错误 */
  error?: ToolError;
  /** 任务完成后的结构化汇报摘要 */
  report?: TaskReport;
};

/**
 * 任务汇报：给用户看的结果。
 */
export type TaskReport = {
  goal: string;
  status: Extract<TaskStatus, "succeeded" | "failed" | "cancelled">;
  stepCount: number;
  succeededStepCount: number;
  failedStepCount: number;
  cancelledStepCount: number;
  /** 各步摘要 */
  stepSummaries: Array<{
    stepId: string;
    title: string;
    toolName: string;
    status: StepStatus;
    summary?: string;
    errorMessage?: string;
  }>;
  /** 一句话结论 */
  message: string;
};

/**
 * 创建计划时的步骤草稿（尚无运行时状态）。
 */
export type TaskStepDraft = {
  id?: string;
  title: string;
  toolName: string;
  input: unknown;
  dependsOn?: string[];
  riskLevel?: RiskLevel;
};

/**
 * 创建任务请求。
 */
export type CreateTaskRequest = {
  goal: string;
  steps: TaskStepDraft[];
  taskId?: string;
};

// 执行器相关类型。

import type { ConfirmationDecision, ConfirmationRequest, RiskPolicy } from "../permissions";
import type { TaskPlan, TaskReport } from "../planning";
import type { ToolError } from "../tools";
import type { PermissionGrants } from "../permissions";

/**
 * 执行器运行选项。
 */
export type TaskRunnerOptions = {
  /** 用户确认回调：弹出确认并等待决策 */
  requestConfirmation?: (request: ConfirmationRequest) => Promise<ConfirmationDecision>;
  /** 风险策略覆盖 */
  riskPolicy?: RiskPolicy;
  /** 计划变更回调（用于前端绑定进度） */
  onPlanUpdate?: (plan: TaskPlan) => void;
  /** 外部取消信号 */
  signal?: AbortSignal;
  permissionGrants?: PermissionGrants;
};

/**
 * 单步执行内部结果。
 */
export type StepExecutionOutcome =
  | { kind: "succeeded"; plan: TaskPlan }
  | { kind: "failed"; plan: TaskPlan; error: ToolError }
  | { kind: "cancelled"; plan: TaskPlan; error: ToolError }
  | { kind: "waiting_confirmation"; plan: TaskPlan; confirmation: ConfirmationRequest };

/**
 * 任务运行结果。
 */
export type TaskRunResult = {
  plan: TaskPlan;
  report: TaskReport;
};

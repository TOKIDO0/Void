// 权限与确认类型。设计依据：`.md/27` §5.4。

import type { RiskLevel } from "../tools/toolTypes";

/**
 * 确认请求：展示给用户「将要做什么」。
 */
export type ConfirmationRequest = {
  id: string;
  taskId: string;
  stepId: string;
  toolName: string;
  riskLevel: RiskLevel;
  title: string;
  /** 人类可读说明 */
  description: string;
  /** 参数摘要（已脱敏） */
  inputSummary: Record<string, unknown>;
  createdAt: number;
};

/**
 * 用户对确认请求的响应。
 */
export type ConfirmationDecision = {
  requestId: string;
  approved: boolean;
  decidedAt: number;
  /** 可选备注 */
  note?: string;
};

/**
 * 风险策略：决定某 riskLevel 是否需要确认。
 */
export type RiskPolicy = {
  /** L0 是否自动 */
  autoL0: boolean;
  autoL1: boolean;
  /** L2 是否要求确认 */
  requireConfirmL2: boolean;
  requireConfirmL3: boolean;
};

export const DEFAULT_RISK_POLICY: RiskPolicy = {
  autoL0: true,
  autoL1: true,
  requireConfirmL2: true,
  requireConfirmL3: true
};

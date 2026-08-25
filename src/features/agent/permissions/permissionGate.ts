// 权限门：按风险等级判断是否需要用户确认。

import type { RiskLevel } from "../tools/toolTypes";
import {
  DEFAULT_RISK_POLICY,
  type ConfirmationRequest,
  type RiskPolicy
} from "./permissionTypes";
import { resolveEffectiveStaticRiskLevel } from "./riskLevelPolicy";

let confirmationSequence = 0;

export function requiresUserConfirmation(
  riskLevel: RiskLevel,
  policy: RiskPolicy = DEFAULT_RISK_POLICY
) {
  switch (riskLevel) {
    case "L0":
      return !policy.autoL0;
    case "L1":
      return !policy.autoL1;
    case "L2":
      return policy.requireConfirmL2;
    case "L3":
      return policy.requireConfirmL3;
    default:
      return true;
  }
}

/**
 * 构造确认请求。不直接弹 UI；由宿主通过 hooks 展示。
 */
export function createConfirmationRequest(params: {
  taskId: string;
  stepId: string;
  toolName: string;
  riskLevel: RiskLevel;
  title: string;
  description: string;
  inputSummary: Record<string, unknown>;
}): ConfirmationRequest {
  confirmationSequence += 1;
  return {
    id: `confirm_${Date.now().toString(36)}_${confirmationSequence}`,
    taskId: params.taskId,
    stepId: params.stepId,
    toolName: params.toolName,
    riskLevel: params.riskLevel,
    title: params.title,
    description: params.description,
    inputSummary: params.inputSummary,
    createdAt: Date.now()
  };
}

/**
 * 步骤可覆盖工具默认风险：
 * - 工具本身 L0，但 input 要求确认时，由调用方传入 effectiveRiskLevel=L2
 * 高权限模式下静态 L2→L1，但动态安全 hook 抬升的 L2（如敏感文件读取）保持——
 * 高权限 ≠ 放行密钥文件。
 */
export function resolveEffectiveRiskLevel(
  toolRiskLevel: RiskLevel,
  stepRiskLevel?: RiskLevel
): RiskLevel {
  if (stepRiskLevel) {
    return stepRiskLevel;
  }
  return resolveEffectiveStaticRiskLevel(toolRiskLevel);
}

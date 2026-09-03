// 根因钩子：抓 turn 路由/权限/情绪门禁的完整决策链，非补丁式修复
// 设计：每次 resolveTurnCapability 后，由 voidConversation 调用，落 observability 日志

import type { TurnCapabilityRoute } from "../turnRouting/turnCapabilityRouter";
import type { PermissionGrants } from "../permissions/permissionGrants";
import { getTool } from "../tools/toolRegistry";
import { appendExecutionLog } from "../observability";

export type TurnDiagnostic = {
  input: string;
  route: TurnCapabilityRoute;
  grants: string[];
  blockedByAffect: boolean;
  l0BypassApplied: boolean;
  allowedAfterAffect: string[];
  timestamp: number;
};

export function emitTurnDiagnostic(
  input: string,
  route: TurnCapabilityRoute,
  grants: PermissionGrants,
  blockedByAffect: boolean,
  effectiveAllowed: string[]
): TurnDiagnostic {
  const diag: TurnDiagnostic = {
    input: input.slice(0, 200),
    route,
    grants: Array.from(grants).slice(0, 20),
    blockedByAffect,
    l0BypassApplied: blockedByAffect && effectiveAllowed.length > 0 && effectiveAllowed.length < route.allowedToolNames.length,
    allowedAfterAffect: effectiveAllowed,
    timestamp: Date.now()
  };
  appendExecutionLog({
    taskId: `turn_diag_${Date.now().toString(36)}`,
    event: "turn.diagnostic",
    message: `路由诊断: ${route.capability} -> ${effectiveAllowed.length} 工具 (阻塞:${blockedByAffect})`,
    data: diag as unknown as Record<string, unknown>
  });
  // 同时 console 便于本机调试时直接看到
  if (typeof console !== "undefined" && console.debug) {
    console.debug("[turnDiagnostic]", JSON.stringify(diag, null, 2));
  }
  return diag;
}

export function diagnoseToolCall(
  toolName: string,
  input: unknown,
  grants: PermissionGrants
): { toolExists: boolean; risk: string | null; hasPermission: boolean; wouldPassSchema: boolean } {
  const tool = getTool(toolName);
  if (!tool) return { toolExists: false, risk: null, hasPermission: false, wouldPassSchema: false };
  const hasPermission = tool.permissions.every((p) => grants.has(p));
  return {
    toolExists: true,
    risk: tool.riskLevel,
    hasPermission,
    wouldPassSchema: true // 实际校验在 toolExecutor 层
  };
}

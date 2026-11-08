/**
 * 工具失败回灌（模型可见）：把 ToolError 压成可读失败对象。
 *
 * 设计约束（`.md/57` 阶段 1）：
 * - 只给有依据的原因：原因写在 reason 里，认不出就是 unknown，禁止猜；
 * - 可重试条件显式下放（retriable），避免模型把鉴权/策略拒绝当瞬时故障反复重试；
 * - 下一步必须是静态、可执行、与错误码一一对应的提示，禁止把原始 message
 *   或 details 拼进提示里（可能含路径、URL、网页内容等不可信数据）；
 * - 只传排错必需的结构化标记（bridgeUnreachable / fileCode / desktopCode /
 *   failureKind / allowedRoots），其余细节不下发，防止刷上下文或泄露。
 */

import { sanitizeToolErrorMessage } from "../tools/sanitizeToolError";

/**
 * 失败回灌的最小输入形状。
 * ToolError 直接满足；循环层自造的终态码（预算耗尽/熔断/关系门禁）也走同一入口。
 */
export type ToolFailureInput = {
  code: string;
  message: string;
  retriable: boolean;
  details?: Record<string, unknown>;
};

type FailureHint = {
  reason: string;
  nextStep?: string;
  doNotRepeat?: boolean;
};

/** 已知原因 → 可执行下一步。键是 failureKind（小写下划线）或 ToolErrorCode。 */
const FAILURE_HINTS: Record<string, FailureHint> = {
  bridge_unreachable: {
    reason: "bridge_unreachable",
    nextStep: "先请用户启动 VOID 桌面端或本机服务；在服务恢复前不要重复调用依赖本机的工具。",
    doNotRepeat: true
  },
  bridge_auth_failed: {
    reason: "bridge_auth_failed",
    nextStep: "本机服务的 token/来源校验失败，重复调用不会通过；请用户重启 VOID 桌面端或本机服务后再试。",
    doNotRepeat: true
  },
  key_invalid: {
    reason: "key_invalid",
    nextStep: "请用户到设置里检查对应服务的 Key；不要重复调用，也不要擅自改用其它服务重试。",
    doNotRepeat: true
  },
  rate_limited: {
    reason: "rate_limited",
    nextStep: "等待一段时间再试，或改用用户已授权的其它来源；不要连续重试。"
  },
  timeout: {
    reason: "timeout",
    nextStep: "缩小范围（更短查询、更小文件、更窄路径）后最多再试一次；仍超时就如实说明。"
  },
  invalid_request: {
    reason: "invalid_request",
    nextStep: "按错误信息修正参数后重试；不要原样重复同一调用。"
  },
  path_not_allowed: {
    reason: "path_not_allowed",
    nextStep: "改用 allowedRoots 之内的路径；不要重复同一路径。",
    doNotRepeat: true
  },
  file_not_found: {
    reason: "file_not_found",
    nextStep: "先用 file.inspectPath 或 file.listDirectory 确认真实路径，再重新操作。"
  },
  destination_exists: {
    reason: "destination_exists",
    nextStep: "改用 conflictPolicy=rename，或先询问用户是否覆盖。"
  },
  too_large: {
    reason: "too_large",
    nextStep: "换更小的读取范围或更短的输入后重试；不要原样重复。"
  },
  permission_denied: {
    reason: "permission_denied",
    nextStep: "该操作没有获得授权，重复调用不会通过；请如实说明并向用户请求授权。",
    doNotRepeat: true
  },
  confirmation_required: {
    reason: "confirmation_required",
    nextStep: "当前没有可用的确认通道；请如实说明需要用户确认，不要重复调用。",
    doNotRepeat: true
  },
  confirmation_rejected: {
    reason: "confirmation_rejected",
    nextStep: "用户已拒绝，禁止再次请求同一操作；只有用户重新提出时才可再做。",
    doNotRepeat: true
  },
  tool_not_found: {
    reason: "tool_not_found",
    nextStep: "该工具未注册，不要再调用它；改用当前工具列表里存在的工具。",
    doNotRepeat: true
  },
  tool_disabled: {
    reason: "tool_disabled",
    nextStep: "该工具已禁用，重复调用无效；如实说明并给出可用的替代做法。",
    doNotRepeat: true
  },
  resource_busy: {
    reason: "resource_busy",
    nextStep: "同一资源正被其它任务占用；等当前任务结束后再试，不要在同轮反复抢占。"
  },
  cancelled: {
    reason: "cancelled",
    nextStep: "已按用户要求取消，不要自动重试。",
    doNotRepeat: true
  },
  dependency_failed: {
    reason: "dependency_failed",
    nextStep: "本机缺少必要依赖；告诉用户需要安装或启用什么，不要反复尝试。",
    doNotRepeat: true
  },
  output_schema_invalid: {
    reason: "output_schema_invalid",
    nextStep: "工具返回结构不符合契约（本机缺陷），不要重试同一调用，如实说明。",
    doNotRepeat: true
  },
  retry_exhausted: {
    reason: "retry_exhausted",
    nextStep: "重试次数已用尽，不要继续重试，如实说明卡点。",
    doNotRepeat: true
  },
  internal_error: {
    reason: "internal_error",
    nextStep: "本机内部错误；最多换一次更保守的做法，仍失败就如实说明。"
  },
  tool_budget_exceeded: {
    reason: "tool_budget_exceeded",
    nextStep: "不要再调用工具；基于已有结果直接回答，或如实说明还缺什么。",
    doNotRepeat: true
  },
  tool_streak_breaker: {
    reason: "tool_streak_breaker",
    nextStep: "不要重复同一调用；换策略，或如实说明卡在哪个工具和错误码。",
    doNotRepeat: true
  },
  affect_tool_gate_blocked: {
    reason: "affect_tool_gate_blocked",
    nextStep: "本轮非安全工具已被真实关闭；如实说明没有执行，请用户重新提出。",
    doNotRepeat: true
  }
};

const UNKNOWN_HINT: FailureHint = { reason: "unknown" };

/** ToolErrorCode → 已知原因键（仅在有明确含义时映射，其余走 unknown）。 */
const CODE_TO_REASON_KEY: Record<string, string> = {
  TOOL_NOT_FOUND: "tool_not_found",
  TOOL_DISABLED: "tool_disabled",
  SCHEMA_INVALID: "invalid_request",
  TIMEOUT: "timeout",
  CANCELLED: "cancelled",
  RESOURCE_BUSY: "resource_busy",
  RETRY_EXHAUSTED: "retry_exhausted",
  DEPENDENCY_FAILED: "dependency_failed",
  OUTPUT_SCHEMA_INVALID: "output_schema_invalid",
  PERMISSION_DENIED: "permission_denied",
  CONFIRMATION_REQUIRED: "confirmation_required",
  CONFIRMATION_REJECTED: "confirmation_rejected",
  INTERNAL_ERROR: "internal_error",
  // 循环层终态码（不是 ToolErrorCode，但同样需要原因与下一步）
  TOOL_BUDGET_EXCEEDED: "tool_budget_exceeded",
  TOOL_STREAK_BREAKER: "tool_streak_breaker",
  AFFECT_TOOL_GATE_BLOCKED: "affect_tool_gate_blocked"
};

function resolveFailureHint(error: ToolFailureInput): FailureHint {
  const details = error.details ?? {};

  if (details.bridgeUnreachable === true) {
    return FAILURE_HINTS.bridge_unreachable;
  }

  // 更具体的 failureKind 优先（file/desktop/web 工具都会带上）。
  const failureKind = typeof details.failureKind === "string"
    ? details.failureKind.trim().toLowerCase()
    : "";
  if (failureKind && FAILURE_HINTS[failureKind]) {
    return FAILURE_HINTS[failureKind];
  }

  // 再退回工具级错误码（如 fileCode=FILE_NOT_FOUND）。
  for (const key of ["fileCode", "desktopCode"] as const) {
    const value = typeof details[key] === "string" ? details[key]!.trim().toLowerCase() : "";
    if (value && FAILURE_HINTS[value]) {
      return FAILURE_HINTS[value];
    }
  }

  const byCode = CODE_TO_REASON_KEY[error.code];
  return byCode ? FAILURE_HINTS[byCode] : UNKNOWN_HINT;
}

/**
 * 把 ToolError 压成回灌模型的可读失败对象。
 * 顺序固定：code/message/retriable/reason → 下一步提示 → 结构化排错标记。
 */
export function buildToolFailureRelay(error: ToolFailureInput): Record<string, unknown> {
  const details = error.details ?? {};
  const hint = resolveFailureHint(error);

  const relay: Record<string, unknown> = {
    code: error.code,
    message: sanitizeToolErrorMessage(error.message).replace(/^\[TOOL_ERROR\] /, ""),
    // 有一个可重试判断，避免模型把不可重试错误当作瞬时故障反复烧预算。
    retriable: error.retriable,
    reason: hint.reason
  };

  if (hint.nextStep) {
    relay.nextStep = hint.nextStep;
  }
  if (hint.doNotRepeat) {
    relay.doNotRepeat = true;
  }

  if (details.bridgeUnreachable === true) {
    relay.bridgeUnreachable = true;
  }

  const fileCode = typeof details.fileCode === "string" ? details.fileCode.trim() : "";
  if (fileCode) {
    relay.fileCode = fileCode;
  }

  const desktopCode =
    typeof details.desktopCode === "string" ? details.desktopCode.trim() : "";
  if (desktopCode) {
    relay.desktopCode = desktopCode;
  }

  const failureKind =
    typeof details.failureKind === "string" ? details.failureKind.trim() : "";
  if (failureKind) {
    relay.failureKind = failureKind;
  }

  const webCode = typeof details.webCode === "string" ? details.webCode.trim() : "";
  if (webCode) {
    relay.webCode = webCode;
  }

  // 允许根列表对排错有用，但保持短数组；其它细节不下发以免刷上下文。
  if (Array.isArray(details.allowedRoots)) {
    relay.allowedRoots = details.allowedRoots.slice(0, 8);
  }

  return relay;
}

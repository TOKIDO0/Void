// 工具错误工厂：统一分类错误，避免各模块字符串硬编码。

import type { ToolError, ToolErrorCode } from "./toolTypes";

const RETRIABLE_CODES: ReadonlySet<ToolErrorCode> = new Set([
  "TIMEOUT",
  "RESOURCE_BUSY",
  "EXECUTION_FAILED"
]);

export function createToolError(
  code: ToolErrorCode,
  message: string,
  details?: Record<string, unknown>,
  retriableOverride?: boolean
): ToolError {
  return {
    code,
    message,
    retriable: retriableOverride ?? RETRIABLE_CODES.has(code),
    details
  };
}

export function formatSchemaIssues(
  issues: Array<{ path: string; message: string }>
): string {
  return issues.map((issue) => `${issue.path}: ${issue.message}`).join("; ");
}

export function isAbortError(error: unknown) {
  if (!error || typeof error !== "object") {
    return false;
  }
  const name = (error as { name?: string }).name;
  return name === "AbortError";
}

export function toExecutionFailedError(error: unknown): ToolError {
  if (isAbortError(error)) {
    return createToolError("CANCELLED", "工具执行已取消", undefined, false);
  }

  const message =
    error instanceof Error
      ? error.message
      : typeof error === "string"
        ? error
        : "工具执行失败";

  return createToolError("EXECUTION_FAILED", message, undefined, true);
}

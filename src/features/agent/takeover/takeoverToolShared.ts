/**
 * 接管工具共享：输入管线串行锁 + 错误映射。
 */

import { createToolError } from "../tools/toolErrors";
import type { ToolResourceRequirement } from "../tools/toolTypes";

/** 键鼠是全局单通道：同任务输入必须串行，防交错。 */
export const TAKEOVER_INPUT_RESOURCES: ToolResourceRequirement[] = [
  {
    kind: "takeover",
    key: "input-pipeline",
    mode: "exclusive"
  }
];

export function throwAsTakeoverToolError(error: unknown): never {
  if (
    typeof error === "object"
    && error !== null
    && "takeoverCode" in error
    && (error as { takeoverCode?: unknown }).takeoverCode === "NOT_DESKTOP"
  ) {
    throw createToolError(
      "EXECUTION_FAILED",
      "接管模式仅桌面端可用（当前为 Web 预览，无键鼠直控能力）",
      { failureKind: "not_desktop" },
      false
    );
  }
  const message = error instanceof Error ? error.message : "接管操作失败";
  const denied = /白名单|黑名单|未开启|已过期|前台|scope/i.test(message);
  throw createToolError(
    "EXECUTION_FAILED",
    message,
    { failureKind: denied ? "takeover_denied" : "takeover_failed" },
    false
  );
}

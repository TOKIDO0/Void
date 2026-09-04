/**
 * 调度器工具共享：资源声明与错误映射。
 */

import { createToolError } from "../tools/toolErrors";
import type { ToolResourceRequirement } from "../tools/toolTypes";
import { getSchedulerBridgeErrorInfo } from "./schedulerBridgeClient";

/** 调度工具经回环 HTTP 访问 sidecar，共享 bridge 通道。 */
export const SCHEDULER_BRIDGE_RESOURCES: ToolResourceRequirement[] = [
  {
    kind: "network",
    key: "void-bridge",
    mode: "shared"
  }
];

export function throwAsSchedulerToolError(error: unknown): never {
  const info = getSchedulerBridgeErrorInfo(error);
  switch (info.code) {
    case "INVALID_REQUEST":
      throw createToolError("SCHEMA_INVALID", info.message, { failureKind: "invalid_request" }, false);
    case "NOT_FOUND":
      throw createToolError("EXECUTION_FAILED", info.message, { failureKind: "job_not_found" }, false);
    case "JOB_LIMIT":
      throw createToolError("EXECUTION_FAILED", info.message, { failureKind: "job_limit" }, false);
    case "TIMEOUT":
      throw createToolError("TIMEOUT", info.message, { failureKind: "timeout" }, true);
    case "BRIDGE_UNREACHABLE":
      throw createToolError(
        "EXECUTION_FAILED",
        info.message,
        { failureKind: "bridge_unreachable", bridgeUnreachable: true },
        true
      );
    default:
      throw createToolError("EXECUTION_FAILED", info.message, { failureKind: "internal_error" }, true);
  }
}

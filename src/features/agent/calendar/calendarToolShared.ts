/**
 * 日程工具共享：资源声明与错误映射。
 * 与调度器共用回环 bridge 通道，但错误码独立，避免两域互相污染。
 */

import { createToolError } from "../tools/toolErrors";
import type { ToolResourceRequirement } from "../tools/toolTypes";
import { getCalendarBridgeErrorInfo } from "./calendarBridgeClient";

export const CALENDAR_BRIDGE_RESOURCES: ToolResourceRequirement[] = [
  {
    kind: "network",
    key: "void-bridge",
    mode: "shared"
  }
];

export function throwAsCalendarToolError(error: unknown): never {
  const info = getCalendarBridgeErrorInfo(error);
  switch (info.code) {
    case "INVALID_REQUEST":
      throw createToolError("SCHEMA_INVALID", info.message, { failureKind: "invalid_request" }, false);
    case "NOT_FOUND":
      throw createToolError("EXECUTION_FAILED", info.message, { failureKind: "event_not_found", calendarCode: "NOT_FOUND" }, false);
    case "EVENT_LIMIT":
      throw createToolError("EXECUTION_FAILED", info.message, { failureKind: "event_limit", calendarCode: "EVENT_LIMIT" }, false);
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

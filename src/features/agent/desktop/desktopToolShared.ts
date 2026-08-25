/**
 * 桌面工具共享：资源声明与错误映射。
 */

import {
  createToolError,
  type ToolError,
  type ToolResourceRequirement
} from "../tools";
import { getDesktopBridgeErrorInfo } from "./desktopBridgeClient";

/** 剪贴板通道：同任务串行，避免读写交错 */
export const DESKTOP_CLIPBOARD_RESOURCES: ToolResourceRequirement[] = [
  {
    kind: "desktop",
    key: "clipboard",
    mode: "exclusive"
  }
];

/** 资源管理器展示：同任务串行，避免连续弹窗 */
export const DESKTOP_REVEAL_RESOURCES: ToolResourceRequirement[] = [
  {
    kind: "desktop",
    key: "reveal-path",
    mode: "exclusive"
  }
];

/** 打开固定系统位置同样独占资源管理器通道，避免连续弹窗。 */
export const DESKTOP_KNOWN_LOCATION_RESOURCES: ToolResourceRequirement[] = [
  {
    kind: "desktop",
    key: "known-location",
    mode: "exclusive"
  }
];

/** 应用启动/列表：同任务串行，避免连续弹窗与扫描冲突。 */
export const DESKTOP_APP_RESOURCES: ToolResourceRequirement[] = [
  {
    kind: "desktop",
    key: "app-launch",
    mode: "exclusive"
  }
];

export function mapDesktopErrorToToolError(error: unknown): ToolError {
  const info = getDesktopBridgeErrorInfo(error);
  // 统一附带 desktopCode，供循环层回灌与熔断收口点名
  const withCode = (
    failureKind: string | undefined,
    extra?: Record<string, unknown>
  ): Record<string, unknown> => ({
    ...(info.details ?? {}),
    ...(extra ?? {}),
    desktopCode: info.code,
    ...(failureKind ? { failureKind } : {})
  });

  switch (info.code) {
    case "INVALID_REQUEST":
      return createToolError(
        "SCHEMA_INVALID",
        info.message,
        withCode("invalid_request"),
        false
      );
    case "TOO_LARGE":
      return createToolError(
        "SCHEMA_INVALID",
        info.message,
        withCode("too_large"),
        false
      );
    case "PATH_NOT_ALLOWED":
      return createToolError(
        "PERMISSION_DENIED",
        info.message,
        withCode("path_not_allowed"),
        false
      );
    case "PATH_NOT_FOUND":
      return createToolError(
        "EXECUTION_FAILED",
        info.message,
        withCode("path_not_found"),
        false
      );
    case "APP_NOT_FOUND":
      return createToolError(
        "EXECUTION_FAILED",
        info.message,
        withCode("app_not_found"),
        false
      );
    case "AMBIGUOUS_APP_NAME":
      return createToolError(
        "SCHEMA_INVALID",
        info.message,
        withCode("ambiguous_app_name"),
        false
      );
    case "UNSUPPORTED_PLATFORM":
      return createToolError(
        "EXECUTION_FAILED",
        info.message,
        withCode("unsupported_platform"),
        false
      );
    case "TIMEOUT":
      return createToolError("TIMEOUT", info.message, withCode("timeout"), true);
    case "BRIDGE_UNREACHABLE":
      return createToolError(
        "EXECUTION_FAILED",
        info.message,
        withCode("bridge_unreachable", { bridgeUnreachable: true }),
        true
      );
    case "CLIPBOARD_FAILED":
      return createToolError(
        "EXECUTION_FAILED",
        info.message,
        withCode("clipboard_failed"),
        true
      );
    case "REVEAL_FAILED":
      return createToolError(
        "EXECUTION_FAILED",
        info.message,
        withCode("reveal_failed"),
        true
      );
    default:
      return createToolError(
        "EXECUTION_FAILED",
        info.message,
        withCode("internal_error"),
        true
      );
  }
}

export function throwAsDesktopToolError(error: unknown): never {
  throw mapDesktopErrorToToolError(error);
}

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

export function mapDesktopErrorToToolError(error: unknown): ToolError {
  const info = getDesktopBridgeErrorInfo(error);
  switch (info.code) {
    case "INVALID_REQUEST":
      return createToolError("SCHEMA_INVALID", info.message, info.details, false);
    case "TOO_LARGE":
      return createToolError("SCHEMA_INVALID", info.message, info.details, false);
    case "PATH_NOT_ALLOWED":
      return createToolError(
        "PERMISSION_DENIED",
        info.message,
        { ...info.details, failureKind: "path_not_allowed" },
        false
      );
    case "PATH_NOT_FOUND":
      return createToolError(
        "EXECUTION_FAILED",
        info.message,
        { ...info.details, failureKind: "path_not_found" },
        false
      );
    case "UNSUPPORTED_PLATFORM":
      return createToolError("EXECUTION_FAILED", info.message, info.details, false);
    case "TIMEOUT":
      return createToolError("TIMEOUT", info.message, info.details, true);
    case "BRIDGE_UNREACHABLE":
      return createToolError(
        "EXECUTION_FAILED",
        info.message,
        { ...info.details, bridgeUnreachable: true },
        true
      );
    case "CLIPBOARD_FAILED":
    case "REVEAL_FAILED":
      return createToolError("EXECUTION_FAILED", info.message, info.details, true);
    default:
      return createToolError("EXECUTION_FAILED", info.message, info.details, true);
  }
}

export function throwAsDesktopToolError(error: unknown): never {
  throw mapDesktopErrorToToolError(error);
}

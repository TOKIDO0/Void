/**
 * 文件工具共享：资源声明与错误映射。
 */

import {
  createToolError,
  type ToolCallContext,
  type ToolError,
  type ToolResourceRequirement
} from "../tools";
import { getFileBridgeErrorInfo } from "./fileBridgeClient";

/** 静态资源：下载链路独占文件通道（阶段 D 串行主路径） */
export const FILE_STATIC_RESOURCES: ToolResourceRequirement[] = [
  {
    kind: "file",
    key: "download-pipeline",
    mode: "exclusive"
  }
];

export function resolveTaskIdFromInput(
  input: { taskId?: string },
  context: ToolCallContext
): string {
  const fromInput = typeof input.taskId === "string" ? input.taskId.trim() : "";
  return fromInput || context.taskId;
}

export function mapFileErrorToToolError(error: unknown): ToolError {
  const info = getFileBridgeErrorInfo(error);
  switch (info.code) {
    case "INVALID_REQUEST":
      return createToolError("SCHEMA_INVALID", info.message, info.details, false);
    case "PATH_NOT_ALLOWED":
    case "OVERWRITE_REFUSED":
      return createToolError("PERMISSION_DENIED", info.message, info.details, false);
    case "FILE_NOT_FOUND":
      return createToolError("EXECUTION_FAILED", info.message, info.details, false);
    case "TIMEOUT":
      return createToolError("TIMEOUT", info.message, info.details, true);
    case "BRIDGE_UNREACHABLE":
      return createToolError("EXECUTION_FAILED", info.message, info.details, true);
    case "DOWNLOAD_FAILED": {
      // 4xx 不可重试；网络抖动类才重试
      const status = info.details && typeof info.details.status === "number"
        ? info.details.status
        : undefined;
      const retriable = status === undefined || status >= 500;
      return createToolError("EXECUTION_FAILED", info.message, info.details, retriable);
    }
    default:
      return createToolError("EXECUTION_FAILED", info.message, info.details, true);
  }
}

export function throwAsFileToolError(error: unknown): never {
  throw mapFileErrorToToolError(error);
}

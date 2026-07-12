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
  // 预检/门禁失败：把错误码写进 details.failureKind，便于前端/循环层分类展示
  const withKind = (kind: string, details?: Record<string, unknown>) => ({
    ...(details ?? {}),
    failureKind: kind,
    fileCode: info.code
  });

  switch (info.code) {
    case "INVALID_REQUEST":
      return createToolError(
        "SCHEMA_INVALID",
        info.message,
        withKind("invalid_request", info.details),
        false
      );
    case "PATH_NOT_ALLOWED":
      return createToolError(
        "PERMISSION_DENIED",
        info.message,
        withKind("path_not_allowed", info.details),
        false
      );
    case "OVERWRITE_REFUSED":
      return createToolError(
        "PERMISSION_DENIED",
        info.message,
        withKind("overwrite_refused", info.details),
        false
      );
    case "FILE_NOT_FOUND":
      return createToolError(
        "EXECUTION_FAILED",
        info.message,
        withKind("file_not_found", info.details),
        false
      );
    case "FILE_TOO_LARGE":
    case "INVALID_UTF8":
    case "BINARY_FILE":
      return createToolError(
        "EXECUTION_FAILED",
        info.message,
        withKind(info.code.toLowerCase(), info.details),
        false
      );
    case "DESTINATION_EXISTS":
      return createToolError(
        "EXECUTION_FAILED",
        info.message,
        withKind("destination_exists", info.details),
        false
      );
    case "CROSS_DEVICE_MOVE":
      return createToolError(
        "EXECUTION_FAILED",
        info.message,
        withKind("cross_device_move", info.details),
        false
      );
    case "TIMEOUT":
      return createToolError("TIMEOUT", info.message, withKind("timeout", info.details), true);
    case "BRIDGE_UNREACHABLE":
      // 标记 bridgeUnreachable，供循环层识别并给用户「本机文件桥接服务未启动」的如实兜底话术。
      return createToolError(
        "EXECUTION_FAILED",
        info.message,
        { ...withKind("bridge_unreachable", info.details), bridgeUnreachable: true },
        true
      );
    case "DOWNLOAD_FAILED": {
      // 4xx 不可重试；网络抖动类才重试
      const status = info.details && typeof info.details.status === "number"
        ? info.details.status
        : undefined;
      const retriable = status === undefined || status >= 500;
      return createToolError(
        "EXECUTION_FAILED",
        info.message,
        withKind("download_failed", info.details),
        retriable
      );
    }
    case "MOVE_FAILED":
      return createToolError(
        "EXECUTION_FAILED",
        info.message,
        withKind("move_failed", info.details),
        false
      );
    case "VERIFY_FAILED":
      return createToolError(
        "EXECUTION_FAILED",
        info.message,
        withKind("verify_failed", info.details),
        false
      );
    default:
      return createToolError(
        "EXECUTION_FAILED",
        info.message,
        withKind("internal_error", info.details),
        true
      );
  }
}

export function throwAsFileToolError(error: unknown): never {
  throw mapFileErrorToToolError(error);
}

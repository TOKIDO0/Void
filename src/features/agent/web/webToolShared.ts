/**
 * 联网工具共享：把 webBridgeClient 的结构化联网错误映射成统一 ToolError。
 *
 * 为什么需要这一层（阶段 1 根因）：
 * webBridgeClient 抛的是带 webCode 的普通 Error，工具执行器只认 ToolError，
 * 于是所有 web.* 失败都被压成 EXECUTION_FAILED + retriable:true——
 * Key 无效、私网拦截这类“重试也没用”的失败会被当成可重试，且错误码分类全部丢失。
 * 这里与 fileToolShared / browserToolShared 保持同一契约：失败原因进 details，
 * 可重试性由真实原因决定，桥接不可达显式标注。
 */

import { createToolError, type ToolError } from "../tools";
import { getWebBridgeErrorInfo } from "./webBridgeClient";
import {
  BRIDGE_AUTH_FAILURE_KIND,
  BRIDGE_AUTH_FAILURE_MESSAGE,
  isBridgeAuthFailureCode
} from "../bridge/bridgeAuthErrors";

export function mapWebErrorToToolError(error: unknown): ToolError {
  const info = getWebBridgeErrorInfo(error);
  // 统一带上 webCode + failureKind，供回灌层点名与前端分类。
  const withKind = (kind: string, details?: Record<string, unknown>) => ({
    ...(details ?? {}),
    failureKind: kind,
    webCode: info.code
  });

  if (isBridgeAuthFailureCode(info.code)) {
    return createToolError(
      "EXECUTION_FAILED",
      BRIDGE_AUTH_FAILURE_MESSAGE,
      withKind(BRIDGE_AUTH_FAILURE_KIND, info.details),
      false
    );
  }

  switch (info.code) {
    case "BRIDGE_UNREACHABLE":
      // 标记 bridgeUnreachable，供循环层识别并给用户「本机联网服务未启动」的如实兜底话术。
      return createToolError(
        "EXECUTION_FAILED",
        "本机联网服务未连接，web.search/web.fetch 无法执行；请启动 VOID 桌面端或本机服务后重试。",
        { ...withKind("bridge_unreachable", info.details), bridgeUnreachable: true },
        true
      );
    case "KEY_INVALID":
      // 鉴权失败重试无意义：必须 false，避免模型反复烧预算与额度。
      return createToolError("EXECUTION_FAILED", info.message, withKind("key_invalid", info.details), false);
    case "RATE_LIMITED":
      return createToolError("EXECUTION_FAILED", info.message, withKind("rate_limited", info.details), true);
    case "TIMEOUT":
      return createToolError("TIMEOUT", info.message, withKind("timeout", info.details), true);
    case "INVALID_REQUEST":
      // 参数/URL 被服务端拒绝（含私网拦截）：属于调用方式错误，不是瞬时故障。
      return createToolError("SCHEMA_INVALID", info.message, withKind("invalid_request", info.details), false);
    case "TOO_LARGE":
      return createToolError("EXECUTION_FAILED", info.message, withKind("too_large", info.details), false);
    case "INVALID_RESPONSE":
      return createToolError("EXECUTION_FAILED", info.message, withKind("invalid_response", info.details), true);
    case "INTERNAL_ERROR":
      return createToolError("EXECUTION_FAILED", info.message, withKind("internal_error", info.details), true);
    default:
      // 未知原因照实标 unknown，不虚构归因。
      return createToolError("EXECUTION_FAILED", info.message, withKind("unknown", info.details), true);
  }
}

export function throwAsWebToolError(error: unknown): never {
  throw mapWebErrorToToolError(error);
}

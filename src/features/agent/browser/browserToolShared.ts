/**
 * 浏览器工具共享：资源声明、错误映射、taskId 解析。
 */

import {
  createToolError,
  type ToolCallContext,
  type ToolError,
  type ToolResourceRequirement
} from "../tools";
import { getBrowserBridgeErrorInfo } from "./browserBridgeClient";

/**
 * 每个任务独占一个浏览器上下文资源键。
 * key 在 execute 时按 taskId 动态拼装（见 resolveBrowserResources）。
 */
export function resolveBrowserResources(taskId: string): ToolResourceRequirement[] {
  return [
    {
      kind: "browser",
      key: `task:${taskId}`,
      mode: "exclusive"
    }
  ];
}

/**
 * 工具定义里的静态资源声明（注册表元数据用）。
 * 真实加锁 key 由执行器按 requiredResources 原样使用；
 * 因此各工具 execute 入口会先 ensure session，并在定义里用稳定 kind。
 *
 * 注意：阶段 B 的 requiredResources 是静态的。为让同任务多步共享同一把锁，
 * 浏览器工具统一声明 key=`browser-context` + exclusive。
 * 同任务串行执行时，步骤结束后会 releaseStepResources，下一步再 acquire —— 不冲突。
 * 不同任务并行时会 RESOURCE_BUSY（符合 27 号隔离预期；阶段 C 仍串行主路径）。
 */
export const BROWSER_STATIC_RESOURCES: ToolResourceRequirement[] = [
  {
    kind: "browser",
    key: "browser-context",
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

export function mapBrowserErrorToToolError(error: unknown): ToolError {
  const info = getBrowserBridgeErrorInfo(error);

  switch (info.code) {
    case "INVALID_REQUEST":
      return createToolError("SCHEMA_INVALID", info.message, info.details, false);
    case "BRIDGE_UNREACHABLE":
    case "BROWSER_UNAVAILABLE":
      return createToolError("EXECUTION_FAILED", info.message, info.details, true);
    case "TIMEOUT":
      return createToolError("TIMEOUT", info.message, info.details, true);
    case "SESSION_NOT_FOUND":
    case "PAGE_NOT_FOUND":
    case "NAVIGATION_FAILED":
    case "PARSE_FAILED":
      return createToolError("EXECUTION_FAILED", info.message, info.details, false);
    default:
      return createToolError("EXECUTION_FAILED", info.message, info.details, true);
  }
}

export function throwAsToolError(error: unknown): never {
  throw mapBrowserErrorToToolError(error);
}

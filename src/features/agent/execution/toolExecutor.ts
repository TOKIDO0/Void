// 单工具调用执行器：注册检查 → Schema → 资源锁 → 超时/取消 → 有限重试。
// 设计依据：`.md/27` §5.3。

import {
  createToolError,
  formatSchemaIssues,
  getTool,
  isAbortError,
  toExecutionFailedError,
  validateAgainstSchema,
  type ToolCallContext,
  type ToolDefinition,
  type ToolError,
  type ToolResult
} from "../tools";
import { coerceToolArgs } from "../tools/coerceToolArgs";
import {
  acquireResources,
  releaseStepResources,
  type ResourceRequest
} from "../resources";
import { appendExecutionLog } from "../observability";
import { sanitizeForAudit } from "../observability/auditSanitize";
import { buildToolSuccessSummary } from "./toolSuccessSummary";
import {
  getCurrentPermissionGrants,
  listMissingToolPermissionGrants,
  type PermissionGrants
} from "../permissions";

export type ExecuteToolCallParams = {
  taskId: string;
  stepId: string;
  toolName: string;
  input: unknown;
  signal: AbortSignal;
  /** 本步已消耗的 attempt（从 1 起） */
  attempt: number;
  permissionGrants?: PermissionGrants;
};

/**
 * 执行一次已规划的工具调用。
 * - 未注册 / 禁用 / Schema 失败：直接结构化错误，不进 execute
 * - 资源冲突：RESOURCE_BUSY
 * - 超时：TIMEOUT
 * - 取消：CANCELLED
 */
export async function executeToolCall(
  params: ExecuteToolCallParams
): Promise<ToolResult> {
  const tool = getTool(params.toolName);
  if (!tool) {
    const error = createToolError(
      "TOOL_NOT_FOUND",
      `未注册工具：${params.toolName}`,
      { toolName: params.toolName },
      false
    );
    logFailure(params, error);
    return { ok: false, error };
  }

  if (tool.enabled === false) {
    const error = createToolError(
      "TOOL_DISABLED",
      `工具已禁用：${params.toolName}`,
      { toolName: params.toolName },
      false
    );
    logFailure(params, error);
    return { ok: false, error };
  }

  const permissionGrants = params.permissionGrants ?? getCurrentPermissionGrants();
  const missingPermissions = listMissingToolPermissionGrants(tool, permissionGrants);
  if (missingPermissions.length > 0) {
    const error = createToolError(
      "PERMISSION_DENIED",
      `工具未获授权：${params.toolName}`,
      { missingPermissions },
      false
    );
    logFailure(params, error, tool);
    return { ok: false, error };
  }

  const coercedInput = coerceToolArgs(params.toolName, params.input);
  const validation = validateAgainstSchema(tool.inputSchema, coercedInput);
  if (!validation.valid) {
    const error = createToolError(
      "SCHEMA_INVALID",
      `参数校验失败：${formatSchemaIssues(validation.issues)}`,
      { issues: validation.issues },
      false
    );
    logFailure(params, error, tool);
    return { ok: false, error };
  }

  if (params.signal.aborted) {
    const error = createToolError("CANCELLED", "执行前已取消", undefined, false);
    logFailure(params, error, tool);
    return { ok: false, error };
  }

  const resourceRequests: ResourceRequest[] = tool.requiredResources.map((resource) => ({
    kind: resource.kind,
    key: resource.key,
    mode: resource.mode,
    taskId: params.taskId,
    stepId: params.stepId
  }));

  const acquireResult = acquireResources(resourceRequests);
  if (!acquireResult.ok) {
    const error = createToolError(
      "RESOURCE_BUSY",
      `资源被占用：${acquireResult.conflict.kind}:${acquireResult.conflict.key}`,
      { conflict: acquireResult.conflict },
      true
    );
    logFailure(params, error, tool);
    return { ok: false, error };
  }

  appendExecutionLog({
    taskId: params.taskId,
    stepId: params.stepId,
    toolName: tool.name,
    event: "tool.execute.start",
    message: `开始执行 ${tool.name}`,
    data: {
      attempt: params.attempt,
      input: tool.auditPolicy.logInputSummary === false
        ? undefined
        : sanitizeForAudit(coercedInput, tool.auditPolicy.redactInputKeys ?? [])
    },
    redactKeys: tool.auditPolicy.redactInputKeys
  });

  try {
    const output = await runWithTimeoutAndCancel(tool, { ...params, input: coercedInput });
    const outputValidation = validateAgainstSchema(tool.outputSchema, output);
    if (!outputValidation.valid) {
      throw createToolError(
        "OUTPUT_SCHEMA_INVALID",
        `工具输出校验失败：${formatSchemaIssues(outputValidation.issues)}`,
        { issues: outputValidation.issues },
        false
      );
    }
    const summary = buildToolSuccessSummary(tool.name, output);

    appendExecutionLog({
      taskId: params.taskId,
      stepId: params.stepId,
      toolName: tool.name,
      event: "tool.execute.success",
      message: summary,
      data: {
        attempt: params.attempt,
        output: tool.auditPolicy.logOutputSummary === false
          ? undefined
          : sanitizeForAudit(output, tool.auditPolicy.redactOutputKeys ?? [])
      },
      redactKeys: tool.auditPolicy.redactOutputKeys
    });

    return {
      ok: true,
      data: output,
      summary
    };
  } catch (error) {
    const toolError = normalizeExecuteError(error);
    logFailure(params, toolError, tool);
    return { ok: false, error: toolError };
  } finally {
    releaseStepResources(params.taskId, params.stepId);
  }
}

async function runWithTimeoutAndCancel(
  tool: ToolDefinition,
  params: ExecuteToolCallParams
) {
  const timeoutMs = Math.max(1, tool.timeoutMs);
  const controller = new AbortController();
  const startedAt = Date.now();

  let rejectForAbort: ((reason: ToolError) => void) | undefined;
  const abortPromise = new Promise<never>((_resolve, reject) => {
    rejectForAbort = reject;
  });
  const onParentAbort = () => {
    controller.abort();
    rejectForAbort?.(createToolError("CANCELLED", "工具执行已取消", undefined, false));
  };

  if (params.signal.aborted) {
    onParentAbort();
  } else {
    params.signal.addEventListener("abort", onParentAbort, { once: true });
  }

  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<never>((_resolve, reject) => {
    timeoutHandle = setTimeout(() => {
      controller.abort();
      reject(createTimeoutError(timeoutMs));
    }, timeoutMs);
  });

  const context: ToolCallContext = {
    taskId: params.taskId,
    stepId: params.stepId,
    signal: controller.signal,
    startedAt
  };

  try {
    const executionPromise = Promise.resolve(tool.execute(params.input, context));
    return await Promise.race([executionPromise, timeoutPromise, abortPromise]);
  } catch (error) {
    if (controller.signal.aborted && params.signal.aborted) {
      throw createToolError("CANCELLED", "工具执行已取消", undefined, false);
    }
    if (isToolError(error)) {
      throw error;
    }
    if (isAbortError(error)) {
      if (params.signal.aborted) {
        throw createToolError("CANCELLED", "工具执行已取消", undefined, false);
      }
      throw createTimeoutError(timeoutMs);
    }
    throw error;
  } finally {
    if (timeoutHandle) {
      clearTimeout(timeoutHandle);
    }
    params.signal.removeEventListener("abort", onParentAbort);
  }
}

function createTimeoutError(timeoutMs: number): ToolError {
  return createToolError(
    "TIMEOUT",
    `工具执行超时（${timeoutMs}ms）`,
    { timeoutMs },
    true
  );
}

function normalizeExecuteError(error: unknown): ToolError {
  if (isToolError(error)) {
    return error;
  }
  return toExecutionFailedError(error);
}

function isToolError(error: unknown): error is ToolError {
  return (
    typeof error === "object"
    && error !== null
    && "code" in error
    && "message" in error
    && "retriable" in error
  );
}

function logFailure(
  params: ExecuteToolCallParams,
  error: ToolError,
  tool?: ToolDefinition
) {
  appendExecutionLog({
    level: "error",
    taskId: params.taskId,
    stepId: params.stepId,
    toolName: params.toolName,
    event: "tool.execute.failure",
    message: error.message,
    data: {
      attempt: params.attempt,
      code: error.code,
      retriable: error.retriable,
      details: error.details
    },
    redactKeys: tool?.auditPolicy.redactInputKeys
  });
}

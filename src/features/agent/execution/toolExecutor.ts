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
import {
  acquireResources,
  releaseStepResources,
  type ResourceRequest
} from "../resources";
import { appendExecutionLog } from "../observability";
import { sanitizeForAudit } from "../observability/auditSanitize";

export type ExecuteToolCallParams = {
  taskId: string;
  stepId: string;
  toolName: string;
  input: unknown;
  signal: AbortSignal;
  /** 本步已消耗的 attempt（从 1 起） */
  attempt: number;
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

  const validation = validateAgainstSchema(tool.inputSchema, params.input);
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
        : sanitizeForAudit(params.input, tool.auditPolicy.redactInputKeys ?? [])
    },
    redactKeys: tool.auditPolicy.redactInputKeys
  });

  try {
    const output = await runWithTimeoutAndCancel(tool, params);
    const summary = buildSuccessSummary(tool.name, output);

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

  const onParentAbort = () => {
    controller.abort();
  };

  if (params.signal.aborted) {
    controller.abort();
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
    return await Promise.race([executionPromise, timeoutPromise]);
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

function buildSuccessSummary(toolName: string, output: unknown) {
  if (!output || typeof output !== "object") {
    return `${toolName} 执行成功`;
  }

  const record = output as Record<string, unknown>;

  if ("echoed" in record) {
    const echoed = String(record.echoed);
    return `${toolName} 完成：${echoed.slice(0, 80)}`;
  }

  if (toolName === "browser.search" && Array.isArray(record.results)) {
    const query = typeof record.query === "string" ? record.query : "";
    return `${toolName} 完成：${query}（${record.results.length} 条）`;
  }

  if (toolName === "browser.readResult" && Array.isArray(record.results)) {
    return `${toolName} 完成：${record.results.length} 条结果`;
  }

  if (toolName === "browser.open" && typeof record.finalUrl === "string") {
    const title = typeof record.title === "string" ? record.title : "";
    return `${toolName} 完成：${title || record.finalUrl}`.slice(0, 120);
  }

  if (toolName === "browser.screenshot" && typeof record.path === "string") {
    return `${toolName} 完成：${record.path}`;
  }

  if (toolName === "browser.selectTarget" && typeof record.title === "string") {
    return `${toolName} 完成：已确认「${String(record.title).slice(0, 60)}」`;
  }

  if (toolName === "file.downloadToTemp" && typeof record.tempPath === "string") {
    // 统一可读：文件名 + mediaKind + bytes（通用文件，不写死某类安装包）
    const fileName = typeof record.fileName === "string" ? record.fileName : "";
    const mediaKind = typeof record.mediaKind === "string" ? record.mediaKind : "unknown";
    const bytes = record.bytes ?? "?";
    return `${toolName} 完成：${fileName || record.tempPath}（${mediaKind}, ${String(bytes)} bytes）→ ${record.tempPath}`;
  }

  if (toolName === "file.placeDownload" && typeof record.finalPath === "string") {
    const fileName = typeof record.fileName === "string" ? record.fileName : "";
    const mediaKind = typeof record.mediaKind === "string" ? record.mediaKind : "unknown";
    const bytes = record.bytes ?? "?";
    return `${toolName} 完成：${fileName || record.finalPath}（${mediaKind}, ${String(bytes)} bytes）→ ${record.finalPath}`;
  }

  if (toolName === "file.verify") {
    if (record.exists) {
      const fileName = typeof record.fileName === "string" ? record.fileName : "";
      const mediaKind = typeof record.mediaKind === "string" ? record.mediaKind : "unknown";
      const bytes = record.bytes ?? "?";
      return `${toolName} 完成：${fileName || "已存在"}（${mediaKind}, ${String(bytes)} bytes）`;
    }
    return `${toolName} 完成：文件不存在`;
  }

  if (toolName === "clipboard.read") {
    if (record.empty) {
      return `${toolName} 完成：剪贴板为空`;
    }
    const length = record.length ?? "?";
    const truncated = record.truncated ? "，已截断" : "";
    return `${toolName} 完成：${String(length)} 字符${truncated}`;
  }

  if (toolName === "clipboard.write") {
    return `${toolName} 完成：已写入 ${String(record.length ?? "?")} 字符`;
  }

  return `${toolName} 执行成功`;
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

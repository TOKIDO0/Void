// 对话驱动的工具循环：模型 tool_calls → 权限门 → 执行 → 结果回灌。
// 文本 / 语音共用；不提供菜单试跑入口。
// 护栏：模型轮次上限 + 工具调用预算 + 同工具重复熔断 + 结果截断 + 终态收口。

import type { ModelConfig } from "../../settings/modelConfig";
import type {
  ProviderMessage,
  ProviderResponse,
  ProviderToolCall,
  ProviderToolDefinition
} from "../../../lib/model-providers/providerContract";
import { getModelProvider } from "../../../lib/model-providers/providerRegistry";
import { executeToolCall } from "../execution/toolExecutor";
import {
  createConfirmationRequest,
  DEFAULT_RISK_POLICY,
  inspectToolInputSafety,
  requiresUserConfirmation,
  resolveHighestRiskLevel,
  type ConfirmationDecision,
  type ConfirmationRequest
} from "../permissions";
import {
  getCurrentPermissionGrants,
  hasToolPermissionGrants,
  type PermissionGrants
} from "../permissions";
import { appendExecutionLog, setTaskProgress } from "../observability";
import { sanitizeForAudit } from "../observability/auditSanitize";
import { bootstrapAgentRuntime } from "../runtimeBootstrap";
import { releaseBrowserSessionForTask } from "../browser/browserSessionLifecycle";
import { releaseTaskResources } from "../resources";
import { getTool } from "../tools";
import {
  fromModelToolName,
  listModelToolDefinitions
} from "../tools/modelToolSchema";
import type { RiskLevel } from "../tools";
import {
  applyReplySpeechGuard,
  inspectToolResultForOpenEvidence
} from "./replySpeechGuard";
import { buildToolConfirmationDescription } from "./toolConfirmationCopy";
import {
  formatSameToolStreakCloseMessage,
  formatToolBudgetExhaustedMessage,
  formatToolConfirmWaitMessage,
  formatToolProgressMessage
} from "./toolProgressCopy";
import { buildToolResultRelay } from "./toolResultRelay";
import {
  formatBehaviorToolRefusal,
  isBehaviorToolGateBlocked,
  type BehaviorDecision
} from "../../emotion/behaviorPolicy";

export type AgentToolLoopOptions = {
  /** 已含 system / 历史 / 本轮 user 的完整消息 */
  messages: ProviderMessage[];
  modelConfig: ModelConfig;
  /** 覆盖默认工具列表；默认从注册表生成 */
  tools?: ProviderToolDefinition[];
  /** 上层回合路由允许暴露的内部工具名；缺省表示不过滤。 */
  allowedToolNames?: string[];
  /** P3 关系情绪任务门禁；只收紧工具，不放宽路由、权限或风险等级。 */
  taskGate?: BehaviorDecision["taskGate"];
  requestConfirmation?: (
    request: ConfirmationRequest
  ) => Promise<ConfirmationDecision>;
  /** 轻量进度文案（给回复层 / 状态机，不是工具控制台） */
  onProgress?: (message: string) => void;
  signal?: AbortSignal;
  /** 模型请求轮次上限（含最终回复轮）；默认 8 */
  maxRounds?: number;
  /** 单轮对话最多成功执行的工具次数；默认 8 */
  maxToolInvocations?: number;
};

export type AgentToolLoopResult = {
  content: string;
  /** 本轮是否实际调用过工具 */
  usedTools: boolean;
  rounds: number;
  taskId: string;
  /**
   * 循环层终态：预算耗尽/熔断友好收口记 failed，
   * 正常回复记 succeeded（取消仍走 throw）。
   */
  outcome?: "succeeded" | "failed";
};

/** 模型请求次数：过大会刷爆 API；过小复杂任务完不成 */
const DEFAULT_MAX_ROUNDS = 8;
/** 工具实际执行次数预算（与模型轮次独立） */
const DEFAULT_MAX_TOOL_INVOCATIONS = 8;
/** 同一工具连续失败/空结果多少次后熔断 */
const MAX_SAME_TOOL_STREAK = 3;
/** 回灌模型的单条 tool 结果最大字符；主压缩在 toolResultRelay，这里只做最后保险 */
const MAX_TOOL_RESULT_CHARS = 9000;

/**
 * 桥接不可达（sidecar 未启动）时回灌给模型的硬约束：
 * 强制如实转述启动提示，禁止含糊说「不能操控浏览器」。
 */
const BRIDGE_UNREACHABLE_RELAY_HINT = [
  "本机浏览器/文件桥接服务（sidecar）未启动，工具无法执行——这不是模型没有能力，而是本地服务没跑起来。",
  "请立刻用简洁中文如实告诉用户：本机浏览器服务未启动，需要先启动本地服务（例如运行 npm run dev:bridge 或启动桌面壳）后再重试。",
  "禁止只说「我不能操控浏览器」这类含糊话；不要重复调用同一工具。"
].join("");

/**
 * 调用后通常可以结束并汇报的终态工具（仍允许模型再补一句，但优先收口）。
 * 本地整理链：place/verify/move/reveal 成功后也应收口，避免继续空转。
 */
const TERMINAL_SUCCESS_TOOLS = new Set([
  "browser.revealInSystemBrowser",
  "file.placeDownload",
  "file.verify",
  "file.move",
  "file.writeText",
  "desktop.revealPath",
  "desktop.openKnownLocation"
]);

/**
 * 运行一轮「可调工具」的对话循环，返回最终对用户的自然语言回复。
 */
export async function runAgentToolLoop(
  options: AgentToolLoopOptions
): Promise<AgentToolLoopResult> {
  const taskId = `turn_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
  try {
    const result = await runAgentToolLoopInternal(options, taskId);
    const outcome = result.outcome ?? "succeeded";
    setTaskProgress({
      taskId,
      status: outcome === "failed" ? "failed" : "succeeded",
      goal: "对话工具循环",
      completedSteps: result.rounds,
      totalSteps: result.rounds,
      message:
        outcome === "failed"
          ? result.content.slice(0, 160)
          : result.usedTools
            ? "任务完成"
            : "纯对话回复",
      updatedAt: Date.now()
    });
    appendExecutionLog({
      taskId,
      event: "task.finished",
      message: outcome === "failed" ? "对话工具循环友好收口（未完成）" : "对话工具循环已完成",
      data: { rounds: result.rounds, usedTools: result.usedTools, outcome }
    });
    return result;
  } catch (error) {
    const cancelled = options.signal?.aborted || isAbortError(error);
    setTaskProgress({
      taskId,
      status: cancelled ? "cancelled" : "failed",
      goal: "对话工具循环",
      completedSteps: 0,
      totalSteps: 0,
      message: cancelled ? "任务已取消" : "任务执行失败",
      updatedAt: Date.now()
    });
    appendExecutionLog({
      level: cancelled ? "warn" : "error",
      taskId,
      event: cancelled ? "task.cancelled" : "task.failed",
      message: cancelled ? "对话工具循环已取消" : "对话工具循环执行失败"
    });
    throw error;
  } finally {
    releaseTaskResources(taskId);
    await releaseBrowserSessionForTask(taskId);
  }
}

async function runAgentToolLoopInternal(
  options: AgentToolLoopOptions,
  taskId: string
): Promise<AgentToolLoopResult> {
  bootstrapAgentRuntime();

  const provider = getModelProvider(options.modelConfig.provider);
  const permissionGrants = getCurrentPermissionGrants();
  const blockedByAffect = options.taskGate
    ? isBehaviorToolGateBlocked(options.taskGate)
    : false;

  if (options.taskGate) {
    appendExecutionLog({
      taskId,
      level: blockedByAffect ? "warn" : "info",
      event: "affect.task_gate.rechecked",
      message: blockedByAffect
        ? "工具循环复核已拦截非安全工具"
        : "工具循环复核允许继续",
      data: {
        layer: "tool_loop",
        mood: options.taskGate.mood,
        grievance: options.taskGate.grievance,
        cooperation: options.taskGate.cooperation,
        taskContext: options.taskGate.taskContext,
        blockedTools: blockedByAffect,
        reason: options.taskGate.reason
      }
    });
  }

  if (!provider.supportsTools) {
    const response = await provider.sendMessage(
      { messages: options.messages, signal: options.signal },
      options.modelConfig
    );
    return {
      content: blockedByAffect && options.taskGate
        ? formatBehaviorToolRefusal(options.taskGate)
        : response.content,
      usedTools: false,
      rounds: 1,
      taskId
    };
  }

  const allowedToolNames = options.allowedToolNames
    ? new Set(options.allowedToolNames)
    : null;
  const tools = options.tools
    ? options.tools.filter((definition) => {
        const tool = getTool(fromModelToolName(definition.function.name));
        return Boolean(
          !blockedByAffect
          && tool
          && (!allowedToolNames || allowedToolNames.has(tool.name))
          && hasToolPermissionGrants(tool, permissionGrants)
        );
      })
    : blockedByAffect
      ? []
      : listModelToolDefinitions(permissionGrants).filter((definition) =>
          !allowedToolNames
          || allowedToolNames.has(fromModelToolName(definition.function.name))
        );
  if (tools.length === 0) {
    const response = await provider.sendMessage(
      { messages: options.messages, signal: options.signal },
      options.modelConfig
    );
    return {
      content: blockedByAffect && options.taskGate
        ? formatBehaviorToolRefusal(options.taskGate)
        : response.content,
      usedTools: false,
      rounds: 1,
      taskId
    };
  }

  const maxRounds = options.maxRounds ?? DEFAULT_MAX_ROUNDS;
  const maxToolInvocations = options.maxToolInvocations ?? DEFAULT_MAX_TOOL_INVOCATIONS;
  const messages: ProviderMessage[] = options.messages.map((item) => ({ ...item }));
  let usedTools = false;
  let rounds = 0;
  let toolInvocationCount = 0;
  let sameToolStreakName = "";
  let sameToolStreakCount = 0;
  // 同工具最近一次失败的错误码，供熔断收口文案点名
  let lastSameToolErrorCode = "";
  // 熔断已触发时的用户可读收口（工具名 + 错误码）
  let sameToolStreakClose: {
    toolName: string;
    errorCode: string;
    streakCount: number;
  } | null = null;
  let lastTerminalSuccess: { toolName: string; summary: string } | null = null;
  // 话术护栏证据：本轮是否真实 open/reveal/下载/点击成功，以及最后一次打开的 URL。
  let didRevealInSystemBrowser = false;
  let didOpenAutomationWindow = false;
  let didOpenDesktopLocation = false;
  let didCompleteDownload = false;
  let didPageClick = false;
  let didLongPress = false;
  let lastOpenedUrl: string | undefined;
  // 桥接不可达兜底：本轮是否已回灌过「sidecar 未启动」的如实话术约束（只灌一次，避免刷屏）。
  let bridgeUnreachableRelayed = false;

  options.onProgress?.("正在理解你的需求…");
  setTaskProgress({
    taskId,
    status: "running",
    goal: "对话工具循环",
    completedSteps: 0,
    totalSteps: 0,
    message: "正在理解你的需求…",
    updatedAt: Date.now()
  });

  while (rounds < maxRounds) {
    if (options.signal?.aborted) {
      throw createAbortedError();
    }

    // 已达工具预算 / 终态成功 / 同工具熔断：强制最后一轮纯文本，禁止继续 tool_calls
    const forceFinalText =
      toolInvocationCount >= maxToolInvocations
      || Boolean(lastTerminalSuccess)
      || Boolean(sameToolStreakClose);

    rounds += 1;
    let response: ProviderResponse;
    try {
      response = await provider.sendMessage(
        {
          messages,
          tools: forceFinalText ? undefined : tools,
          toolChoice: forceFinalText ? "none" : "auto",
          signal: options.signal
        },
        options.modelConfig
      );
    } catch (error) {
      throw provider.mapError(error);
    }

    const toolCalls = forceFinalText ? [] : (response.toolCalls ?? []);
    if (toolCalls.length === 0) {
      let content = (response.content ?? "").trim();
      // 部分 OpenAI-compatible 模型会在 toolChoice=none 时把工具协议写进正文。
      // 终态已成功后禁止把内部协议展示给用户，也禁止把它当作新的工具调用执行。
      if (forceFinalText && lastTerminalSuccess && containsToolProtocolMarkup(content)) {
        content = lastTerminalSuccess.summary;
      }
      if (!content && lastTerminalSuccess) {
        content = lastTerminalSuccess.summary;
      }
      // 同工具熔断收口：模型没点名工具/错误码时，改用可读文案，禁止泛泛「遇到问题」
      if (sameToolStreakClose) {
        content = ensureStreakCloseContent(content, sameToolStreakClose);
      }
      if (!content) {
        throw new Error("模型没有返回有效内容。");
      }
      content = applyReplySpeechGuard(content, {
        usedTools,
        didRevealInSystemBrowser,
        didOpenAutomationWindow,
        didOpenDesktopLocation,
        didCompleteDownload,
        didPageClick,
        didLongPress,
        lastOpenedUrl
      });
      options.onProgress?.(usedTools ? "已完成操作，正在整理回复…" : "");
      setTaskProgress({
        taskId,
        status: "succeeded",
        goal: "对话工具循环",
        completedSteps: rounds,
        totalSteps: rounds,
        message: sameToolStreakClose
          ? formatSameToolStreakCloseMessage(
              sameToolStreakClose.toolName,
              sameToolStreakClose.errorCode,
              sameToolStreakClose.streakCount
            )
          : usedTools
            ? "任务完成"
            : "纯对话回复",
        updatedAt: Date.now()
      });
      return { content, usedTools, rounds, taskId };
    }

    usedTools = true;
    messages.push({
      role: "assistant",
      content: response.content?.trim() ? response.content : null,
      tool_calls: toolCalls
    });

    // 本轮是否有工具因桥接不可达失败（sidecar 未启动），用于回灌一次如实兜底话术
    let sawBridgeUnreachableThisRound = false;

    for (const toolCall of toolCalls) {
      if (options.signal?.aborted) {
        throw createAbortedError();
      }

      if (toolInvocationCount >= maxToolInvocations) {
        messages.push({
          role: "tool",
          tool_call_id: toolCall.id,
          name: toolCall.function?.name || "unknown",
          content: serializeToolFailure(
            `已达到本轮工具调用上限（${maxToolInvocations}），请基于已有结果直接用中文回复用户，不要再调工具。`,
            "TOOL_BUDGET_EXCEEDED"
          )
        });
        continue;
      }

      const modelToolName = toolCall.function?.name?.trim() || "";
      const toolName = fromModelToolName(modelToolName);
      const stepId = toolCall.id || `step_${rounds}_${toolName}`;

      // 同工具连续空转熔断：记录工具名 + 最近错误码，供用户收口文案点名
      if (toolName === sameToolStreakName && sameToolStreakCount >= MAX_SAME_TOOL_STREAK) {
        const errorCode = lastSameToolErrorCode || "TOOL_STREAK_BREAKER";
        if (!sameToolStreakClose) {
          sameToolStreakClose = {
            toolName,
            errorCode,
            streakCount: sameToolStreakCount
          };
        }
        messages.push({
          role: "tool",
          tool_call_id: toolCall.id,
          name: modelToolName || toolName,
          content: serializeToolFailure(
            `工具 ${toolName} 已连续调用 ${sameToolStreakCount} 次仍无有效推进（最近错误码：${errorCode}）。请换策略，或直接用中文向用户说明卡在「${toolName} / ${errorCode}」，不要重复同一调用。`,
            "TOOL_STREAK_BREAKER"
          )
        });
        continue;
      }

      const progressMessage = formatToolProgressMessage(toolName);
      options.onProgress?.(progressMessage);
      setTaskProgress({
        taskId,
        status: "running",
        goal: "对话工具循环",
        currentStepId: stepId,
        currentStepTitle: toolName,
        currentToolName: toolName,
        completedSteps: toolInvocationCount,
        totalSteps: maxToolInvocations,
        message: progressMessage,
        updatedAt: Date.now()
      });

      const toolResultPayload = await runSingleToolCall({
        taskId,
        stepId,
        toolName,
        toolCall,
        requestConfirmation: options.requestConfirmation,
        signal: options.signal,
        onProgress: options.onProgress,
        permissionGrants,
        taskGate: options.taskGate
      });

      toolInvocationCount += 1;

      const parsedForGuard = safeParseJson(toolResultPayload);
      const ok = Boolean(parsedForGuard && parsedForGuard.ok === true);
      if (toolName === sameToolStreakName) {
        sameToolStreakCount += 1;
      } else {
        sameToolStreakName = toolName;
        sameToolStreakCount = 1;
      }
      // 失败时记下错误码，成功有数据时重置 streak
      if (!ok) {
        lastSameToolErrorCode = extractToolErrorCode(parsedForGuard);
      }
      // 成功且有数据时重置 streak，避免「搜一次成功又搜」被误杀——仅失败/空结果累计
      if (ok && hasUsefulToolData(parsedForGuard)) {
        sameToolStreakCount = 0;
        sameToolStreakName = "";
        lastSameToolErrorCode = "";
      }

      // 桥接不可达：标记本轮命中，待该轮工具处理完统一回灌一次如实兜底话术
      if (isBridgeUnreachableToolResult(parsedForGuard)) {
        sawBridgeUnreachableThisRound = true;
      }

      const openEvidence = inspectToolResultForOpenEvidence(toolName, parsedForGuard);
      if (openEvidence.didReveal) {
        didRevealInSystemBrowser = true;
      }
      if (openEvidence.didOpenAutomation) {
        didOpenAutomationWindow = true;
      }
      if (openEvidence.didOpenDesktop) {
        didOpenDesktopLocation = true;
      }
      if (openEvidence.didCompleteDownload) {
        didCompleteDownload = true;
      }
      if (openEvidence.didPageClick) {
        didPageClick = true;
      }
      if (openEvidence.didLongPress) {
        didLongPress = true;
      }
      if (openEvidence.url) {
        lastOpenedUrl = openEvidence.url;
      }

      if (ok && TERMINAL_SUCCESS_TOOLS.has(toolName)) {
        const summary =
          typeof parsedForGuard?.summary === "string"
            ? parsedForGuard.summary
            : typeof parsedForGuard?.data === "object"
              && parsedForGuard.data
              && typeof (parsedForGuard.data as { message?: unknown }).message === "string"
              ? String((parsedForGuard.data as { message: string }).message)
              : `${toolName} 已完成`;
        lastTerminalSuccess = { toolName, summary };
      }

      messages.push({
        role: "tool",
        tool_call_id: toolCall.id,
        name: modelToolName || toolName,
        content: truncateToolResult(toolResultPayload)
      });
    }

    // 桥接不可达：本轮命中且尚未回灌过，则塞一条系统提示，逼模型如实转述而非含糊「不能操控浏览器」
    if (sawBridgeUnreachableThisRound && !bridgeUnreachableRelayed) {
      bridgeUnreachableRelayed = true;
      messages.push({
        role: "system",
        content: BRIDGE_UNREACHABLE_RELAY_HINT
      });
    }

    // 同工具熔断后塞一条系统提示，下一轮强制纯文本并点名卡点
    if (sameToolStreakClose) {
      messages.push({
        role: "system",
        content: [
          `工具「${sameToolStreakClose.toolName}」已连续失败/空转 ${sameToolStreakClose.streakCount} 次，错误码 ${sameToolStreakClose.errorCode}。`,
          "请立刻用简洁中文向用户说明卡在哪个工具、错误码是什么，并建议换策略或检查本机服务；不要再调用任何工具，不要只说「遇到问题」。"
        ].join("")
      });
    }

    // 终态成功后塞一条系统提示，下一轮强制纯文本
    if (lastTerminalSuccess) {
      messages.push({
        role: "system",
        content: [
          "关键操作已完成（例如已在系统浏览器打开页面、已落盘、已移动/重命名，或已在资源管理器展示路径）。",
          "请立刻用简洁中文向用户汇报：做了什么、关键路径或标题/URL、用户应去哪里看；",
          "不要再调用任何工具，不要空口夸大未发生的动作。"
        ].join("")
      });
    }
  }

  // 轮次耗尽：尽量给用户可读结论，而不是硬失败
  if (lastTerminalSuccess) {
    return {
      content: applyReplySpeechGuard(lastTerminalSuccess.summary, {
        usedTools,
        didRevealInSystemBrowser,
        didOpenAutomationWindow,
        didOpenDesktopLocation,
        didCompleteDownload,
        didPageClick,
        didLongPress,
        lastOpenedUrl
      }),
      usedTools,
      rounds,
      taskId
    };
  }

  // 同工具熔断后若模型仍未给最终回复：直接用可读收口，不再抛泛化错误
  if (sameToolStreakClose) {
    const content = formatSameToolStreakCloseMessage(
      sameToolStreakClose.toolName,
      sameToolStreakClose.errorCode,
      sameToolStreakClose.streakCount
    );
    return {
      content,
      usedTools,
      rounds,
      taskId,
      outcome: "failed"
    };
  }

  // 预算耗尽且无终态：友好中文收口，禁止再抛内部「超过 6 轮」硬错误砸用户
  const exhaustedContent = formatToolBudgetExhaustedMessage({
    maxRounds,
    toolInvocationCount,
    lastToolName: sameToolStreakName || undefined,
    lastErrorCode: lastSameToolErrorCode || undefined
  });
  options.onProgress?.(exhaustedContent);
  setTaskProgress({
    taskId,
    status: "failed",
    goal: "对话工具循环",
    completedSteps: toolInvocationCount,
    totalSteps: maxToolInvocations,
    message: exhaustedContent,
    updatedAt: Date.now()
  });
  appendExecutionLog({
    level: "warn",
    taskId,
    event: "task.budget_exhausted",
    message: exhaustedContent,
    data: {
      maxRounds,
      toolInvocationCount,
      lastToolName: sameToolStreakName || null,
      lastErrorCode: lastSameToolErrorCode || null
    }
  });
  return {
    content: exhaustedContent,
    usedTools,
    rounds,
    taskId,
    outcome: "failed"
  };
}

async function runSingleToolCall(params: {
  taskId: string;
  stepId: string;
  toolName: string;
  toolCall: ProviderToolCall;
  requestConfirmation?: (
    request: ConfirmationRequest
  ) => Promise<ConfirmationDecision>;
  signal?: AbortSignal;
  onProgress?: (message: string) => void;
  permissionGrants: PermissionGrants;
  taskGate?: BehaviorDecision["taskGate"];
}): Promise<string> {
  const toolName = params.toolName;

  // 执行前最后一道关系 gate：必须早于 schema、权限确认和 executeToolCall。
  if (params.taskGate && isBehaviorToolGateBlocked(params.taskGate)) {
    appendExecutionLog({
      level: "warn",
      taskId: params.taskId,
      stepId: params.stepId,
      toolName,
      event: "affect.task_gate.blocked_execution",
      message: "关系情绪门禁阻止工具进入执行器",
      data: {
        mood: params.taskGate.mood,
        grievance: params.taskGate.grievance,
        cooperation: params.taskGate.cooperation,
        taskContext: params.taskGate.taskContext,
        blockedTools: true,
        reason: params.taskGate.reason
      }
    });
    return serializeToolFailure(
      "本轮关系门禁已关闭普通、非安全工具；请如实说明没有执行，并请用户重新提出。",
      "AFFECT_TOOL_GATE_BLOCKED"
    );
  }

  const tool = getTool(toolName);

  if (!tool) {
    return serializeToolFailure(`未注册工具：${toolName}`, "TOOL_NOT_FOUND");
  }

  let parsedInput: unknown;
  try {
    parsedInput = parseToolArguments(params.toolCall.function?.arguments ?? "{}");
  } catch (error) {
    return serializeToolFailure(
      error instanceof Error ? error.message : "工具参数不是合法 JSON",
      "SCHEMA_INVALID"
    );
  }

  const input = injectTaskId(parsedInput, params.taskId);
  const safetyReview = inspectToolInputSafety(toolName, input);
  const riskLevel: RiskLevel = resolveHighestRiskLevel(tool.riskLevel, safetyReview.riskLevel);

  if (requiresUserConfirmation(riskLevel, DEFAULT_RISK_POLICY)) {
    if (!params.requestConfirmation) {
      return serializeToolFailure(
        "该操作需要你确认，但当前没有可用的确认通道。",
        "CONFIRMATION_REQUIRED"
      );
    }

    const confirmation = createConfirmationRequest({
      taskId: params.taskId,
      stepId: params.stepId,
      toolName,
      riskLevel,
      title: safetyReview.confirmationTitle ?? `确认：${toolName}`,
      description: safetyReview.confirmationDescription
        ?? buildToolConfirmationDescription(toolName, riskLevel, input),
      inputSummary: sanitizeForAudit(
        input && typeof input === "object" ? (input as Record<string, unknown>) : { value: input },
        tool.auditPolicy.redactInputKeys ?? []
      ) as Record<string, unknown>
    });

    const confirmWaitMessage = formatToolConfirmWaitMessage(toolName);
    params.onProgress?.(confirmWaitMessage);
    setTaskProgress({
      taskId: params.taskId,
      status: "waiting_confirmation",
      goal: "对话工具循环",
      currentStepId: params.stepId,
      currentStepTitle: toolName,
      currentToolName: toolName,
      completedSteps: 0,
      totalSteps: 1,
      message: confirmWaitMessage,
      updatedAt: Date.now()
    });

    appendExecutionLog({
      taskId: params.taskId,
      stepId: params.stepId,
      toolName,
      event: "permission.confirmation.requested",
      message: `等待用户确认：${toolName}`,
      data: {
        confirmationId: confirmation.id,
        riskLevel,
        safetyReason: safetyReview.reason
      }
    });

    const decision = await waitForAbortableConfirmation(
      confirmation,
      params.requestConfirmation,
      params.signal
    );
    if (!decision.approved) {
      appendExecutionLog({
        level: "warn",
        taskId: params.taskId,
        stepId: params.stepId,
        toolName,
        event: "permission.confirmation.rejected",
        message: "用户拒绝了该操作"
      });
      return serializeToolFailure(
        decision.note === "任务已取消" ? "任务已取消" : "用户拒绝了该操作",
        decision.note === "任务已取消" ? "CANCELLED" : "CONFIRMATION_REJECTED"
      );
    }

    appendExecutionLog({
      taskId: params.taskId,
      stepId: params.stepId,
      toolName,
      event: "permission.confirmation.approved",
      message: `用户已确认：${toolName}`
    });
  }

  const controller = new AbortController();
  const onAbort = () => controller.abort();
  if (params.signal) {
    if (params.signal.aborted) {
      controller.abort();
    } else {
      params.signal.addEventListener("abort", onAbort, { once: true });
    }
  }

  try {
    const result = await executeToolCall({
      taskId: params.taskId,
      stepId: params.stepId,
      toolName,
      input,
      signal: controller.signal,
      attempt: 1,
      permissionGrants: params.permissionGrants
    });

    if (result.ok) {
      return JSON.stringify(buildToolResultRelay(toolName, result));
    }

    // 回灌失败细节：fileCode/failureKind 让模型能点名 PATH_NOT_ALLOWED 等，
    // 而不是只剩笼统的 PERMISSION_DENIED / EXECUTION_FAILED。
    return JSON.stringify({
      ok: false,
      error: buildToolFailureRelay(result.error)
    });
  } finally {
    params.signal?.removeEventListener("abort", onAbort);
  }
}

/**
 * 把 ToolError 压成回灌模型的可读失败对象。
 * 优先暴露 fileCode / desktopCode / failureKind，便于用户侧失败分类。
 */
function buildToolFailureRelay(error: {
  code: string;
  message: string;
  details?: Record<string, unknown>;
}): Record<string, unknown> {
  const details = error.details ?? {};
  const relay: Record<string, unknown> = {
    code: error.code,
    message: error.message
  };

  if (details.bridgeUnreachable === true) {
    relay.bridgeUnreachable = true;
  }

  const fileCode = typeof details.fileCode === "string" ? details.fileCode.trim() : "";
  if (fileCode) {
    relay.fileCode = fileCode;
  }

  const desktopCode =
    typeof details.desktopCode === "string" ? details.desktopCode.trim() : "";
  if (desktopCode) {
    relay.desktopCode = desktopCode;
  }

  const failureKind =
    typeof details.failureKind === "string" ? details.failureKind.trim() : "";
  if (failureKind) {
    relay.failureKind = failureKind;
  }

  // 允许根列表对排错有用，但保持短数组；其它细节不下发以免刷上下文
  if (Array.isArray(details.allowedRoots)) {
    relay.allowedRoots = details.allowedRoots.slice(0, 8);
  }

  return relay;
}

async function waitForAbortableConfirmation(
  request: ConfirmationRequest,
  requestConfirmation: (request: ConfirmationRequest) => Promise<ConfirmationDecision>,
  signal?: AbortSignal
): Promise<ConfirmationDecision> {
  if (signal?.aborted) {
    return cancelledConfirmation(request.id);
  }
  if (!signal) {
    return requestConfirmation(request);
  }

  return new Promise<ConfirmationDecision>((resolve) => {
    let settled = false;
    const finish = (decision: ConfirmationDecision) => {
      if (settled) {
        return;
      }
      settled = true;
      signal.removeEventListener("abort", onAbort);
      resolve(decision);
    };
    const onAbort = () => finish(cancelledConfirmation(request.id));
    signal.addEventListener("abort", onAbort, { once: true });
    void requestConfirmation(request).then(finish, () => finish({
      requestId: request.id,
      approved: false,
      decidedAt: Date.now(),
      note: "确认请求失败"
    }));
  });
}

function cancelledConfirmation(requestId: string): ConfirmationDecision {
  return {
    requestId,
    approved: false,
    decidedAt: Date.now(),
    note: "任务已取消"
  };
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && (error.name === "AbortError" || error.message === "任务已取消");
}

function parseToolArguments(raw: string): unknown {
  const text = raw?.trim() || "{}";
  return JSON.parse(text) as unknown;
}

function injectTaskId(input: unknown, taskId: string): unknown {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return { taskId };
  }
  const record = input as Record<string, unknown>;
  if (typeof record.taskId === "string" && record.taskId.trim()) {
    return record;
  }
  return { ...record, taskId };
}

function serializeToolFailure(message: string, code: string) {
  return JSON.stringify({
    ok: false,
    error: { code, message }
  });
}

function truncateToolResult(payload: string) {
  if (payload.length <= MAX_TOOL_RESULT_CHARS) {
    return payload;
  }

  const parsed = safeParseJson(payload);
  if (parsed?.ok === true) {
    const summary = typeof parsed.summary === "string"
      ? parsed.summary.slice(0, 800)
      : "工具结果过大，已省略详细内容";
    const fallback: Record<string, unknown> = {
      ok: true,
      summary,
      data: {
        note: "工具结果超过最终回灌预算，详细 data 已省略；不要假设省略内容已经被检查。"
      },
      truncation: {
        truncated: true,
        reason: "TOOL_RESULT_RELAY_TOO_LARGE",
        originalCharacters: payload.length,
        maxCharacters: MAX_TOOL_RESULT_CHARS
      }
    };
    if (parsed.contentSafety) {
      fallback.contentSafety = parsed.contentSafety;
    }
    return JSON.stringify(fallback);
  }

  return JSON.stringify({
    ok: false,
    error: {
      code: "TOOL_RESULT_RELAY_TOO_LARGE",
      message: "工具结果超过最终回灌预算，已省略原始内容；请基于已有摘要回复用户，必要时换更窄的读取范围。"
    }
  });
}

function safeParseJson(text: string): Record<string, unknown> | null {
  try {
    const value = JSON.parse(text) as unknown;
    if (value && typeof value === "object" && !Array.isArray(value)) {
      return value as Record<string, unknown>;
    }
    return null;
  } catch {
    return null;
  }
}

function containsToolProtocolMarkup(content: string): boolean {
  return /(?:<[^>]*DSML[^>]*tool_calls>|<tool_calls>|<function_calls>|<[^>]*tool_calls[^>]*>)/i.test(
    content
  );
}

/** 判断一次工具结果是否为「桥接不可达」失败（sidecar 未启动） */
function isBridgeUnreachableToolResult(parsed: Record<string, unknown> | null) {
  if (!parsed || parsed.ok !== false) {
    return false;
  }
  const error = parsed.error;
  return (
    Boolean(error)
    && typeof error === "object"
    && (error as { bridgeUnreachable?: unknown }).bridgeUnreachable === true
  );
}

/** 从工具结果里提取错误码，供同工具熔断收口点名 */
function extractToolErrorCode(parsed: Record<string, unknown> | null): string {
  if (!parsed || parsed.ok !== false) {
    return "EXECUTION_FAILED";
  }
  const error = parsed.error;
  if (!error || typeof error !== "object") {
    return "EXECUTION_FAILED";
  }

  const record = error as {
    fileCode?: unknown;
    desktopCode?: unknown;
    failureKind?: unknown;
    code?: unknown;
  };

  // 优先更具体的文件/桌面错误码，方便用户听懂「不在允许根 / 目标已存在」
  if (typeof record.fileCode === "string" && record.fileCode.trim()) {
    return record.fileCode.trim();
  }
  if (typeof record.desktopCode === "string" && record.desktopCode.trim()) {
    return record.desktopCode.trim();
  }
  if (typeof record.failureKind === "string" && record.failureKind.trim()) {
    return record.failureKind.trim().toUpperCase();
  }
  if (typeof record.code === "string" && record.code.trim()) {
    return record.code.trim();
  }
  return "EXECUTION_FAILED";
}

/**
 * 熔断后的最终用户文案：
 * - 模型已点名工具 + 错误码 → 保留
 * - 否则用 formatSameToolStreakCloseMessage，避免泛泛「遇到问题」
 */
function ensureStreakCloseContent(
  content: string,
  streak: { toolName: string; errorCode: string; streakCount: number }
): string {
  const closeMessage = formatSameToolStreakCloseMessage(
    streak.toolName,
    streak.errorCode,
    streak.streakCount
  );
  if (!content) {
    return closeMessage;
  }
  const mentionsTool = content.includes(streak.toolName);
  const mentionsCode = content.includes(streak.errorCode);
  if (mentionsTool && mentionsCode) {
    return content;
  }
  return closeMessage;
}

function hasUsefulToolData(parsed: Record<string, unknown> | null) {
  if (!parsed || parsed.ok !== true) {
    return false;
  }
  const data = parsed.data;
  if (!data || typeof data !== "object") {
    return Boolean(parsed.summary);
  }
  const record = data as Record<string, unknown>;
  if (Array.isArray(record.results)) {
    return record.results.length > 0;
  }
  if (typeof record.finalUrl === "string" && record.finalUrl) {
    return true;
  }
  if (typeof record.openedUrl === "string" && record.openedUrl) {
    return true;
  }
  return true;
}

function createAbortedError() {
  const error = new Error("任务已取消");
  error.name = "AbortError";
  return error;
}

/**
 * 调度器 sidecar HTTP 客户端（/void-scheduler/*）。
 * Key 只经 unlock 进 sidecar 内存，不落盘；响应永不回显 Key。
 */

import { bridgeAuthHeadersForUrl } from "../../../lib/runtime/voidBridgeAuth";
import type { ModelConfig } from "../../settings/modelConfig";

const DEFAULT_BRIDGE_ORIGIN = "http://127.0.0.1:17872";

function resolveBridgeOrigin(): string {
  const env = (globalThis as {
    process?: { env?: Record<string, string | undefined> };
  }).process?.env;
  const origin = env?.VOID_BRIDGE_ORIGIN;
  if (origin && origin.trim()) {
    return origin.replace(/\/$/, "");
  }
  const port = env?.VOID_BRIDGE_PORT;
  if (port && port.trim()) {
    return `http://127.0.0.1:${port.trim()}`;
  }
  return DEFAULT_BRIDGE_ORIGIN;
}

export type SchedulerBridgeResponse<T> =
  | { ok: true; data: T }
  | { ok: false; error: { code: string; message: string; details?: Record<string, unknown> } };

export type SchedulerJobView = {
  id: string;
  name: string;
  prompt: string;
  kind: "at" | "every" | "cron";
  atMs?: number;
  everyMs?: number;
  expr?: string;
  tz?: string;
  anchorMs?: number;
  allowedToolNames: string[];
  timeoutMs: number;
  speakOnDeliver: boolean;
  enabled: boolean;
  createdAt: number;
  nextRunAtMs?: number;
  lastRunAtMs?: number;
  lastStatus?: string;
  missedCount: number;
  failStreak: number;
};

export type SchedulerRunView = {
  id: string;
  jobId: string;
  jobName: string;
  startedAt: number;
  finishedAt?: number;
  status: string;
  summary?: string;
  delivered: boolean;
};

export type SchedulerStatusView = {
  unlocked: boolean;
  running: number;
  jobCount: number;
  enabledCount: number;
};

function createSchedulerBridgeError(code: string, message: string, details?: Record<string, unknown>) {
  const error = new Error(message) as Error & {
    scheduleBridgeCode: string;
    details?: Record<string, unknown>;
  };
  error.scheduleBridgeCode = code;
  error.details = details;
  return error;
}

export function getSchedulerBridgeErrorInfo(error: unknown): {
  code: string;
  message: string;
  details?: Record<string, unknown>;
} {
  if (
    typeof error === "object"
    && error !== null
    && "scheduleBridgeCode" in error
    && typeof (error as { scheduleBridgeCode?: unknown }).scheduleBridgeCode === "string"
  ) {
    const coded = error as Error & {
      scheduleBridgeCode: string;
      details?: Record<string, unknown>;
    };
    return { code: coded.scheduleBridgeCode, message: coded.message, details: coded.details };
  }
  if (error instanceof Error) {
    return { code: "INTERNAL_ERROR", message: error.message };
  }
  return { code: "INTERNAL_ERROR", message: "调度桥接未知错误" };
}

async function postSchedulerApi<T>(
  pathname: string,
  body: Record<string, unknown>,
  signal?: AbortSignal
): Promise<T> {
  const url = `${resolveBridgeOrigin()}${pathname}`;
  const timeoutController = new AbortController();
  const timeoutHandle = setTimeout(() => timeoutController.abort(), 30_000);
  const onCallerAbort = () => timeoutController.abort();
  if (signal) {
    if (signal.aborted) {
      timeoutController.abort();
    } else {
      signal.addEventListener("abort", onCallerAbort, { once: true });
    }
  }

  let response: Response;
  try {
    const authHeaders = await bridgeAuthHeadersForUrl(url);
    response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...authHeaders },
      body: JSON.stringify(body),
      signal: timeoutController.signal
    });
  } catch (error) {
    const aborted = timeoutController.signal.aborted;
    const message = error instanceof Error ? error.message : "无法连接调度桥接服务";
    throw createSchedulerBridgeError(
      aborted && signal?.aborted
        ? "INTERNAL_ERROR"
        : aborted
          ? "TIMEOUT"
          : "BRIDGE_UNREACHABLE",
      aborted && signal?.aborted
        ? "调度请求已取消"
        : aborted
          ? `调度桥接超时（${url}）`
          : `调度桥接不可达（${url}）：${message}`
    );
  } finally {
    clearTimeout(timeoutHandle);
    signal?.removeEventListener("abort", onCallerAbort);
  }

  let payload: SchedulerBridgeResponse<T>;
  try {
    payload = (await response.json()) as SchedulerBridgeResponse<T>;
  } catch {
    throw createSchedulerBridgeError("INTERNAL_ERROR", `调度桥接返回非 JSON（HTTP ${response.status}）`);
  }
  if (!payload?.ok) {
    throw createSchedulerBridgeError(
      payload && "error" in payload ? payload.error.code : "INTERNAL_ERROR",
      payload && "error" in payload ? payload.error.message : "调度操作失败",
      payload && "error" in payload ? payload.error.details : undefined
    );
  }
  return payload.data;
}

async function getSchedulerApi<T>(pathname: string, signal?: AbortSignal): Promise<T> {
  const url = `${resolveBridgeOrigin()}${pathname}`;
  const timeoutController = new AbortController();
  const timeoutHandle = setTimeout(() => timeoutController.abort(), 30_000);
  try {
    const authHeaders = await bridgeAuthHeadersForUrl(url);
    const response = await fetch(url, {
      method: "GET",
      headers: { ...authHeaders },
      signal: timeoutController.signal
    });
    const payload = (await response.json()) as SchedulerBridgeResponse<T>;
    if (!payload?.ok) {
      throw createSchedulerBridgeError(
        payload && "error" in payload ? payload.error.code : "INTERNAL_ERROR",
        payload && "error" in payload ? payload.error.message : "调度查询失败"
      );
    }
    return payload.data;
  } catch (error) {
    if (error instanceof Error && "scheduleBridgeCode" in error) {
      throw error;
    }
    const message = error instanceof Error ? error.message : "无法连接调度桥接服务";
    throw createSchedulerBridgeError("BRIDGE_UNREACHABLE", `调度桥接不可达（${url}）：${message}`);
  } finally {
    clearTimeout(timeoutHandle);
    void signal;
  }
}

/** 回填模型 Key 进 sidecar 内存（创建任务前调用；幂等）。 */
export async function ensureSchedulerUnlocked(modelConfig: ModelConfig, signal?: AbortSignal): Promise<void> {
  await postSchedulerApi<{ unlocked: boolean }>("/void-scheduler/unlock", {
    modelConfig: {
      provider: modelConfig.provider,
      presetId: modelConfig.presetId,
      apiKey: modelConfig.apiKey,
      baseUrl: modelConfig.baseUrl,
      modelName: modelConfig.modelName,
      modelStrength: modelConfig.modelStrength,
      thinkingModeEnabled: modelConfig.thinkingModeEnabled,
      temperature: modelConfig.temperature,
      maxOutputTokens: modelConfig.maxOutputTokens,
      streamEnabled: false
    }
  }, signal);
}

export type ScheduleCreateRequest = {
  name?: string;
  prompt: string;
  kind: "at" | "every" | "cron";
  at?: string | number;
  every?: number | string;
  expr?: string;
  tz?: string;
  anchor?: string | number;
  allowedToolNames?: string[];
  timeoutMs?: number;
  speakOnDeliver?: boolean;
};

export async function createScheduledJob(input: ScheduleCreateRequest, signal?: AbortSignal): Promise<SchedulerJobView> {
  return postSchedulerApi<SchedulerJobView>("/void-scheduler/jobs/create", { ...input }, signal);
}

export async function listScheduledJobs(signal?: AbortSignal): Promise<SchedulerJobView[]> {
  return getSchedulerApi<SchedulerJobView[]>("/void-scheduler/jobs", signal);
}

export async function removeScheduledJob(id: string, signal?: AbortSignal): Promise<{ removed: boolean }> {
  return postSchedulerApi<{ removed: boolean }>("/void-scheduler/jobs/remove", { id }, signal);
}

export async function runScheduledJobNow(id: string, signal?: AbortSignal): Promise<{ runId: string; status: string }> {
  return postSchedulerApi<{ runId: string; status: string }>("/void-scheduler/jobs/run", { id }, signal);
}

export async function getSchedulerStatus(signal?: AbortSignal): Promise<SchedulerStatusView> {
  return getSchedulerApi<SchedulerStatusView>("/void-scheduler/status", signal);
}

export async function fetchRecentRuns(limit = 10, signal?: AbortSignal): Promise<SchedulerRunView[]> {
  const capped = Math.max(1, Math.min(Math.floor(limit) || 10, 20));
  return getSchedulerApi<SchedulerRunView[]>(`/void-scheduler/runs?limit=${capped}`, signal);
}

export async function fetchPendingRuns(signal?: AbortSignal): Promise<SchedulerRunView[]> {
  return getSchedulerApi<SchedulerRunView[]>("/void-scheduler/runs/pending", signal);
}

export async function acknowledgeRuns(runIds: string[], signal?: AbortSignal): Promise<{ acknowledged: number }> {
  return postSchedulerApi<{ acknowledged: number }>("/void-scheduler/runs/ack", { runIds }, signal);
}

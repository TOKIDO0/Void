/**
 * C 模型用量 sidecar HTTP 客户端（/void-model-usage/*，只读 + 预算设置）。
 */

import { bridgeAuthHeadersForUrl } from "../../../lib/runtime/voidBridgeAuth";

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

export type ModelUsageDayView = {
  date: string;
  calls: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  responseBytes: number;
  models: Record<string, { calls: number; promptTokens: number; completionTokens: number; totalTokens: number }>;
};

export type ModelUsageOverview = {
  today: ModelUsageDayView;
  last7: ModelUsageDayView[];
  dailyTokenCap: number;
};

async function requestUsageApi<T>(pathname: string, init?: RequestInit): Promise<T> {
  const url = `${resolveBridgeOrigin()}${pathname}`;
  const timeoutController = new AbortController();
  const timeoutHandle = setTimeout(() => timeoutController.abort(), 15_000);
  try {
    const authHeaders = await bridgeAuthHeadersForUrl(url);
    const response = await fetch(url, {
      ...init,
      headers: { "Content-Type": "application/json", ...authHeaders, ...(init?.headers ?? {}) },
      signal: timeoutController.signal
    });
    const payload = (await response.json()) as
      | { ok: true; data: T }
      | { ok: false; error: { code: string; message: string } };
    if (!payload?.ok) {
      throw new Error(
        payload && "error" in payload ? payload.error.message : "用量查询失败"
      );
    }
    return payload.data;
  } catch (error) {
    if (error instanceof Error) {
      throw error;
    }
    throw new Error("用量桥接不可达");
  } finally {
    clearTimeout(timeoutHandle);
  }
}

export async function fetchModelUsage(signal?: AbortSignal): Promise<ModelUsageOverview> {
  void signal;
  return requestUsageApi<ModelUsageOverview>("/void-model-usage", { method: "GET" });
}

export async function setDailyTokenCap(dailyTokenCap: number): Promise<{ dailyTokenCap: number }> {
  return requestUsageApi<{ dailyTokenCap: number }>("/void-model-usage/budget", {
    method: "POST",
    body: JSON.stringify({ dailyTokenCap })
  });
}

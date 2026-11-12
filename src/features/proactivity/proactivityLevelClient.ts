/**
 * PRO-02 主动程度 sidecar HTTP 客户端（/void-proactivity/level）。
 * 只做协议映射：档位语义、预算与 fail-safe 全部在 server/proactivity。
 */

import { bridgeAuthHeadersForUrl } from "../../lib/runtime/voidBridgeAuth";
import {
  getBridgeUnavailableHint,
  resolveVoidBridgeOrigin
} from "../../lib/runtime/voidBridgeRuntime";

export type ProactivityLevel = "restrained" | "balanced" | "attentive";

export type ProactivityBudget = {
  heartbeatIntervalMs: number;
  heartbeatDailyCap: number;
};

export type ProactivityLevelStatus = {
  level: ProactivityLevel;
  configStatus: "ok" | "missing" | "corrupt";
  budget: ProactivityBudget | null;
  updatedAt: number | null;
  serverNow: number;
};

type LevelResponse<T> =
  | { ok: true; data: T }
  | { ok: false; error: { code: string; message: string } };

async function requestLevelApi<T>(init?: RequestInit): Promise<T> {
  const url = `${resolveVoidBridgeOrigin()}/void-proactivity/level`;
  const timeoutController = new AbortController();
  const timeoutHandle = setTimeout(() => timeoutController.abort(), 15_000);
  try {
    const authHeaders = await bridgeAuthHeadersForUrl(url);
    const response = await fetch(url, {
      ...init,
      headers: { "Content-Type": "application/json", ...authHeaders, ...(init?.headers ?? {}) },
      signal: timeoutController.signal
    });
    const payload = (await response.json()) as LevelResponse<T>;
    if (!payload?.ok) {
      throw new Error(
        payload && "error" in payload ? payload.error.message : "主动程度请求失败"
      );
    }
    return payload.data;
  } catch (error) {
    if (error instanceof Error) {
      throw new Error(`${error.message}。${getBridgeUnavailableHint()}`);
    }
    throw new Error(`主动程度桥接不可达。${getBridgeUnavailableHint()}`);
  } finally {
    clearTimeout(timeoutHandle);
  }
}

export async function fetchProactivityLevelStatus(): Promise<ProactivityLevelStatus> {
  return requestLevelApi<ProactivityLevelStatus>({ method: "GET" });
}

export async function saveProactivityLevel(level: ProactivityLevel): Promise<ProactivityLevelStatus> {
  return requestLevelApi<ProactivityLevelStatus>({
    method: "POST",
    body: JSON.stringify({ level })
  });
}

/**
 * PRO-04 安静时段 sidecar HTTP 客户端（/void-proactivity/*）。
 *
 * 只做协议映射：不判断是否安静、不缓存窗口结论；判定与存储全部在 server/proactivity。
 */

import { bridgeAuthHeadersForUrl } from "../../lib/runtime/voidBridgeAuth";
import {
  getBridgeUnavailableHint,
  resolveVoidBridgeOrigin
} from "../../lib/runtime/voidBridgeRuntime";

export type QuietHoursConfig = {
  enabled: boolean;
  startMinutes: number;
  endMinutes: number;
};

export type QuietHoursConfigStatus = "ok" | "missing" | "corrupt";

export type ProactivityStatus = {
  config: QuietHoursConfig;
  configStatus: QuietHoursConfigStatus;
  quiet: boolean;
  windowEndsAt: number | null;
  nextChangeAt: number | null;
  updatedAt: number | null;
  serverNow: number;
};

type ProactivityResponse<T> =
  | { ok: true; data: T }
  | { ok: false; error: { code: string; message: string } };

async function requestProactivityApi<T>(pathname: string, init?: RequestInit): Promise<T> {
  const url = `${resolveVoidBridgeOrigin()}${pathname}`;
  const timeoutController = new AbortController();
  const timeoutHandle = setTimeout(() => timeoutController.abort(), 15_000);
  try {
    const authHeaders = await bridgeAuthHeadersForUrl(url);
    const response = await fetch(url, {
      ...init,
      headers: { "Content-Type": "application/json", ...authHeaders, ...(init?.headers ?? {}) },
      signal: timeoutController.signal
    });
    const payload = (await response.json()) as ProactivityResponse<T>;
    if (!payload?.ok) {
      throw new Error(
        payload && "error" in payload ? payload.error.message : "安静时段请求失败"
      );
    }
    return payload.data;
  } catch (error) {
    if (error instanceof Error) {
      throw new Error(`${error.message}。${getBridgeUnavailableHint()}`);
    }
    throw new Error(`安静时段桥接不可达。${getBridgeUnavailableHint()}`);
  } finally {
    clearTimeout(timeoutHandle);
  }
}

export async function fetchProactivityStatus(): Promise<ProactivityStatus> {
  return requestProactivityApi<ProactivityStatus>("/void-proactivity/status", { method: "GET" });
}

export async function saveQuietHours(config: QuietHoursConfig): Promise<ProactivityStatus> {
  return requestProactivityApi<ProactivityStatus>("/void-proactivity/quiet-hours", {
    method: "POST",
    body: JSON.stringify(config)
  });
}

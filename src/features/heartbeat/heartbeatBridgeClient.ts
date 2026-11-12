/**
 * PRO-05 静默巡检 sidecar HTTP 客户端（/void-heartbeat/*）。
 *
 * 只做协议映射：不在前端判断“该不该巡检/算不算问题”，也不缓存去重结论。
 * 判定与持久化全部在 server/heartbeat。
 */

import { bridgeAuthHeadersForUrl } from "../../lib/runtime/voidBridgeAuth";
import {
  getBridgeUnavailableHint,
  resolveVoidBridgeOrigin
} from "../../lib/runtime/voidBridgeRuntime";

export type HeartbeatCheckId =
  | "calendar-conflict"
  | "calendar-reminder-missing"
  | "scheduler-failed"
  | "delivery-undelivered"
  | "scheduler-job-stuck";

export type HeartbeatChecklistStatus = {
  path: string;
  status: "ok" | "missing" | "invalid";
  checks: HeartbeatCheckId[];
  unsupported: string[];
  reason?: "TOO_LARGE" | "UNREADABLE" | "TOO_MANY_LINES" | "TOO_MANY_CHECKS" | "NO_VALID_CHECKS";
};

export type HeartbeatRoundResult = {
  at: number;
  outcome: "NO_ISSUES" | "NOTIFIED" | "SUPPRESSED_DUPLICATE" | "SUPPRESSED_STATE_CORRUPT" | "SKIPPED" | "ENQUEUE_FAILED";
  skippedReason?: "DISABLED" | "NO_CHECKLIST" | "INVALID_CHECKLIST" | "DAILY_CAP" | "LEVEL_RESTRAINED";
  issuesFound: number;
  notified: number;
  suppressed: number;
  summary?: string;
  errorCode?: string;
};

export type HeartbeatStatus = {
  enabled: boolean;
  configStatus: "ok" | "missing" | "corrupt";
  checklist: HeartbeatChecklistStatus;
  stateStatus: "ok" | "missing" | "corrupt";
  level: "restrained" | "balanced" | "attentive";
  levelRestrained: boolean;
  lastRunAt: number | null;
  nextRunAt: number | null;
  roundsToday: number;
  dailyCap: number;
  lastResult: HeartbeatRoundResult | null;
  serverNow: number;
};

export type HeartbeatConfigResponse = {
  status: HeartbeatStatus;
  createdChecklist: boolean;
};

export type HeartbeatRunResponse = {
  result: HeartbeatRoundResult;
  status: HeartbeatStatus;
};

type HeartbeatResponse<T> =
  | { ok: true; data: T }
  | { ok: false; error: { code: string; message: string } };

async function requestHeartbeatApi<T>(pathname: string, init?: RequestInit): Promise<T> {
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
    const payload = (await response.json()) as HeartbeatResponse<T>;
    if (!payload?.ok) {
      throw new Error(
        payload && "error" in payload ? payload.error.message : "静默巡检请求失败"
      );
    }
    return payload.data;
  } catch (error) {
    if (error instanceof Error) {
      throw new Error(`${error.message}。${getBridgeUnavailableHint()}`);
    }
    throw new Error(`静默巡检桥接不可达。${getBridgeUnavailableHint()}`);
  } finally {
    clearTimeout(timeoutHandle);
  }
}

export async function fetchHeartbeatStatus(): Promise<HeartbeatStatus> {
  return requestHeartbeatApi<HeartbeatStatus>("/void-heartbeat/status", { method: "GET" });
}

export async function saveHeartbeatEnabled(enabled: boolean): Promise<HeartbeatConfigResponse> {
  return requestHeartbeatApi<HeartbeatConfigResponse>("/void-heartbeat/config", {
    method: "POST",
    body: JSON.stringify({ enabled })
  });
}

export async function runHeartbeatNow(): Promise<HeartbeatRunResponse> {
  return requestHeartbeatApi<HeartbeatRunResponse>("/void-heartbeat/run", { method: "POST" });
}

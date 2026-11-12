/**
 * BEH-01 行为聚合 sidecar HTTP 客户端（/void-behavior/*）。
 *
 * 只做协议映射：不判定活跃、不聚合、不缓存结论；判定与存储全部在 owner（server/behavior）。
 */

import { bridgeAuthHeadersForUrl } from "../../lib/runtime/voidBridgeAuth";
import {
  getBridgeUnavailableHint,
  resolveVoidBridgeOrigin
} from "../../lib/runtime/voidBridgeRuntime";

export type BehaviorDayView = {
  date: string;
  activeMinutesByHour: number[];
  activeMinutes: number;
  firstActiveAt: number;
  lastActiveAt: number;
  taskSucceeded: number;
  taskFailed: number;
  taskMissed: number;
};

export type BehaviorStatusView = {
  enabled: boolean;
  retentionDays: number;
  today: BehaviorDayView | null;
  lastSampleAt: number;
  rejectedSamples: number;
  outOfOrderSamples: number;
  corruptCount: number;
  probeReadFailures: number;
  runsScanned: number;
  fileBytes: number;
};

export type BehaviorProbeSample = {
  tsMs: number;
  idleSec: number;
};

export type BehaviorIngestView = {
  accepted: number;
  rejected: number;
  disabled: boolean;
};

// 画像字段与 server/behavior/behaviorProfile.ts 保持一致。
// src 编译图禁止 import server/**，因此这里只做类型镜像，不引入 Node 代码。
export type BehaviorChronotype = "early" | "late" | "neutral" | "unknown";

export type BehaviorActiveWindowView = {
  startHour: number;
  endHourExclusive: number;
  avgMinutesPerDay: number;
};

export type BehaviorRestGapView = {
  startHour: number;
  endHourExclusive: number;
};

export type BehaviorProfileMemoryDraft = {
  memoryType: "preference";
  subjectType: "self";
  subjectName: string;
  content: string;
  confidence: number;
  source: "behaviorProfile";
};

export type BehaviorProfileView = {
  status: "ok" | "insufficient_data" | "disabled";
  enabled: boolean;
  reason: string;
  windowDays: number;
  dataThrough: string | null;
  evidence: {
    sampleDays: number;
    totalActiveMinutes: number;
    firstActiveMedianMinute: number | null;
    lastActiveMedianMinute: number | null;
  };
  chronotype: BehaviorChronotype;
  activeWindows: BehaviorActiveWindowView[];
  restGaps: BehaviorRestGapView[];
  confidence: number;
  memoryDraft: BehaviorProfileMemoryDraft | null;
  signature: string;
  generatedAt: number;
};

async function requestBehaviorApi<T>(pathname: string, init?: RequestInit): Promise<T> {
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
    const payload = (await response.json()) as
      | { ok: true; data: T }
      | { ok: false; error: { code: string; message: string } };
    if (!payload?.ok) {
      throw new Error(
        payload && "error" in payload ? payload.error.message : "行为观察请求失败"
      );
    }
    return payload.data;
  } catch (error) {
    if (error instanceof Error) {
      throw new Error(`${error.message}。${getBridgeUnavailableHint()}`);
    }
    throw new Error(`行为观察桥接不可达。${getBridgeUnavailableHint()}`);
  } finally {
    clearTimeout(timeoutHandle);
  }
}

export async function fetchBehaviorStatus(): Promise<BehaviorStatusView> {
  return requestBehaviorApi<BehaviorStatusView>("/void-behavior/status", { method: "GET" });
}

export async function fetchBehaviorProfile(): Promise<BehaviorProfileView> {
  return requestBehaviorApi<BehaviorProfileView>("/void-behavior/profile", { method: "GET" });
}

export async function setBehaviorEnabled(enabled: boolean): Promise<{ enabled: boolean }> {
  return requestBehaviorApi<{ enabled: boolean }>("/void-behavior/enabled", {
    method: "POST",
    body: JSON.stringify({ enabled })
  });
}

export async function postBehaviorSamples(
  samples: BehaviorProbeSample[],
  probeReadFailures: number
): Promise<BehaviorIngestView> {
  return requestBehaviorApi<BehaviorIngestView>("/void-behavior/sample", {
    method: "POST",
    body: JSON.stringify({ samples, probeReadFailures })
  });
}

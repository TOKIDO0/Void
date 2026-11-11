/**
 * CAL 日程 sidecar HTTP 客户端（/void-calendar/*）。
 * 与调度器同桥接通道、同错误语义；成功 { ok:true, data }，失败 { ok:false, error }。
 */

import { bridgeAuthHeadersForUrl } from "../../../lib/runtime/voidBridgeAuth";
import {
  getBridgeUnavailableHint,
  resolveVoidBridgeOrigin
} from "../../../lib/runtime/voidBridgeRuntime";

export type CalendarEventStatus = "planned" | "done" | "cancelled";

export type CalendarEventView = {
  id: string;
  title: string;
  startAt: number;
  endAt: number;
  allDay: boolean;
  location?: string;
  participants: string[];
  notes?: string;
  status: CalendarEventStatus;
  remindMinutesBefore: number;
  source: "user" | "agent";
  reminderJobId?: string;
  createdAt: number;
  updatedAt: number;
};

type CalendarBridgeResponse<T> =
  | { ok: true; data: T }
  | { ok: false; error: { code: string; message: string; details?: Record<string, unknown> } };

function createCalendarBridgeError(code: string, message: string, details?: Record<string, unknown>) {
  const error = new Error(message) as Error & {
    calendarBridgeCode: string;
    details?: Record<string, unknown>;
  };
  error.calendarBridgeCode = code;
  error.details = details;
  return error;
}

export function getCalendarBridgeErrorInfo(error: unknown): {
  code: string;
  message: string;
  details?: Record<string, unknown>;
} {
  if (
    typeof error === "object"
    && error !== null
    && "calendarBridgeCode" in error
    && typeof (error as { calendarBridgeCode?: unknown }).calendarBridgeCode === "string"
  ) {
    const coded = error as Error & {
      calendarBridgeCode: string;
      details?: Record<string, unknown>;
    };
    return { code: coded.calendarBridgeCode, message: coded.message, details: coded.details };
  }
  if (error instanceof Error) {
    return { code: "INTERNAL_ERROR", message: error.message };
  }
  return { code: "INTERNAL_ERROR", message: "日程桥接未知错误" };
}

async function requestCalendarApi<T>(
  method: "GET" | "POST",
  pathname: string,
  body?: Record<string, unknown>,
  signal?: AbortSignal
): Promise<T> {
  const url = `${resolveVoidBridgeOrigin()}${pathname}`;
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
      method,
      headers: method === "POST"
        ? { "Content-Type": "application/json", ...authHeaders }
        : { ...authHeaders },
      body: method === "POST" ? JSON.stringify(body ?? {}) : undefined,
      signal: timeoutController.signal
    });
  } catch (error) {
    const aborted = timeoutController.signal.aborted;
    const message = error instanceof Error ? error.message : "无法连接日程桥接服务";
    throw createCalendarBridgeError(
      aborted ? "TIMEOUT" : "BRIDGE_UNREACHABLE",
      aborted
        ? `日程桥接超时（${url}）`
        : `日程桥接不可达（${url}）：${message}。${getBridgeUnavailableHint()}`
    );
  } finally {
    clearTimeout(timeoutHandle);
    signal?.removeEventListener("abort", onCallerAbort);
  }

  let payload: CalendarBridgeResponse<T>;
  try {
    payload = (await response.json()) as CalendarBridgeResponse<T>;
  } catch {
    throw createCalendarBridgeError("INTERNAL_ERROR", `日程桥接返回非 JSON（HTTP ${response.status}）`);
  }
  if (!payload?.ok) {
    throw createCalendarBridgeError(
      payload && "error" in payload ? payload.error.code : "INTERNAL_ERROR",
      payload && "error" in payload ? payload.error.message : "日程操作失败",
      payload && "error" in payload ? payload.error.details : undefined
    );
  }
  return payload.data;
}

export async function listCalendarEvents(
  from: number,
  to: number,
  signal?: AbortSignal
): Promise<CalendarEventView[]> {
  return requestCalendarApi<CalendarEventView[]>(
    "GET",
    `/void-calendar/events?from=${from}&to=${to}`,
    undefined,
    signal
  );
}

export async function createCalendarEvent(
  input: {
    title: string;
    startAt: number;
    endAt?: number;
    allDay?: boolean;
    location?: string;
    participants?: string[];
    notes?: string;
    remindMinutesBefore?: number;
  },
  signal?: AbortSignal
): Promise<CalendarEventView & { conflicts?: CalendarEventView[] }> {
  return requestCalendarApi("POST", "/void-calendar/events/create", { ...input, source: "agent" }, signal);
}

export async function updateCalendarEvent(
  input: {
    id: string;
    title?: string;
    startAt?: number;
    endAt?: number;
    allDay?: boolean;
    location?: string;
    participants?: string[];
    notes?: string;
    remindMinutesBefore?: number;
    status?: CalendarEventStatus;
  },
  signal?: AbortSignal
): Promise<CalendarEventView & { conflicts?: CalendarEventView[] }> {
  return requestCalendarApi("POST", "/void-calendar/events/update", { ...input }, signal);
}

export async function cancelCalendarEvent(
  id: string,
  signal?: AbortSignal
): Promise<{ cancelled: boolean; id: string }> {
  return requestCalendarApi("POST", "/void-calendar/events/cancel", { id }, signal);
}

export async function findCalendarConflicts(
  startAt: number,
  endAt: number,
  excludeId?: string,
  signal?: AbortSignal
): Promise<CalendarEventView[]> {
  return requestCalendarApi("POST", "/void-calendar/events/conflicts", { startAt, endAt, excludeId }, signal);
}

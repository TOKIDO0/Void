/**
 * CAL 日程 HTTP 路由：/void-calendar/*（回环 + token，与其它 sidecar 模块同契约）。
 * 成功 { ok:true, data }，失败 { ok:false, error:{ code, message } }。
 *
 * 提醒绑定：事件是事实，scheduler job 只是到点触发器。
 * 创建/更新事件时派生一个 at job；job 触发后自删，事件保留。
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import { isInvalidJsonBody, isRequestBodyTooLarge, readJsonBody } from "../http/httpRequest";
import { notifySchedulerChanged } from "../scheduler/schedulerRunner";
import { schedulerStore } from "../scheduler/schedulerStore";
import { DEFAULT_UNATTENDED_TOOL_NAMES } from "../scheduler/schedulerTypes";
import { calendarStore } from "./calendarStore";
import {
  createCalendarError,
  getCalendarErrorInfo,
  MAX_LOCATION_CHARS,
  MAX_NOTES_CHARS,
  MAX_PARTICIPANT_CHARS,
  MAX_PARTICIPANTS,
  MAX_QUERY_SPAN_DAYS,
  MAX_REMIND_MINUTES,
  MAX_TITLE_CHARS,
  type CalendarEvent,
  type CalendarEventStatus
} from "./calendarTypes";

const DAY_MS = 24 * 60 * 60 * 1000;
const MINUTE_MS = 60 * 1000;

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  if (response.destroyed || response.writableEnded) {
    return;
  }
  response.statusCode = status;
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  response.end(JSON.stringify(body));
}

function asRecord(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return {};
}

async function withCalendarHandler<T>(
  response: ServerResponse,
  work: () => Promise<T> | T
): Promise<void> {
  try {
    const data = await work();
    sendJson(response, 200, { ok: true, data });
  } catch (error) {
    if (isRequestBodyTooLarge(error)) {
      sendJson(response, 413, {
        ok: false,
        error: { code: "REQUEST_BODY_TOO_LARGE", message: (error as Error).message }
      });
      return;
    }
    if (isInvalidJsonBody(error)) {
      sendJson(response, 400, {
        ok: false,
        error: { code: "INVALID_REQUEST", message: (error as Error).message }
      });
      return;
    }
    const info = getCalendarErrorInfo(error);
    const status = info.code === "NOT_FOUND" ? 404 : info.code === "EVENT_LIMIT" ? 409 : 400;
    sendJson(response, status, { ok: false, error: info });
  }
}

function readString(value: unknown, maxChars: number): string {
  return typeof value === "string" ? value.trim().slice(0, maxChars) : "";
}

function readParticipants(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim().slice(0, MAX_PARTICIPANT_CHARS))
    .filter(Boolean)
    .slice(0, MAX_PARTICIPANTS);
}

function readTime(value: unknown, field: string): number {
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw createCalendarError("INVALID_REQUEST", `${field} 不是合法时间`);
    }
    return value;
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    // 查询串里的毫秒时间戳是数字字符串，不能交给 Date.parse（会得到 NaN）。
    if (/^-?\d+$/.test(trimmed)) {
      const numeric = Number(trimmed);
      if (Number.isFinite(numeric)) {
        return numeric;
      }
    }
    const parsed = Date.parse(trimmed);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  throw createCalendarError("INVALID_REQUEST", `${field} 不是合法时间`);
}

/** 提醒 job 的提示词：只要求一句话，避免模型展开成大段报告。 */
function buildReminderPrompt(event: CalendarEvent): string {
  const time = new Date(event.startAt).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", hour12: false });
  const location = event.location ? `，地点：${event.location}` : "";
  return `提醒：${event.title}（${time} 开始${location}）。用一句话提醒用户，不要展开解释。`;
}

/**
 * 重新绑定提醒 job。
 * 返回新的 jobId；不需要提醒时返回 undefined 并删除旧 job。
 */
function rebindReminder(event: CalendarEvent, previousJobId?: string): string | undefined {
  if (previousJobId) {
    schedulerStore.removeJob(previousJobId);
  }
  const needsReminder = event.status === "planned"
    && event.remindMinutesBefore >= 0
    && event.startAt - event.remindMinutesBefore * MINUTE_MS > Date.now();
  if (!needsReminder) {
    notifySchedulerChanged();
    return undefined;
  }
  const remindAt = event.startAt - event.remindMinutesBefore * MINUTE_MS;
  const job = schedulerStore.insertJob({
    name: `日程提醒：${event.title}`.slice(0, 80),
    prompt: buildReminderPrompt(event),
    kind: "at",
    atMs: remindAt,
    allowedToolNames: [...DEFAULT_UNATTENDED_TOOL_NAMES],
    timeoutMs: 60_000,
    speakOnDeliver: false,
    enabled: true,
    missedCount: 0,
    failStreak: 0,
    nextRunAtMs: remindAt,
    origin: "calendar"
  });
  notifySchedulerChanged();
  return job.id;
}

export async function handleCalendarHttpRequest(
  request: IncomingMessage,
  response: ServerResponse,
  pathname: string
): Promise<void> {
  if (request.method === "GET" && pathname === "/void-calendar/events") {
    await withCalendarHandler(response, () => {
      const url = new URL(request.url ?? "/", "http://127.0.0.1");
      const now = Date.now();
      const from = url.searchParams.get("from") ? readTime(url.searchParams.get("from"), "from") : now;
      const to = url.searchParams.get("to") ? readTime(url.searchParams.get("to"), "to") : from + 7 * DAY_MS;
      if (to <= from) {
        throw createCalendarError("INVALID_REQUEST", "to 必须晚于 from");
      }
      if (to - from > MAX_QUERY_SPAN_DAYS * DAY_MS) {
        throw createCalendarError("INVALID_REQUEST", `单次查询不得超过 ${MAX_QUERY_SPAN_DAYS} 天`);
      }
      return calendarStore.listEvents(from, to);
    });
    return;
  }

  if (request.method === "POST" && pathname === "/void-calendar/events/create") {
    await withCalendarHandler(response, async () => {
      const body = asRecord(await readJsonBody(request));
      const title = readString(body.title, MAX_TITLE_CHARS);
      if (!title) {
        throw createCalendarError("INVALID_REQUEST", "title 不能为空");
      }
      const startAt = readTime(body.startAt, "startAt");
      const endAt = body.endAt === undefined ? startAt + 60 * MINUTE_MS : readTime(body.endAt, "endAt");
      if (endAt <= startAt) {
        throw createCalendarError("INVALID_REQUEST", "endAt 必须晚于 startAt");
      }
      const remindMinutesBefore = typeof body.remindMinutesBefore === "number"
        ? Math.trunc(body.remindMinutesBefore)
        : 10;
      if (remindMinutesBefore < -1 || remindMinutesBefore > MAX_REMIND_MINUTES) {
        throw createCalendarError("INVALID_REQUEST", `提醒提前量必须在 -1 到 ${MAX_REMIND_MINUTES} 分钟之间`);
      }
      const draft: Omit<CalendarEvent, "id" | "createdAt" | "updatedAt"> = {
        title,
        startAt,
        endAt,
        allDay: body.allDay === true,
        location: readString(body.location, MAX_LOCATION_CHARS) || undefined,
        participants: readParticipants(body.participants),
        notes: readString(body.notes, MAX_NOTES_CHARS) || undefined,
        status: "planned",
        remindMinutesBefore,
        source: body.source === "user" ? "user" : "agent"
      };
      const created = calendarStore.insertEvent(draft);
      const reminderJobId = rebindReminder(created);
      if (reminderJobId !== created.reminderJobId) {
        calendarStore.updateEvent({ ...created, reminderJobId });
      }
      return { ...created, reminderJobId, conflicts: calendarStore.findConflicts(startAt, endAt, created.id) };
    });
    return;
  }

  if (request.method === "POST" && pathname === "/void-calendar/events/update") {
    await withCalendarHandler(response, async () => {
      const body = asRecord(await readJsonBody(request));
      const id = readString(body.id, 80);
      if (!id) {
        throw createCalendarError("INVALID_REQUEST", "id 不能为空");
      }
      const existing = calendarStore.getEvent(id);
      if (!existing) {
        throw createCalendarError("NOT_FOUND", `日程不存在：${id}`);
      }
      const next: CalendarEvent = { ...existing };
      if (body.title !== undefined) {
        const title = readString(body.title, MAX_TITLE_CHARS);
        if (!title) {
          throw createCalendarError("INVALID_REQUEST", "title 不能为空");
        }
        next.title = title;
      }
      if (body.startAt !== undefined) {
        next.startAt = readTime(body.startAt, "startAt");
      }
      if (body.endAt !== undefined) {
        next.endAt = readTime(body.endAt, "endAt");
      }
      if (next.endAt <= next.startAt) {
        throw createCalendarError("INVALID_REQUEST", "endAt 必须晚于 startAt");
      }
      if (body.allDay !== undefined) {
        next.allDay = body.allDay === true;
      }
      if (body.location !== undefined) {
        next.location = readString(body.location, MAX_LOCATION_CHARS) || undefined;
      }
      if (body.participants !== undefined) {
        next.participants = readParticipants(body.participants);
      }
      if (body.notes !== undefined) {
        next.notes = readString(body.notes, MAX_NOTES_CHARS) || undefined;
      }
      if (body.remindMinutesBefore !== undefined) {
        const remind = typeof body.remindMinutesBefore === "number" ? Math.trunc(body.remindMinutesBefore) : NaN;
        if (!Number.isFinite(remind) || remind < -1 || remind > MAX_REMIND_MINUTES) {
          throw createCalendarError("INVALID_REQUEST", `提醒提前量必须在 -1 到 ${MAX_REMIND_MINUTES} 分钟之间`);
        }
        next.remindMinutesBefore = remind;
      }
      if (body.status !== undefined) {
        const status = body.status as CalendarEventStatus;
        if (status !== "planned" && status !== "done" && status !== "cancelled") {
          throw createCalendarError("INVALID_REQUEST", "status 仅支持 planned/done/cancelled");
        }
        next.status = status;
      }
      const reminderJobId = rebindReminder(next, existing.reminderJobId);
      next.reminderJobId = reminderJobId;
      calendarStore.updateEvent(next);
      return { ...next, conflicts: calendarStore.findConflicts(next.startAt, next.endAt, next.id) };
    });
    return;
  }

  if (request.method === "POST" && pathname === "/void-calendar/events/cancel") {
    await withCalendarHandler(response, async () => {
      const body = asRecord(await readJsonBody(request));
      const id = readString(body.id, 80);
      if (!id) {
        throw createCalendarError("INVALID_REQUEST", "id 不能为空");
      }
      const existing = calendarStore.getEvent(id);
      if (!existing) {
        return { cancelled: false, id };
      }
      if (existing.status === "cancelled") {
        return { cancelled: false, id };
      }
      // 取消即解绑：不留孤儿提醒。
      if (existing.reminderJobId) {
        schedulerStore.removeJob(existing.reminderJobId);
        notifySchedulerChanged();
      }
      calendarStore.updateEvent({ ...existing, status: "cancelled", reminderJobId: undefined });
      return { cancelled: true, id };
    });
    return;
  }

  if (request.method === "POST" && pathname === "/void-calendar/events/conflicts") {
    await withCalendarHandler(response, async () => {
      const body = asRecord(await readJsonBody(request));
      const startAt = readTime(body.startAt, "startAt");
      const endAt = body.endAt === undefined ? startAt + 60 * MINUTE_MS : readTime(body.endAt, "endAt");
      if (endAt <= startAt) {
        throw createCalendarError("INVALID_REQUEST", "endAt 必须晚于 startAt");
      }
      const excludeId = readString(body.excludeId, 80) || undefined;
      return calendarStore.findConflicts(startAt, endAt, excludeId);
    });
    return;
  }

  sendJson(response, 404, { ok: false, error: { code: "NOT_FOUND", message: "未知日程端点" } });
}

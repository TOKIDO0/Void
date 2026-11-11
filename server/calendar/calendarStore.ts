/**
 * CAL 日程存储：<runtime>/calendar/events.json，原子写（tmp + rename）。
 * 仅 sidecar 进程内使用；前端经 /void-calendar/* 访问，不直读文件。
 * 与 schedulerStore 同一模式，避免两套存储风格。
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { resolveRuntimeRoot } from "../file/fileRuntimePaths";
import {
  createCalendarError,
  EVENT_RETENTION_DAYS,
  MAX_EVENTS,
  MAX_NOTES_CHARS,
  MAX_PARTICIPANT_CHARS,
  MAX_PARTICIPANTS,
  MAX_LOCATION_CHARS,
  MAX_TITLE_CHARS,
  type CalendarEvent,
  type CalendarEventStatus,
  type CalendarState
} from "./calendarTypes";

const DAY_MS = 24 * 60 * 60 * 1000;

function calendarDir(): string {
  const fromEnv = process.env.VOID_CALENDAR_DIR?.trim();
  if (fromEnv) {
    return fromEnv;
  }
  return join(resolveRuntimeRoot(), "calendar");
}

function eventsFile(): string {
  return join(calendarDir(), "events.json");
}

function emptyState(): CalendarState {
  return { version: 1, events: [] };
}

function nextEventId(): string {
  return `evt_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function readString(value: unknown, maxChars: number): string {
  return typeof value === "string" ? value.trim().slice(0, maxChars) : "";
}

function sanitizeEvent(raw: unknown): CalendarEvent | null {
  if (typeof raw !== "object" || raw === null) {
    return null;
  }
  const record = raw as Record<string, unknown>;
  if (typeof record.id !== "string" || typeof record.title !== "string") {
    return null;
  }
  const startAt = typeof record.startAt === "number" ? record.startAt : NaN;
  const endAt = typeof record.endAt === "number" ? record.endAt : NaN;
  if (!Number.isFinite(startAt) || !Number.isFinite(endAt) || endAt <= startAt) {
    return null;
  }
  const status: CalendarEventStatus = record.status === "done" || record.status === "cancelled"
    ? record.status
    : "planned";
  return {
    id: record.id,
    title: readString(record.title, MAX_TITLE_CHARS),
    startAt,
    endAt,
    allDay: record.allDay === true,
    location: readString(record.location, MAX_LOCATION_CHARS) || undefined,
    participants: Array.isArray(record.participants)
      ? record.participants
        .filter((item): item is string => typeof item === "string")
        .map((item) => item.trim().slice(0, MAX_PARTICIPANT_CHARS))
        .filter(Boolean)
        .slice(0, MAX_PARTICIPANTS)
      : [],
    notes: readString(record.notes, MAX_NOTES_CHARS) || undefined,
    status,
    remindMinutesBefore: typeof record.remindMinutesBefore === "number"
      ? Math.trunc(record.remindMinutesBefore)
      : 10,
    source: record.source === "user" ? "user" : "agent",
    reminderJobId: typeof record.reminderJobId === "string" ? record.reminderJobId : undefined,
    createdAt: typeof record.createdAt === "number" ? record.createdAt : startAt,
    updatedAt: typeof record.updatedAt === "number" ? record.updatedAt : startAt
  };
}

function sanitizeState(raw: unknown): CalendarState {
  const state = emptyState();
  if (typeof raw !== "object" || raw === null) {
    return state;
  }
  const record = raw as Record<string, unknown>;
  if (!Array.isArray(record.events)) {
    return state;
  }
  for (const item of record.events.slice(0, MAX_EVENTS)) {
    const event = sanitizeEvent(item);
    if (event) {
      state.events.push(event);
    }
  }
  return state;
}

/** 已过保留期的旧事件：done/cancelled 优先清理，planned 不静默删（用户可能确实忘了标记）。 */
function pruneExpired(events: CalendarEvent[], now: number): CalendarEvent[] {
  const cutoff = now - EVENT_RETENTION_DAYS * DAY_MS;
  return events.filter((event) => {
    if (event.endAt >= cutoff) {
      return true;
    }
    return event.status === "planned";
  });
}

class CalendarStore {
  private state: CalendarState | null = null;

  private ensureLoaded(): CalendarState {
    if (this.state) {
      return this.state;
    }
    try {
      mkdirSync(calendarDir(), { recursive: true });
      const file = eventsFile();
      if (!existsSync(file)) {
        this.state = emptyState();
        return this.state;
      }
      this.state = sanitizeState(JSON.parse(readFileSync(file, "utf8")));
      return this.state;
    } catch {
      this.state = emptyState();
      return this.state;
    }
  }

  private flush(): void {
    const state = this.ensureLoaded();
    state.events = state.events.slice(-MAX_EVENTS);
    const file = eventsFile();
    const tmp = `${file}.tmp`;
    writeFileSync(tmp, JSON.stringify(state), "utf8");
    renameSync(tmp, file);
  }

  listEvents(from: number, to: number): CalendarEvent[] {
    return this.ensureLoaded().events
      .filter((event) => event.startAt < to && event.endAt > from)
      .sort((a, b) => a.startAt - b.startAt)
      .map((event) => ({ ...event, participants: [...event.participants] }));
  }

  getEvent(id: string): CalendarEvent | null {
    const found = this.ensureLoaded().events.find((event) => event.id === id);
    return found ? { ...found, participants: [...found.participants] } : null;
  }

  insertEvent(draft: Omit<CalendarEvent, "id" | "createdAt" | "updatedAt">): CalendarEvent {
    const state = this.ensureLoaded();
    const now = Date.now();
    state.events = pruneExpired(state.events, now);
    if (state.events.length >= MAX_EVENTS) {
      throw createCalendarError("EVENT_LIMIT", `日程已达上限 ${MAX_EVENTS} 条，先清理旧事件`);
    }
    const event: CalendarEvent = {
      ...draft,
      id: nextEventId(),
      createdAt: now,
      updatedAt: now
    };
    state.events.push(event);
    this.flush();
    return { ...event, participants: [...event.participants] };
  }

  updateEvent(event: CalendarEvent): void {
    const state = this.ensureLoaded();
    const index = state.events.findIndex((item) => item.id === event.id);
    if (index < 0) {
      throw createCalendarError("NOT_FOUND", `日程不存在：${event.id}`);
    }
    state.events[index] = { ...event, updatedAt: Date.now() };
    this.flush();
  }

  /** 重叠检测：`[start,end)` 半开区间；首尾相接不算冲突。 */
  findConflicts(startAt: number, endAt: number, excludeId?: string): CalendarEvent[] {
    return this.ensureLoaded().events
      .filter((event) => event.status === "planned" && event.id !== excludeId)
      .filter((event) => event.startAt < endAt && event.endAt > startAt)
      .sort((a, b) => a.startAt - b.startAt)
      .map((event) => ({ ...event, participants: [...event.participants] }));
  }

  /** 测试/隔离专用：重置内存态（不删文件；文件由调用方隔离目录保证）。 */
  resetMemory(): void {
    this.state = null;
  }
}

export const calendarStore = new CalendarStore();

/**
 * CAL 日程事件类型真源。
 * 事件与 scheduler job 的关系：事件是事实，job 只是到点提醒的触发器。
 * job 触发后自删，事件必须留存，所以两者不能合并成一张表。
 */

export type CalendarEventStatus = "planned" | "done" | "cancelled";

export type CalendarEvent = {
  id: string;
  title: string;
  startAt: number;
  endAt: number;
  allDay: boolean;
  location?: string;
  participants: string[];
  notes?: string;
  status: CalendarEventStatus;
  /** 0 = 开始时提醒；-1 = 不提醒。 */
  remindMinutesBefore: number;
  source: "user" | "agent";
  /** 派生的 scheduler job id；缺失表示提醒未绑定成功。 */
  reminderJobId?: string;
  createdAt: number;
  updatedAt: number;
};

export type CalendarState = {
  version: 1;
  events: CalendarEvent[];
};

/** 全部为硬上界，禁止无界增长。 */
export const MAX_EVENTS = 5000;
export const MAX_TITLE_CHARS = 120;
export const MAX_LOCATION_CHARS = 120;
export const MAX_NOTES_CHARS = 500;
export const MAX_PARTICIPANTS = 8;
export const MAX_PARTICIPANT_CHARS = 40;
export const MAX_QUERY_SPAN_DAYS = 62;
export const MAX_REMIND_MINUTES = 1440;
export const EVENT_RETENTION_DAYS = 730;

export type CalendarErrorCode =
  | "INVALID_REQUEST"
  | "NOT_FOUND"
  | "EVENT_LIMIT"
  | "INTERNAL_ERROR";

export function createCalendarError(code: CalendarErrorCode, message: string): Error & { calendarCode: string } {
  const error = new Error(message) as Error & { calendarCode: string };
  error.calendarCode = code;
  return error;
}

export function getCalendarErrorInfo(error: unknown): { code: string; message: string } {
  if (
    typeof error === "object"
    && error !== null
    && "calendarCode" in error
    && typeof (error as { calendarCode?: unknown }).calendarCode === "string"
  ) {
    const coded = error as Error & { calendarCode: string };
    return { code: coded.calendarCode, message: coded.message };
  }
  return { code: "INTERNAL_ERROR", message: error instanceof Error ? error.message : "日程内部错误" };
}

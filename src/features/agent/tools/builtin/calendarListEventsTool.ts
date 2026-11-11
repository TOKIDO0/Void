// CAL 日程：只读查询区间内事件（L0）。不创建、不修改、不触发提醒。

import { listCalendarEvents } from "../../calendar/calendarBridgeClient";
import { CALENDAR_BRIDGE_RESOURCES, throwAsCalendarToolError } from "../../calendar/calendarToolShared";
import type { ToolDefinition } from "../toolTypes";

type ListInput = {
  from?: string | number;
  to?: string | number;
};

const DAY_MS = 24 * 60 * 60 * 1000;

function readTime(value: string | number | undefined, fallback: number): number {
  if (value === undefined) {
    return fallback;
  }
  const parsed = typeof value === "number" ? value : Date.parse(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export const calendarListEventsTool: ToolDefinition<ListInput, Record<string, unknown>> = {
  name: "calendar.listEvents",
  description: "只读查询指定区间内的日程事件（含时间、地点、参与人、状态）。默认查今天起 7 天。不修改任何数据。",
  version: "1.0.0",
  riskLevel: "L0",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      from: {
        anyOf: [{ type: "string" }, { type: "number" }],
        description: "区间起点：ISO 时间或毫秒时间戳。缺省为现在。"
      },
      to: {
        anyOf: [{ type: "string" }, { type: "number" }],
        description: "区间终点：ISO 时间或毫秒时间戳。缺省为起点后 7 天，最长 62 天。"
      }
    }
  },
  outputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["events", "count"],
    properties: {
      events: {
        type: "array",
        maxItems: 200,
        items: {
          type: "object",
          additionalProperties: false,
          required: ["id", "title", "startAt", "endAt", "status"],
          properties: {
            id: { type: "string" },
            title: { type: "string" },
            startAt: { type: "number" },
            endAt: { type: "number" },
            allDay: { type: "boolean" },
            location: { type: "string" },
            participants: { type: "array", items: { type: "string" } },
            notes: { type: "string" },
            status: { type: "string", enum: ["planned", "done", "cancelled"] },
            remindMinutesBefore: { type: "number" },
            reminderJobId: { type: "string" }
          }
        }
      },
      count: { type: "number", minimum: 0 }
    }
  },
  requiredResources: CALENDAR_BRIDGE_RESOURCES,
  permissions: ["tool.calendar.listEvents"],
  timeoutMs: 30_000,
  cancellable: true,
  idempotency: "safe",
  auditPolicy: { logInputSummary: true, logOutputSummary: true },
  enabled: true,
  maxRetries: 0,
  async execute(input, context) {
    try {
      const now = Date.now();
      const from = readTime(input.from, now);
      const to = readTime(input.to, from + 7 * DAY_MS);
      const events = await listCalendarEvents(from, to, context.signal);
      return { events, count: events.length } as unknown as Record<string, unknown>;
    } catch (error) {
      throwAsCalendarToolError(error);
    }
  }
};

// CAL 日程：局部更新事件并重绑提醒（L1）。只传要改的字段。

import { updateCalendarEvent } from "../../calendar/calendarBridgeClient";
import { CALENDAR_BRIDGE_RESOURCES, throwAsCalendarToolError } from "../../calendar/calendarToolShared";
import type { ToolDefinition } from "../toolTypes";

type UpdateInput = {
  id: string;
  title?: string;
  startAt?: string | number;
  endAt?: string | number;
  allDay?: boolean;
  location?: string;
  participants?: string[];
  notes?: string;
  remindMinutesBefore?: number;
  status?: "planned" | "done" | "cancelled";
};

function readTime(value: string | number, field: string): number {
  const parsed = typeof value === "number" ? value : Date.parse(value);
  if (!Number.isFinite(parsed)) {
    throw new Error(`${field} 不是合法时间：${String(value)}`);
  }
  return parsed;
}

export const calendarUpdateEventTool: ToolDefinition<UpdateInput, Record<string, unknown>> = {
  name: "calendar.updateEvent",
  description: "修改已有日程的字段（时间、标题、地点、参与人、提醒），并自动重绑提醒。只传要改的字段。",
  version: "1.0.0",
  riskLevel: "L1",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["id"],
    properties: {
      id: { type: "string", description: "事件 id（evt_ 开头）" },
      title: { type: "string" },
      startAt: { anyOf: [{ type: "string" }, { type: "number" }] },
      endAt: { anyOf: [{ type: "string" }, { type: "number" }] },
      allDay: { type: "boolean" },
      location: { type: "string" },
      participants: { type: "array", maxItems: 8, items: { type: "string" } },
      notes: { type: "string" },
      remindMinutesBefore: { type: "number", minimum: -1, maximum: 1440 },
      status: {
        type: "string",
        enum: ["planned", "done", "cancelled"],
        description: "标记完成用 done；取消请用 calendar.cancelEvent"
      }
    }
  },
  outputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["id", "title", "startAt", "endAt", "status", "reminderBound"],
    properties: {
      id: { type: "string" },
      title: { type: "string" },
      startAt: { type: "number" },
      endAt: { type: "number" },
      status: { type: "string" },
      remindMinutesBefore: { type: "number" },
      reminderJobId: { type: "string" },
      reminderBound: { type: "boolean" },
      conflicts: { type: "array", maxItems: 10, items: { type: "object", additionalProperties: true } }
    }
  },
  requiredResources: CALENDAR_BRIDGE_RESOURCES,
  permissions: ["tool.calendar.updateEvent"],
  timeoutMs: 30_000,
  cancellable: true,
  idempotency: "safe",
  auditPolicy: { logInputSummary: true, logOutputSummary: true },
  enabled: true,
  maxRetries: 0,
  async execute(input, context) {
    try {
      const updated = await updateCalendarEvent({
        id: input.id,
        title: input.title,
        startAt: input.startAt === undefined ? undefined : readTime(input.startAt, "startAt"),
        endAt: input.endAt === undefined ? undefined : readTime(input.endAt, "endAt"),
        allDay: input.allDay,
        location: input.location,
        participants: input.participants,
        notes: input.notes,
        remindMinutesBefore: input.remindMinutesBefore,
        status: input.status
      }, context.signal);
      return {
        id: updated.id,
        title: updated.title,
        startAt: updated.startAt,
        endAt: updated.endAt,
        status: updated.status,
        remindMinutesBefore: updated.remindMinutesBefore,
        reminderJobId: updated.reminderJobId,
        reminderBound: Boolean(updated.reminderJobId),
        conflicts: updated.conflicts ?? []
      } as unknown as Record<string, unknown>;
    } catch (error) {
      throwAsCalendarToolError(error);
    }
  }
};

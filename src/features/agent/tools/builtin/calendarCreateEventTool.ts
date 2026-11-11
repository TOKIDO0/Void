// CAL 日程：创建事件并自动绑定到点提醒（L1）。
// 为什么 L1 而不是 L2：只产生本地通知，未来不会自主调用工具；与后台任务的风险面不同。

import { createCalendarEvent } from "../../calendar/calendarBridgeClient";
import { CALENDAR_BRIDGE_RESOURCES, throwAsCalendarToolError } from "../../calendar/calendarToolShared";
import type { ToolDefinition } from "../toolTypes";

type CreateInput = {
  title: string;
  startAt: string | number;
  endAt?: string | number;
  allDay?: boolean;
  location?: string;
  participants?: string[];
  notes?: string;
  remindMinutesBefore?: number;
};

function readTime(value: string | number, field: string): number {
  const parsed = typeof value === "number" ? value : Date.parse(value);
  if (!Number.isFinite(parsed)) {
    throw new Error(`${field} 不是合法时间：${String(value)}`);
  }
  return parsed;
}

export const calendarCreateEventTool: ToolDefinition<CreateInput, Record<string, unknown>> = {
  name: "calendar.createEvent",
  description: "创建一条日程事件，并自动在开始前按提前量提醒用户。开始时间必填；结束时间缺省为 1 小时后。",
  version: "1.0.0",
  riskLevel: "L1",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["title", "startAt"],
    properties: {
      title: { type: "string", description: "日程标题，例如「和张三开会」" },
      startAt: {
        anyOf: [{ type: "string" }, { type: "number" }],
        description: "开始时间：ISO 8601 或毫秒时间戳"
      },
      endAt: {
        anyOf: [{ type: "string" }, { type: "number" }],
        description: "结束时间：ISO 8601 或毫秒时间戳。缺省为开始后 1 小时"
      },
      allDay: { type: "boolean", description: "是否全天事件" },
      location: { type: "string", description: "地点，例如「3 楼会议室」" },
      participants: {
        type: "array",
        maxItems: 8,
        items: { type: "string" },
        description: "参与人名字，最多 8 个"
      },
      notes: { type: "string", description: "备注，最多 500 字" },
      remindMinutesBefore: {
        type: "number",
        minimum: -1,
        maximum: 1440,
        description: "提前多少分钟提醒；0=开始时提醒；-1=不提醒；缺省 10"
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
      reminderBound: { type: "boolean", description: "提醒是否已绑定；false 表示事件已建但不会到点提醒" },
      conflicts: {
        type: "array",
        maxItems: 10,
        items: {
          type: "object",
          additionalProperties: true,
          properties: {
            id: { type: "string" },
            title: { type: "string" },
            startAt: { type: "number" },
            endAt: { type: "number" }
          }
        }
      }
    }
  },
  requiredResources: CALENDAR_BRIDGE_RESOURCES,
  permissions: ["tool.calendar.createEvent"],
  timeoutMs: 30_000,
  cancellable: true,
  idempotency: "unknown",
  auditPolicy: { logInputSummary: true, logOutputSummary: true },
  enabled: true,
  maxRetries: 0,
  async execute(input, context) {
    try {
      const startAt = readTime(input.startAt, "startAt");
      const endAt = input.endAt === undefined ? undefined : readTime(input.endAt, "endAt");
      const created = await createCalendarEvent({
        title: input.title,
        startAt,
        endAt,
        allDay: input.allDay,
        location: input.location,
        participants: input.participants,
        notes: input.notes,
        remindMinutesBefore: input.remindMinutesBefore
      }, context.signal);
      return {
        id: created.id,
        title: created.title,
        startAt: created.startAt,
        endAt: created.endAt,
        status: created.status,
        remindMinutesBefore: created.remindMinutesBefore,
        reminderJobId: created.reminderJobId,
        reminderBound: Boolean(created.reminderJobId),
        conflicts: created.conflicts ?? []
      } as unknown as Record<string, unknown>;
    } catch (error) {
      throwAsCalendarToolError(error);
    }
  }
};

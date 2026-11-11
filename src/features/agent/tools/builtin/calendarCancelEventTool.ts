// CAL 日程：取消事件并解绑提醒（L1）。幂等：已取消的再取消返回 false。

import { cancelCalendarEvent } from "../../calendar/calendarBridgeClient";
import { CALENDAR_BRIDGE_RESOURCES, throwAsCalendarToolError } from "../../calendar/calendarToolShared";
import type { ToolDefinition } from "../toolTypes";

type CancelInput = { id: string };

export const calendarCancelEventTool: ToolDefinition<CancelInput, Record<string, unknown>> = {
  name: "calendar.cancelEvent",
  description: "取消一条日程并移除它的到点提醒。事件会保留（状态改为 cancelled），不会从记录里消失。",
  version: "1.0.0",
  riskLevel: "L1",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["id"],
    properties: {
      id: { type: "string", description: "事件 id（evt_ 开头）" }
    }
  },
  outputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["cancelled", "id"],
    properties: {
      cancelled: { type: "boolean", description: "false 表示事件不存在或已取消" },
      id: { type: "string" }
    }
  },
  requiredResources: CALENDAR_BRIDGE_RESOURCES,
  permissions: ["tool.calendar.cancelEvent"],
  timeoutMs: 30_000,
  cancellable: true,
  idempotency: "safe",
  auditPolicy: { logInputSummary: true, logOutputSummary: true },
  enabled: true,
  maxRetries: 0,
  async execute(input, context) {
    try {
      return await cancelCalendarEvent(input.id, context.signal) as unknown as Record<string, unknown>;
    } catch (error) {
      throwAsCalendarToolError(error);
    }
  }
};

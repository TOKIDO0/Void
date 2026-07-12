import { openKnownLocation } from "../../desktop/desktopBridgeClient";
import type {
  DesktopKnownLocation,
  DesktopOpenKnownLocationData
} from "../../desktop/desktopBridgeTypes";
import {
  DESKTOP_KNOWN_LOCATION_RESOURCES,
  throwAsDesktopToolError
} from "../../desktop/desktopToolShared";
import type { ToolDefinition } from "../toolTypes";

export type DesktopOpenKnownLocationToolInput = {
  location: DesktopKnownLocation;
};

export type DesktopOpenKnownLocationToolOutput = DesktopOpenKnownLocationData;

export const desktopOpenKnownLocationTool: ToolDefinition<
  DesktopOpenKnownLocationToolInput,
  DesktopOpenKnownLocationToolOutput
> = {
  name: "desktop.openKnownLocation",
  description: "打开代码内允许的 Windows 系统位置。当前只支持 this_pc（此电脑），不接受任意路径、程序或命令。",
  version: "1.0.0",
  riskLevel: "L2",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["location"],
    properties: {
      location: {
        type: "string",
        enum: ["this_pc"],
        description: "固定系统位置；this_pc 表示 Windows 此电脑"
      }
    }
  },
  outputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["location", "openedAt"],
    properties: {
      location: { type: "string", enum: ["this_pc"] },
      openedAt: { type: "number" }
    }
  },
  requiredResources: DESKTOP_KNOWN_LOCATION_RESOURCES,
  permissions: ["tool.desktop.openKnownLocation"],
  timeoutMs: 15_000,
  cancellable: true,
  idempotency: "safe",
  auditPolicy: { logInputSummary: true, logOutputSummary: true },
  enabled: true,
  maxRetries: 0,
  async execute(input, context) {
    try {
      return await openKnownLocation({ location: input.location }, context.signal);
    } catch (error) {
      throwAsDesktopToolError(error);
    }
  }
};

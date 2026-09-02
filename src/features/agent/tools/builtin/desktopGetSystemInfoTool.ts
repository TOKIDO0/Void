import { getSystemInfo } from "../../desktop/desktopBridgeClient";
import type { DesktopSystemInfoData } from "../../desktop/desktopBridgeTypes";
import { DESKTOP_APP_RESOURCES, throwAsDesktopToolError } from "../../desktop/desktopToolShared";
import type { ToolDefinition } from "../toolTypes";

export type DesktopGetSystemInfoToolInput = Record<string, never>;
export type DesktopGetSystemInfoToolOutput = DesktopSystemInfoData;

export const desktopGetSystemInfoTool: ToolDefinition<DesktopGetSystemInfoToolInput, DesktopGetSystemInfoToolOutput> = {
  name: "desktop.getSystemInfo",
  description: "只读获取本机系统信息（平台、架构、内存、CPU 数、主屏分辨率），用于了解设备状态。",
  version: "1.0.0",
  riskLevel: "L0",
  inputSchema: { type: "object", additionalProperties: false, properties: {} },
  outputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["platform", "arch", "totalMemMb", "freeMemMb", "cpus", "collectedAt"],
    properties: {
      platform: { type: "string" },
      arch: { type: "string" },
      totalMemMb: { type: "number" },
      freeMemMb: { type: "number" },
      cpus: { type: "number" },
      screen: { type: "object", properties: { width: { type: "number" }, height: { type: "number" } } },
      collectedAt: { type: "number" }
    }
  },
  requiredResources: DESKTOP_APP_RESOURCES,
  permissions: ["tool.desktop.getSystemInfo"],
  timeoutMs: 8000,
  cancellable: true,
  idempotency: "safe",
  auditPolicy: { logInputSummary: true, logOutputSummary: true },
  enabled: true,
  maxRetries: 0,
  async execute(_input, context) {
    try {
      return await getSystemInfo(context.signal);
    } catch (error) {
      throwAsDesktopToolError(error);
    }
  }
};

// L0：只读列出开始菜单已安装应用（上限 200），供后续启动时按名称匹配。

import { listInstalledApplications } from "../../desktop/desktopBridgeClient";
import type { DesktopInstalledAppsData } from "../../desktop/desktopBridgeTypes";
import { DESKTOP_APP_RESOURCES, throwAsDesktopToolError } from "../../desktop/desktopToolShared";
import type { ToolDefinition } from "../toolTypes";

export type DesktopListInstalledApplicationsToolInput = Record<string, never>;
export type DesktopListInstalledApplicationsToolOutput = DesktopInstalledAppsData;

export const desktopListInstalledApplicationsTool: ToolDefinition<
  DesktopListInstalledApplicationsToolInput,
  DesktopListInstalledApplicationsToolOutput
> = {
  name: "desktop.listInstalledApplications",
  description:
    "只读列出本机开始菜单中已安装的应用（名称 + 快捷方式路径），上限 200 条。打开应用前可先用本工具确认名称是否唯一；不执行任何应用。",
  version: "1.0.0",
  riskLevel: "L0",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    properties: {}
  },
  outputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["apps", "count", "scannedAt"],
    properties: {
      apps: {
        type: "array",
        maxItems: 200,
        items: {
          type: "object",
          additionalProperties: false,
          required: ["name", "lnkPath"],
          properties: {
            name: { type: "string" },
            lnkPath: { type: "string" }
          }
        }
      },
      count: { type: "number", minimum: 0 },
      scannedAt: { type: "number" }
    }
  },
  requiredResources: DESKTOP_APP_RESOURCES,
  permissions: ["tool.desktop.listInstalledApplications"],
  timeoutMs: 10_000,
  cancellable: true,
  idempotency: "safe",
  auditPolicy: { logInputSummary: true, logOutputSummary: true },
  enabled: true,
  maxRetries: 0,
  async execute(_input, context) {
    try {
      return await listInstalledApplications(context.signal);
    } catch (error) {
      throwAsDesktopToolError(error);
    }
  }
};

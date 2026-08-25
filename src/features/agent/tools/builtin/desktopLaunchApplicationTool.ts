// L2（普通）/ L1（高权限模式）：按名称启动开始菜单中的已安装应用。

import { launchApplication } from "../../desktop/desktopBridgeClient";
import type { DesktopLaunchAppData } from "../../desktop/desktopBridgeTypes";
import { DESKTOP_APP_RESOURCES, throwAsDesktopToolError } from "../../desktop/desktopToolShared";
import type { ToolDefinition } from "../toolTypes";

export type DesktopLaunchApplicationToolInput = {
  name: string;
};

export type DesktopLaunchApplicationToolOutput = DesktopLaunchAppData;

export const desktopLaunchApplicationTool: ToolDefinition<
  DesktopLaunchApplicationToolInput,
  DesktopLaunchApplicationToolOutput
> = {
  name: "desktop.launchApplication",
  description:
    "按名称启动本机已安装的应用（仅限开始菜单快捷方式，通过 explorer 执行 .lnk，不接收任意路径或命令）。名称需精确或唯一包含匹配；多候选时返回候选列表让用户澄清；未找到时返回 APP_NOT_FOUND。高权限模式下确认级别自动降低，但敏感文件读取等红线保持。",
  version: "1.0.0",
  riskLevel: "L2",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["name"],
    properties: {
      name: {
        type: "string",
        minLength: 1,
        maxLength: 120,
        description: "应用名（开始菜单显示名，如 微信、Chrome、Visual Studio Code）"
      }
    }
  },
  outputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["name", "lnkPath", "launchedAt"],
    properties: {
      name: { type: "string" },
      lnkPath: { type: "string" },
      launchedAt: { type: "number" }
    }
  },
  requiredResources: DESKTOP_APP_RESOURCES,
  permissions: ["tool.desktop.launchApplication"],
  timeoutMs: 15_000,
  cancellable: true,
  idempotency: "unsafe",
  auditPolicy: { logInputSummary: true, logOutputSummary: true },
  enabled: true,
  maxRetries: 0,
  async execute(input, context) {
    try {
      return await launchApplication({ name: input.name.trim() }, context.signal);
    } catch (error) {
      throwAsDesktopToolError(error);
    }
  }
};

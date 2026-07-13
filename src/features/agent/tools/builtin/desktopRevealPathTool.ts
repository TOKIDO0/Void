// L2：在系统资源管理器中安全展示允许根内的路径（不执行目标文件）。

import { revealPath } from "../../desktop/desktopBridgeClient";
import type { DesktopRevealPathData } from "../../desktop/desktopBridgeTypes";
import {
  DESKTOP_REVEAL_RESOURCES,
  throwAsDesktopToolError
} from "../../desktop/desktopToolShared";
import type { ToolDefinition } from "../toolTypes";

export type DesktopRevealPathToolInput = {
  path: string;
};

export type DesktopRevealPathToolOutput = DesktopRevealPathData;

export const desktopRevealPathTool: ToolDefinition<
  DesktopRevealPathToolInput,
  DesktopRevealPathToolOutput
> = {
  name: "desktop.revealPath",
  description:
    "在 Windows 资源管理器中展示允许根内的已存在路径：目录直接打开，文件选中显示。绝不执行目标文件。下载 place+verify 成功后，若用户要看落盘位置，用 path=finalPath（或所在目录）调用本工具；未落盘成功前不要调用。",
  version: "1.0.0",
  riskLevel: "L2",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["path"],
    properties: {
      path: {
        type: "string",
        minLength: 1,
        maxLength: 1000,
        description: "要展示的绝对路径（必须在允许根内且已存在）"
      }
    }
  },
  outputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["revealedPath", "openMode", "revealedAt"],
    properties: {
      revealedPath: { type: "string" },
      openMode: { type: "string", enum: ["open", "select"] },
      revealedAt: { type: "number" }
    }
  },
  requiredResources: DESKTOP_REVEAL_RESOURCES,
  permissions: ["tool.desktop.revealPath"],
  timeoutMs: 15_000,
  cancellable: true,
  idempotency: "safe",
  auditPolicy: { logInputSummary: true, logOutputSummary: true },
  enabled: true,
  maxRetries: 0,
  async execute(input, context) {
    try {
      return await revealPath({ path: input.path.trim() }, context.signal);
    } catch (error) {
      throwAsDesktopToolError(error);
    }
  }
};

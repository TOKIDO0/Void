// L0：读取系统剪贴板文本（只读）。

import { clipboardRead } from "../../desktop/desktopBridgeClient";
import type { ClipboardReadData } from "../../desktop/desktopBridgeTypes";
import {
  DESKTOP_CLIPBOARD_RESOURCES,
  throwAsDesktopToolError
} from "../../desktop/desktopToolShared";
import type { ToolDefinition } from "../toolTypes";

export type ClipboardReadToolInput = Record<string, never>;

export type ClipboardReadToolOutput = ClipboardReadData;

export const clipboardReadTool: ToolDefinition<
  ClipboardReadToolInput,
  ClipboardReadToolOutput
> = {
  name: "clipboard.read",
  description:
    "读取本机系统剪贴板中的文本内容。返回 text/length/empty/truncated。只读；超长会截断并标记 truncated。不要假设剪贴板里一定有内容。用户要从剪贴板链接下载时，先调本工具；再按主机分流：B 站视频页用 file.downloadMediaPage，文件直链用 file.downloadToTemp，非 URL/未支持主机则停止并说明。",
  version: "1.0.0",
  riskLevel: "L0",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    properties: {}
  },
  outputSchema: {
    type: "object",
    required: ["text", "length", "empty", "truncated", "readAt"],
    properties: {
      text: { type: "string" },
      length: { type: "number" },
      empty: { type: "boolean" },
      truncated: { type: "boolean" },
      readAt: { type: "number" }
    }
  },
  requiredResources: DESKTOP_CLIPBOARD_RESOURCES,
  permissions: ["tool.clipboard.read"],
  timeoutMs: 15_000,
  cancellable: true,
  idempotency: "safe",
  auditPolicy: {
    logInputSummary: true,
    logOutputSummary: true,
    // 剪贴板可能含敏感信息，输出摘要侧做截断由执行器处理；仍标记敏感键
    redactOutputKeys: ["token", "password", "cookie"]
  },
  enabled: true,
  maxRetries: 0,
  async execute(_input, context) {
    try {
      return await clipboardRead(context.signal);
    } catch (error) {
      throwAsDesktopToolError(error);
    }
  }
};

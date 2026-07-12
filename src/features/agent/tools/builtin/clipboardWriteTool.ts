// L2：写入系统剪贴板文本（需用户确认）。

import { clipboardWrite } from "../../desktop/desktopBridgeClient";
import type { ClipboardWriteData } from "../../desktop/desktopBridgeTypes";
import {
  DESKTOP_CLIPBOARD_RESOURCES,
  throwAsDesktopToolError
} from "../../desktop/desktopToolShared";
import type { ToolDefinition } from "../toolTypes";

/** 与 sidecar 写入上限对齐（字符） */
const CLIPBOARD_WRITE_MAX_CHARS = 20_000;

export type ClipboardWriteToolInput = {
  text: string;
};

export type ClipboardWriteToolOutput = ClipboardWriteData;

export const clipboardWriteTool: ToolDefinition<
  ClipboardWriteToolInput,
  ClipboardWriteToolOutput
> = {
  name: "clipboard.write",
  description:
    "将文本写入本机系统剪贴板（覆盖原有文本内容）。长度上限 20000 字符；超长拒绝。会请求用户确认（L2）。不要写入密码等敏感凭证。",
  version: "1.0.0",
  riskLevel: "L2",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["text"],
    properties: {
      text: {
        type: "string",
        maxLength: CLIPBOARD_WRITE_MAX_CHARS,
        description: "要写入剪贴板的文本，最长 20000 字符"
      }
    }
  },
  outputSchema: {
    type: "object",
    required: ["length", "writtenAt"],
    properties: {
      length: { type: "number" },
      writtenAt: { type: "number" }
    }
  },
  requiredResources: DESKTOP_CLIPBOARD_RESOURCES,
  permissions: ["tool.clipboard.write"],
  timeoutMs: 15_000,
  cancellable: true,
  idempotency: "unsafe",
  auditPolicy: {
    logInputSummary: true,
    logOutputSummary: true,
    redactInputKeys: ["password", "token", "cookie"],
    redactOutputKeys: ["password", "token", "cookie"]
  },
  enabled: true,
  maxRetries: 0,
  async execute(input, context) {
    if (typeof input.text !== "string") {
      throwAsDesktopToolError(
        Object.assign(new Error("text 必须是字符串"), {
          desktopCode: "INVALID_REQUEST"
        })
      );
    }
    if (input.text.length > CLIPBOARD_WRITE_MAX_CHARS) {
      throwAsDesktopToolError(
        Object.assign(
          new Error(
            `剪贴板写入不能超过 ${CLIPBOARD_WRITE_MAX_CHARS} 字符（当前 ${input.text.length}）`
          ),
          {
            desktopCode: "TOO_LARGE",
            details: {
              maxChars: CLIPBOARD_WRITE_MAX_CHARS,
              length: input.text.length
            }
          }
        )
      );
    }
    try {
      return await clipboardWrite({ text: input.text }, context.signal);
    } catch (error) {
      throwAsDesktopToolError(error);
    }
  }
};

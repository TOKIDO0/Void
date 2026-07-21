// L1：用系统默认/常用浏览器打开 URL，让用户真正看见页面。
// 与 browser.open（Playwright 自动化窗）分离。

import { browserRevealInSystemBrowser } from "../../browser/browserBridgeClient";
import type { BrowserRevealInSystemBrowserData } from "../../browser/browserBridgeTypes";
import {
  BROWSER_STATIC_RESOURCES,
  resolveTaskIdFromInput,
  throwAsToolError
} from "../../browser/browserToolShared";
import type { ToolDefinition } from "../toolTypes";

export type BrowserRevealInSystemBrowserToolInput = {
  url: string;
  titleHint?: string;
  taskId?: string;
};

export type BrowserRevealInSystemBrowserToolOutput = BrowserRevealInSystemBrowserData;

export const browserRevealInSystemBrowserTool: ToolDefinition<
  BrowserRevealInSystemBrowserToolInput,
  BrowserRevealInSystemBrowserToolOutput
> = {
  name: "browser.revealInSystemBrowser",
  description:
    "用用户系统默认浏览器（Chrome/Edge 等常用浏览器）打开指定 URL，让用户在自己的浏览器里看到页面。用户说「打开网页 / 帮我打开某站 / 在浏览器里看 / 打开给我看」时优先用本工具，而不是只开 Playwright 自动化窗。不要假装已打开。",
  version: "1.0.0",
  riskLevel: "L1",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["url"],
    properties: {
      url: {
        type: "string",
        minLength: 8,
        maxLength: 2000,
        description: "要在系统浏览器中打开的 http(s) 地址"
      },
      titleHint: {
        type: "string",
        maxLength: 300,
        description: "可选：页面标题提示，用于向用户汇报"
      },
      taskId: {
        type: "string",
        minLength: 1,
        maxLength: 120
      }
    }
  },
  outputSchema: {
    type: "object",
    required: ["taskId", "openedUrl", "openMode", "message"],
    properties: {
      taskId: { type: "string" },
      openedUrl: { type: "string" },
      titleHint: { type: "string" },
      openMode: { type: "string" },
      message: { type: "string" }
    }
  },
  requiredResources: BROWSER_STATIC_RESOURCES,
  permissions: ["tool.browser.reveal"],
  timeoutMs: 20_000,
  cancellable: true,
  idempotency: "safe",
  auditPolicy: {
    logInputSummary: true,
    logOutputSummary: true,
    redactInputKeys: ["cookie", "password", "token"],
    redactOutputKeys: ["cookie", "password", "token"]
  },
  enabled: true,
  maxRetries: 0,
  async execute(input, context) {
    const taskId = resolveTaskIdFromInput(input, context);
    try {
      return await browserRevealInSystemBrowser(
        {
          taskId,
          url: input.url.trim(),
          titleHint: input.titleHint?.trim()
        },
        context.signal
      );
    } catch (error) {
      throwAsToolError(error);
    }
  }
};

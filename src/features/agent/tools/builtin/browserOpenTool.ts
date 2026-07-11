// L0 只读：打开指定公开网页（独立任务浏览器上下文）。

import {
  browserOpen,
  ensureBrowserSession
} from "../../browser/browserBridgeClient";
import type { BrowserOpenData } from "../../browser/browserBridgeTypes";
import {
  BROWSER_STATIC_RESOURCES,
  resolveTaskIdFromInput,
  throwAsToolError
} from "../../browser/browserToolShared";
import type { ToolDefinition } from "../toolTypes";

export type BrowserOpenToolInput = {
  url: string;
  /** 可选；缺省使用当前任务 id */
  taskId?: string;
  pageId?: string;
};

export type BrowserOpenToolOutput = BrowserOpenData;

export const browserOpenTool: ToolDefinition<
  BrowserOpenToolInput,
  BrowserOpenToolOutput
> = {
  name: "browser.open",
  description:
    "在任务独立的浏览器上下文中打开指定 http(s) 公开页面，返回最终 URL 与标题。只读，不下载。",
  version: "1.0.0",
  riskLevel: "L0",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["url"],
    properties: {
      url: {
        type: "string",
        minLength: 8,
        maxLength: 2000,
        description: "要打开的 http 或 https 地址"
      },
      taskId: {
        type: "string",
        minLength: 1,
        maxLength: 120,
        description: "任务 id；缺省由运行时注入"
      },
      pageId: {
        type: "string",
        minLength: 1,
        maxLength: 120,
        description: "可选：在已有标签页内导航"
      }
    }
  },
  outputSchema: {
    type: "object",
    required: ["taskId", "pageId", "url", "title", "finalUrl"],
    properties: {
      taskId: { type: "string" },
      pageId: { type: "string" },
      url: { type: "string" },
      title: { type: "string" },
      finalUrl: { type: "string" }
    }
  },
  requiredResources: BROWSER_STATIC_RESOURCES,
  permissions: ["tool.browser.open"],
  timeoutMs: 45_000,
  cancellable: true,
  idempotency: "safe",
  auditPolicy: {
    logInputSummary: true,
    logOutputSummary: true,
    redactInputKeys: ["cookie", "password", "token", "authorization"],
    redactOutputKeys: ["cookie", "password", "token"]
  },
  enabled: true,
  maxRetries: 1,
  async execute(input, context) {
    const taskId = resolveTaskIdFromInput(input, context);
    try {
      await ensureBrowserSession(taskId, context.signal);
      return await browserOpen(
        {
          taskId,
          url: input.url.trim(),
          pageId: input.pageId
        },
        context.signal
      );
    } catch (error) {
      throwAsToolError(error);
    }
  }
};

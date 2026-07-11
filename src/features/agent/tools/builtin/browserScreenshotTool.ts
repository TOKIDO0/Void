// L0 只读：对当前页面截图，保存到系统临时目录并返回路径。

import {
  browserScreenshot,
  ensureBrowserSession
} from "../../browser/browserBridgeClient";
import type { BrowserScreenshotData } from "../../browser/browserBridgeTypes";
import {
  BROWSER_STATIC_RESOURCES,
  resolveTaskIdFromInput,
  throwAsToolError
} from "../../browser/browserToolShared";
import type { ToolDefinition } from "../toolTypes";

export type BrowserScreenshotToolInput = {
  taskId?: string;
  pageId?: string;
  fullPage?: boolean;
};

export type BrowserScreenshotToolOutput = BrowserScreenshotData;

export const browserScreenshotTool: ToolDefinition<
  BrowserScreenshotToolInput,
  BrowserScreenshotToolOutput
> = {
  name: "browser.screenshot",
  description:
    "对任务浏览器上下文中的当前页面截图，保存到本地临时目录并返回路径与页面元信息。只读。",
  version: "1.0.0",
  riskLevel: "L0",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      taskId: {
        type: "string",
        minLength: 1,
        maxLength: 120
      },
      pageId: {
        type: "string",
        minLength: 1,
        maxLength: 120
      },
      fullPage: {
        type: "boolean",
        description: "是否整页截图；默认仅可视区域"
      }
    }
  },
  outputSchema: {
    type: "object",
    required: ["taskId", "pageId", "pageUrl", "pageTitle", "path", "width", "height", "fullPage"],
    properties: {
      taskId: { type: "string" },
      pageId: { type: "string" },
      pageUrl: { type: "string" },
      pageTitle: { type: "string" },
      path: { type: "string" },
      width: { type: "number" },
      height: { type: "number" },
      fullPage: { type: "boolean" }
    }
  },
  requiredResources: BROWSER_STATIC_RESOURCES,
  permissions: ["tool.browser.screenshot"],
  timeoutMs: 30_000,
  cancellable: true,
  idempotency: "safe",
  auditPolicy: {
    logInputSummary: true,
    // 截图路径可记；不记录图像内容
    logOutputSummary: true,
    redactInputKeys: ["cookie", "password", "token"],
    redactOutputKeys: ["cookie", "password", "token"]
  },
  enabled: true,
  maxRetries: 0,
  async execute(input, context) {
    const taskId = resolveTaskIdFromInput(input, context);
    try {
      await ensureBrowserSession(taskId, context.signal);
      return await browserScreenshot(
        {
          taskId,
          pageId: input.pageId,
          fullPage: input.fullPage
        },
        context.signal
      );
    } catch (error) {
      throwAsToolError(error);
    }
  }
};

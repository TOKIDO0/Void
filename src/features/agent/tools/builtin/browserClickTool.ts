// L1：在自动化窗口内点击元素（Playwright Locator，非坐标）。

import {
  browserClick,
  ensureBrowserSession
} from "../../browser/browserBridgeClient";
import type { BrowserClickData } from "../../browser/browserBridgeTypes";
import {
  BROWSER_STATIC_RESOURCES,
  resolveTaskIdFromInput,
  throwAsToolError
} from "../../browser/browserToolShared";
import type { ToolDefinition } from "../toolTypes";

export type BrowserClickToolInput = {
  selector: string;
  taskId?: string;
  pageId?: string;
  button?: "left" | "right" | "middle";
  clickCount?: number;
};

export type BrowserClickToolOutput = BrowserClickData;

export const browserClickTool: ToolDefinition<
  BrowserClickToolInput,
  BrowserClickToolOutput
> = {
  name: "browser.click",
  description:
    "在当前任务自动化窗口内，用 Playwright 选择器点击唯一匹配的元素（非坐标）。优先使用 browser.extract 返回的 suggestedSelector；无则先 extract 或 waitFor 再点。0 匹配或多匹配会失败，禁止空猜 selector、禁止假装已点击。",
  version: "1.0.0",
  riskLevel: "L1",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["selector"],
    properties: {
      selector: {
        type: "string",
        minLength: 1,
        maxLength: 500,
        description: "Playwright 选择器，须唯一匹配一个可点元素"
      },
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
      button: {
        type: "string",
        description: "left | right | middle，默认 left"
      },
      clickCount: {
        type: "number",
        description: "点击次数 1–3，默认 1"
      }
    }
  },
  outputSchema: {
    type: "object",
    required: ["taskId", "pageId", "selector", "pageUrl", "pageTitle", "button", "clickCount"],
    properties: {
      taskId: { type: "string" },
      pageId: { type: "string" },
      selector: { type: "string" },
      pageUrl: { type: "string" },
      pageTitle: { type: "string" },
      button: { type: "string" },
      clickCount: { type: "number" }
    }
  },
  requiredResources: BROWSER_STATIC_RESOURCES,
  permissions: ["tool.browser.click"],
  timeoutMs: 30_000,
  cancellable: true,
  idempotency: "unsafe",
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
      await ensureBrowserSession(taskId, context.signal);
      return await browserClick(
        {
          taskId,
          pageId: input.pageId,
          selector: input.selector,
          button: input.button,
          clickCount: input.clickCount
        },
        context.signal
      );
    } catch (error) {
      throwAsToolError(error);
    }
  }
};

// L0：等待页面元素到达指定状态（Playwright locator.waitFor）。

import {
  browserWaitFor,
  ensureBrowserSession
} from "../../browser/browserBridgeClient";
import type { BrowserWaitForData } from "../../browser/browserBridgeTypes";
import {
  BROWSER_STATIC_RESOURCES,
  resolveTaskIdFromInput,
  throwAsToolError
} from "../../browser/browserToolShared";
import type { ToolDefinition } from "../toolTypes";

export type BrowserWaitForToolInput = {
  selector: string;
  taskId?: string;
  pageId?: string;
  state?: "attached" | "detached" | "visible" | "hidden";
  timeoutMs?: number;
};

export type BrowserWaitForToolOutput = BrowserWaitForData;

export const browserWaitForTool: ToolDefinition<
  BrowserWaitForToolInput,
  BrowserWaitForToolOutput
> = {
  name: "browser.waitFor",
  description:
    "在自动化窗口中等待选择器到达状态（默认 visible）。用于导航后页面加载完成再 click/read。超时会失败。",
  version: "1.0.0",
  riskLevel: "L0",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["selector"],
    properties: {
      selector: {
        type: "string",
        minLength: 1,
        maxLength: 500
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
      state: {
        type: "string",
        description: "attached | detached | visible | hidden，默认 visible"
      },
      timeoutMs: {
        type: "number",
        description: "超时毫秒，默认 15000，上限 60000"
      }
    }
  },
  outputSchema: {
    type: "object",
    required: ["taskId", "pageId", "selector", "state", "pageUrl", "pageTitle", "waitedMs"],
    properties: {
      taskId: { type: "string" },
      pageId: { type: "string" },
      selector: { type: "string" },
      state: { type: "string" },
      pageUrl: { type: "string" },
      pageTitle: { type: "string" },
      waitedMs: { type: "number" }
    }
  },
  requiredResources: BROWSER_STATIC_RESOURCES,
  permissions: ["tool.browser.wait"],
  timeoutMs: 65_000,
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
      await ensureBrowserSession(taskId, context.signal);
      return await browserWaitFor(
        {
          taskId,
          pageId: input.pageId,
          selector: input.selector,
          state: input.state,
          timeoutMs: input.timeoutMs
        },
        context.signal
      );
    } catch (error) {
      throwAsToolError(error);
    }
  }
};

// L0：列出当前任务自动化窗口内的标签页（pageId/url/title/是否活动）。

import {
  browserTabs,
  ensureBrowserSession
} from "../../browser/browserBridgeClient";
import type { BrowserTabsData } from "../../browser/browserBridgeTypes";
import {
  BROWSER_STATIC_RESOURCES,
  resolveTaskIdFromInput,
  throwAsToolError
} from "../../browser/browserToolShared";
import type { ToolDefinition } from "../toolTypes";

export type BrowserTabsToolInput = {
  taskId?: string;
};

export type BrowserTabsToolOutput = BrowserTabsData;

export const browserTabsTool: ToolDefinition<
  BrowserTabsToolInput,
  BrowserTabsToolOutput
> = {
  name: "browser.tabs",
  description:
    "列出当前任务 Playwright 自动化窗口内的全部标签页（pageId、url、title、是否活动）。多页场景下先 tabs 再 switchTab；无会话时返回空列表。只读。",
  version: "1.0.0",
  riskLevel: "L0",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      taskId: {
        type: "string",
        minLength: 1,
        maxLength: 120,
        description: "任务 id；缺省由运行时注入"
      }
    }
  },
  outputSchema: {
    type: "object",
    required: ["taskId", "tabs", "count"],
    properties: {
      taskId: { type: "string" },
      activePageId: { type: "string" },
      tabs: {
        type: "array",
        items: {
          type: "object",
          properties: {
            pageId: { type: "string" },
            url: { type: "string" },
            title: { type: "string" },
            active: { type: "boolean" }
          }
        }
      },
      count: { type: "number" }
    }
  },
  requiredResources: BROWSER_STATIC_RESOURCES,
  permissions: ["tool.browser.tabs"],
  timeoutMs: 15_000,
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
      // 无会话时 listTabs 也返回空列表；ensure 便于后续 open 同 task 复用
      await ensureBrowserSession(taskId, context.signal);
      return await browserTabs({ taskId }, context.signal);
    } catch (error) {
      throwAsToolError(error);
    }
  }
};

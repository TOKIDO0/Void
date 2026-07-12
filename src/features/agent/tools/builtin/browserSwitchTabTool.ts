// L0：切换当前任务自动化窗口的活动标签页。

import {
  browserSwitchTab,
  ensureBrowserSession
} from "../../browser/browserBridgeClient";
import type { BrowserSwitchTabData } from "../../browser/browserBridgeTypes";
import {
  BROWSER_STATIC_RESOURCES,
  resolveTaskIdFromInput,
  throwAsToolError
} from "../../browser/browserToolShared";
import type { ToolDefinition } from "../toolTypes";

export type BrowserSwitchTabToolInput = {
  pageId: string;
  taskId?: string;
};

export type BrowserSwitchTabToolOutput = BrowserSwitchTabData;

export const browserSwitchTabTool: ToolDefinition<
  BrowserSwitchTabToolInput,
  BrowserSwitchTabToolOutput
> = {
  name: "browser.switchTab",
  description:
    "将指定 pageId 设为当前任务的活动标签页；后续未显式传 pageId 的 browser 动作走该页。pageId 来自 browser.tabs 或 browser.open 返回值。",
  version: "1.0.0",
  riskLevel: "L0",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["pageId"],
    properties: {
      pageId: {
        type: "string",
        minLength: 1,
        maxLength: 120,
        description: "要切换到的标签页 id（来自 tabs/open）"
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
    required: ["taskId", "pageId", "url", "title", "broughtToFront"],
    properties: {
      taskId: { type: "string" },
      pageId: { type: "string" },
      url: { type: "string" },
      title: { type: "string" },
      previousPageId: { type: "string" },
      broughtToFront: { type: "boolean" }
    }
  },
  requiredResources: BROWSER_STATIC_RESOURCES,
  permissions: ["tool.browser.switchTab"],
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
      await ensureBrowserSession(taskId, context.signal);
      return await browserSwitchTab(
        {
          taskId,
          pageId: input.pageId.trim()
        },
        context.signal
      );
    } catch (error) {
      throwAsToolError(error);
    }
  }
};

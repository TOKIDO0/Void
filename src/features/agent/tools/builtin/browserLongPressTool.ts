// L1：在自动化窗口内长按元素（mousedown 按住 holdMs 后 mouseup）。
// 主要用于 B 站三连；定位与 browser.click 相同，禁止坐标乱点。

import {
  browserLongPress,
  ensureBrowserSession
} from "../../browser/browserBridgeClient";
import type { BrowserLongPressData } from "../../browser/browserBridgeTypes";
import {
  BROWSER_STATIC_RESOURCES,
  resolveTaskIdFromInput,
  throwAsToolError
} from "../../browser/browserToolShared";
import type { ToolDefinition } from "../toolTypes";

export type BrowserLongPressToolInput = {
  selector?: string;
  role?: string;
  name?: string;
  taskId?: string;
  pageId?: string;
  button?: "left" | "right" | "middle";
  /** 按住毫秒数；默认 3000（B 站三连） */
  holdMs?: number;
};

export type BrowserLongPressToolOutput = BrowserLongPressData;

export const browserLongPressTool: ToolDefinition<
  BrowserLongPressToolInput,
  BrowserLongPressToolOutput
> = {
  name: "browser.longPress",
  description:
    "在当前任务自动化窗口内对唯一匹配元素长按 holdMs 毫秒（默认 3000）。用于 B 站「三连」（长按点赞约 3 秒）；定位二选一：selector 或 role+name。0/多匹配失败。禁止假装已三连；未登录或点不到必须如实说明。",
  version: "1.0.0",
  riskLevel: "L1",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      selector: {
        type: "string",
        minLength: 1,
        maxLength: 500,
        description: "Playwright 选择器；与 role+name 二选一"
      },
      role: {
        type: "string",
        minLength: 1,
        maxLength: 80,
        description: "ARIA 角色；须与 name 成对"
      },
      name: {
        type: "string",
        minLength: 1,
        maxLength: 200,
        description: "可访问名 exact；须与 role 成对"
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
      holdMs: {
        type: "number",
        description: "按住毫秒 500–8000，默认 3000"
      }
    }
  },
  outputSchema: {
    type: "object",
    required: ["taskId", "pageId", "selector", "pageUrl", "pageTitle", "button", "holdMs"],
    properties: {
      taskId: { type: "string" },
      pageId: { type: "string" },
      selector: { type: "string" },
      role: { type: "string" },
      name: { type: "string" },
      pageUrl: { type: "string" },
      pageTitle: { type: "string" },
      button: { type: "string" },
      holdMs: { type: "number" }
    }
  },
  requiredResources: BROWSER_STATIC_RESOURCES,
  permissions: ["tool.browser.longPress"],
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
    const selector = typeof input.selector === "string" ? input.selector.trim() : "";
    const role = typeof input.role === "string" ? input.role.trim() : "";
    const name = typeof input.name === "string" ? input.name.trim() : "";
    if (!selector && !(role && name)) {
      throwAsToolError(
        Object.assign(
          new Error("缺少定位目标：请提供 selector，或同时提供 role 与 name"),
          { browserCode: "INVALID_REQUEST" }
        )
      );
    }
    try {
      await ensureBrowserSession(taskId, context.signal);
      return await browserLongPress(
        {
          taskId,
          pageId: input.pageId,
          selector: selector || undefined,
          role: role || undefined,
          name: name || undefined,
          button: input.button,
          holdMs: input.holdMs
        },
        context.signal
      );
    } catch (error) {
      throwAsToolError(error);
    }
  }
};

// L1：在自动化窗口内点击元素（Playwright Locator，非坐标）。
// Q1：支持 selector 或 role+name（getByRole）二选一定位。

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
  /** CSS/Playwright 选择器；与 role+name 二选一（优先 role+name 若同时给） */
  selector?: string;
  /** ARIA 角色，须与 name 成对使用，走 Playwright getByRole */
  role?: string;
  /** 可访问名（exact），须与 role 成对使用 */
  name?: string;
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
    "在当前任务自动化窗口内点击唯一匹配的元素（非坐标）。定位二选一：① selector（Playwright/CSS，优先 extract 的 suggestedSelector）；② role+name（无障碍 getByRole，适合按钮/链接等有 aria 语义的元素）。0 匹配或多匹配会失败；禁止空猜、禁止假装已点击。",
  version: "1.1.0",
  riskLevel: "L1",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    // selector 与 role+name 二选一，不能在 JSON Schema required 里硬写 selector
    properties: {
      selector: {
        type: "string",
        minLength: 1,
        maxLength: 500,
        description: "Playwright 选择器；与 role+name 二选一，须唯一匹配"
      },
      role: {
        type: "string",
        minLength: 1,
        maxLength: 80,
        description: "ARIA 角色，如 button/link/textbox；须与 name 成对"
      },
      name: {
        type: "string",
        minLength: 1,
        maxLength: 200,
        description: "可访问名（exact 匹配），须与 role 成对"
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
      role: { type: "string" },
      name: { type: "string" },
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
    const selector = typeof input.selector === "string" ? input.selector.trim() : "";
    const role = typeof input.role === "string" ? input.role.trim() : "";
    const name = typeof input.name === "string" ? input.name.trim() : "";
    // 工具入口门禁：至少 selector，或完整 role+name
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
      return await browserClick(
        {
          taskId,
          pageId: input.pageId,
          selector: selector || undefined,
          role: role || undefined,
          name: name || undefined,
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

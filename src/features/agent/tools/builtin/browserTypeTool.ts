// L1：在自动化窗口内向输入框填入文本（Playwright fill / pressSequentially）。
// Q1：支持 selector 或 role+name（getByRole）二选一定位。

import {
  browserType,
  ensureBrowserSession
} from "../../browser/browserBridgeClient";
import type { BrowserTypeData } from "../../browser/browserBridgeTypes";
import {
  BROWSER_STATIC_RESOURCES,
  resolveTaskIdFromInput,
  throwAsToolError
} from "../../browser/browserToolShared";
import type { ToolDefinition } from "../toolTypes";

export type BrowserTypeToolInput = {
  /** CSS/Playwright 选择器；与 role+name 二选一 */
  selector?: string;
  /** ARIA 角色（如 textbox/searchbox），须与 name 成对 */
  role?: string;
  /** 可访问名（exact），须与 role 成对 */
  name?: string;
  text: string;
  taskId?: string;
  pageId?: string;
  /** 默认 true：fill 清空后写入；false 则逐字追加 */
  clear?: boolean;
  /** 输入后是否按 Enter 提交 */
  submit?: boolean;
};

export type BrowserTypeToolOutput = BrowserTypeData;

export const browserTypeTool: ToolDefinition<
  BrowserTypeToolInput,
  BrowserTypeToolOutput
> = {
  name: "browser.type",
  description:
    "向自动化窗口内唯一匹配的输入框写入文本。定位二选一：① selector（优先 extract 的 suggestedSelector）；② role+name（如 role=textbox name=搜索）。默认清空后 fill，submit=true 再按回车。不要用于密码等敏感凭证。",
  version: "1.1.0",
  riskLevel: "L1",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["text"],
    properties: {
      selector: {
        type: "string",
        minLength: 1,
        maxLength: 500,
        description: "输入框 Playwright 选择器；与 role+name 二选一，须唯一"
      },
      role: {
        type: "string",
        minLength: 1,
        maxLength: 80,
        description: "ARIA 角色，如 textbox/searchbox；须与 name 成对"
      },
      name: {
        type: "string",
        minLength: 1,
        maxLength: 200,
        description: "可访问名（exact），须与 role 成对"
      },
      text: {
        type: "string",
        maxLength: 4000,
        description: "要输入的文本"
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
      clear: {
        type: "boolean",
        description: "是否先清空，默认 true"
      },
      submit: {
        type: "boolean",
        description: "输入后是否按 Enter"
      }
    }
  },
  outputSchema: {
    type: "object",
    required: [
      "taskId",
      "pageId",
      "selector",
      "pageUrl",
      "pageTitle",
      "typedLength",
      "cleared",
      "submitted"
    ],
    properties: {
      taskId: { type: "string" },
      pageId: { type: "string" },
      selector: { type: "string" },
      role: { type: "string" },
      name: { type: "string" },
      pageUrl: { type: "string" },
      pageTitle: { type: "string" },
      typedLength: { type: "number" },
      cleared: { type: "boolean" },
      submitted: { type: "boolean" }
    }
  },
  requiredResources: BROWSER_STATIC_RESOURCES,
  permissions: ["tool.browser.type"],
  timeoutMs: 30_000,
  cancellable: true,
  idempotency: "unsafe",
  auditPolicy: {
    logInputSummary: true,
    logOutputSummary: true,
    redactInputKeys: ["cookie", "password", "token", "text"],
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
      return await browserType(
        {
          taskId,
          pageId: input.pageId,
          selector: selector || undefined,
          role: role || undefined,
          name: name || undefined,
          text: input.text,
          clear: input.clear,
          submit: input.submit
        },
        context.signal
      );
    } catch (error) {
      throwAsToolError(error);
    }
  }
};

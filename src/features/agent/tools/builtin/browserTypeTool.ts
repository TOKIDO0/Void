// L1：在自动化窗口内向输入框填入文本（Playwright fill / pressSequentially）。

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
  selector: string;
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
    "向自动化窗口内唯一匹配的输入框写入文本。selector 须唯一（优先 extract 的 suggestedSelector）；默认清空后 fill，submit=true 再按回车。不要用于密码等敏感凭证。",
  version: "1.0.0",
  riskLevel: "L1",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["selector", "text"],
    properties: {
      selector: {
        type: "string",
        minLength: 1,
        maxLength: 500,
        description: "输入框的 Playwright 选择器，须唯一"
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
    try {
      await ensureBrowserSession(taskId, context.signal);
      return await browserType(
        {
          taskId,
          pageId: input.pageId,
          selector: input.selector,
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

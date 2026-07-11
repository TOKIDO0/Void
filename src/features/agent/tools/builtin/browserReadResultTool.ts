// L0 只读：从当前搜索结果页读取结构化条目（标题/URL/摘要）。

import {
  browserReadResult,
  ensureBrowserSession
} from "../../browser/browserBridgeClient";
import type { BrowserReadResultData } from "../../browser/browserBridgeTypes";
import {
  BROWSER_STATIC_RESOURCES,
  resolveTaskIdFromInput,
  throwAsToolError
} from "../../browser/browserToolShared";
import type { ToolDefinition } from "../toolTypes";

export type BrowserReadResultToolInput = {
  taskId?: string;
  pageId?: string;
  limit?: number;
};

export type BrowserReadResultToolOutput = BrowserReadResultData;

export const browserReadResultTool: ToolDefinition<
  BrowserReadResultToolInput,
  BrowserReadResultToolOutput
> = {
  name: "browser.readResult",
  description:
    "读取当前（或指定）浏览器页面上的结构化搜索结果列表。通常接在 browser.search 之后。只读。",
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
      limit: {
        type: "number",
        minimum: 1,
        maximum: 20
      }
    }
  },
  outputSchema: {
    type: "object",
    required: ["taskId", "pageId", "pageUrl", "pageTitle", "results"],
    properties: {
      taskId: { type: "string" },
      pageId: { type: "string" },
      pageUrl: { type: "string" },
      pageTitle: { type: "string" },
      results: {
        type: "array",
        items: {
          type: "object",
          required: ["rank", "title", "url", "snippet"],
          properties: {
            rank: { type: "number" },
            title: { type: "string" },
            url: { type: "string" },
            snippet: { type: "string" },
            displayUrl: { type: "string" }
          }
        }
      }
    }
  },
  requiredResources: BROWSER_STATIC_RESOURCES,
  permissions: ["tool.browser.readResult"],
  timeoutMs: 30_000,
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
      return await browserReadResult(
        {
          taskId,
          pageId: input.pageId,
          limit: input.limit
        },
        context.signal
      );
    } catch (error) {
      throwAsToolError(error);
    }
  }
};

// L0 只读：在 DuckDuckGo HTML 搜索关键词，返回结构化结果列表。

import {
  browserSearch,
  ensureBrowserSession
} from "../../browser/browserBridgeClient";
import type { BrowserSearchData } from "../../browser/browserBridgeTypes";
import {
  BROWSER_STATIC_RESOURCES,
  resolveTaskIdFromInput,
  throwAsToolError
} from "../../browser/browserToolShared";
import type { ToolDefinition } from "../toolTypes";

export type BrowserSearchToolInput = {
  query: string;
  taskId?: string;
  /** 最多结果条数，默认 8，上限 20 */
  limit?: number;
};

export type BrowserSearchToolOutput = BrowserSearchData;

export const browserSearchTool: ToolDefinition<
  BrowserSearchToolInput,
  BrowserSearchToolOutput
> = {
  name: "browser.search",
  description:
    "使用公开搜索引擎（DuckDuckGo HTML）搜索关键词，在独立浏览器上下文打开结果页并返回标题/URL/摘要列表。只读。",
  version: "1.0.0",
  riskLevel: "L0",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["query"],
    properties: {
      query: {
        type: "string",
        minLength: 1,
        maxLength: 500,
        description: "搜索关键词"
      },
      taskId: {
        type: "string",
        minLength: 1,
        maxLength: 120
      },
      limit: {
        type: "number",
        minimum: 1,
        maximum: 20,
        description: "返回结果条数上限"
      }
    }
  },
  outputSchema: {
    type: "object",
    required: ["taskId", "pageId", "engine", "query", "resultPageUrl", "results"],
    properties: {
      taskId: { type: "string" },
      pageId: { type: "string" },
      engine: { type: "string" },
      query: { type: "string" },
      resultPageUrl: { type: "string" },
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
  permissions: ["tool.browser.search"],
  timeoutMs: 60_000,
  cancellable: true,
  idempotency: "safe",
  auditPolicy: {
    logInputSummary: true,
    logOutputSummary: true,
    redactInputKeys: ["cookie", "password", "token"],
    redactOutputKeys: ["cookie", "password", "token"]
  },
  enabled: true,
  maxRetries: 1,
  async execute(input, context) {
    const taskId = resolveTaskIdFromInput(input, context);
    try {
      await ensureBrowserSession(taskId, context.signal);
      return await browserSearch(
        {
          taskId,
          query: input.query.trim(),
          limit: input.limit
        },
        context.signal
      );
    } catch (error) {
      throwAsToolError(error);
    }
  }
};

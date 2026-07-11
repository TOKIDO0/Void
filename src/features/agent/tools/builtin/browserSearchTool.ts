// L0 只读：搜索关键词并返回结构化结果（DuckDuckGo 全网 / B 站站内）。

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
  /**
   * duckduckgo=全网 HTML 搜索；
   * bilibili=B 站站内视频搜索（找博主/最新视频时必须用这个）。
   */
  engine?: "duckduckgo" | "bilibili";
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
    "搜索并返回标题/URL/摘要列表。engine=duckduckgo 为全网搜索；找 B 站博主或视频时必须用 engine=bilibili。只读。打开后用户若要在自己常用浏览器里看，再调 browser.revealInSystemBrowser。",
  version: "1.1.0",
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
        description: "搜索关键词；B 站可写「博主名 最新」"
      },
      engine: {
        type: "string",
        enum: ["duckduckgo", "bilibili"],
        description: "搜索引擎：duckduckgo 或 bilibili"
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
      engine: {
        type: "string",
        enum: ["duckduckgo", "bilibili"]
      },
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
    const query = input.query.trim();
    // 模型漏传 engine 时：文案含 B 站/bilibili/UP主 等则自动走站内搜，避免全网空转
    const engine =
      input.engine === "bilibili" || input.engine === "duckduckgo"
        ? input.engine
        : shouldUseBilibiliEngine(query)
          ? "bilibili"
          : "duckduckgo";
    try {
      await ensureBrowserSession(taskId, context.signal);
      return await browserSearch(
        {
          taskId,
          query,
          engine,
          limit: input.limit
        },
        context.signal
      );
    } catch (error) {
      throwAsToolError(error);
    }
  }
};

function shouldUseBilibiliEngine(query: string) {
  return /bilibili|b站|哔哩|up主|av\d+|bv[\w]+/i.test(query);
}

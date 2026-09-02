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
   * bilibili=B 站站内视频搜索；
   * zhihu=知乎站内搜；douyin=抖音站内搜；xiaohongshu=小红书；weibo=微博。
   */
  engine?: "duckduckgo" | "bilibili" | "zhihu" | "douyin" | "xiaohongshu" | "weibo";
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
    "搜索并返回标题/URL/摘要列表。engine=duckduckgo 全网；bilibili=B 站视频、zhihu=知乎内容、douyin=抖音视频、xiaohongshu=小红书、weibo=微博。找对应站点内容时必须指定对应 engine。query 用具体人名/作品名/风格词。只读。打开后若要在系统浏览器查看再调 browser.revealInSystemBrowser.",
  version: "1.3.0",
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
        enum: ["duckduckgo", "bilibili", "zhihu", "douyin", "xiaohongshu", "weibo"],
        description: "搜索引擎：duckduckgo / bilibili / zhihu / douyin / xiaohongshu / weibo"
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
        enum: ["duckduckgo", "bilibili", "zhihu", "douyin", "xiaohongshu", "weibo"]
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
    const engine =
      input.engine === "bilibili"
      || input.engine === "duckduckgo"
      || input.engine === "zhihu"
      || input.engine === "douyin"
      || input.engine === "xiaohongshu"
      || input.engine === "weibo"
        ? input.engine
        : shouldInferEngine(query) ?? "duckduckgo";
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

function shouldInferEngine(query: string): "bilibili" | "zhihu" | "douyin" | "xiaohongshu" | "weibo" | undefined {
  if (/bilibili|b站|哔哩|up主|av\d+|bv[\w]+/i.test(query)) return "bilibili";
  if (/知乎|zhihu/i.test(query)) return "zhihu";
  if (/抖音|douyin/i.test(query)) return "douyin";
  if (/小红书|xiaohongshu/i.test(query)) return "xiaohongshu";
  if (/微博|weibo/i.test(query)) return "weibo";
  return undefined;
}

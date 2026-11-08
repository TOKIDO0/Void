import { webSearchViaBridge } from "../../web/webBridgeClient";
import { throwAsWebToolError } from "../../web/webToolShared";
import type { ToolDefinition } from "../toolTypes";

export type WebSearchToolInput = {
  query: string;
  limit?: number;
  /** general=通用；news=新闻（优先时效）；finance=财经。不传即 general，向后兼容。 */
  topic?: "general" | "news" | "finance";
  /** day/week/month/year：只在 topic=news/finance 或 Tavily 通道下生效。 */
  timeRange?: "day" | "week" | "month" | "year";
  /** basic=省额度默认；advanced=高精度 2 credits。 */
  searchDepth?: "basic" | "advanced";
};
export type WebSearchToolOutput = {
  engine: string;
  query: string;
  resultPageUrl: string;
  results: Array<{ rank: number; title: string; url: string; snippet: string; displayUrl?: string }>;
  searchedAt: number;
};

export const webSearchTool: ToolDefinition<WebSearchToolInput, WebSearchToolOutput> = {
  name: "web.search",
  description: "快轨全网搜索（有 Key 走 Tavily/Brave/Exa 云索引，无 Key 走 DuckDuckGo 快搜，秒级返回标题/链接/摘要）。新闻/榜单/热度类建议带 topic=news、timeRange=week、limit=8；先用中文查一次，结果不足再英文补一次，避免重复同一 query。只有遇到反爬/验证码或需要真实渲染时，才改调 browser.search 一次。",
  version: "1.1.0",
  riskLevel: "L0",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["query"],
    properties: {
      query: { type: "string", minLength: 1, maxLength: 500, description: "搜索关键词" },
      limit: { type: "number", minimum: 1, maximum: 20, description: "返回条数" },
      topic: { type: "string", enum: ["general", "news", "finance"], description: "新闻/财经场景透传给 Tavily" },
      timeRange: { type: "string", enum: ["day", "week", "month", "year"], description: "时效窗口，如一周新闻用 week" },
      searchDepth: { type: "string", enum: ["basic", "advanced"], description: "basic 省额度默认，advanced 高精度" }
    }
  },
  outputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["engine", "query", "resultPageUrl", "results", "searchedAt"],
    properties: {
      engine: { type: "string", enum: ["duckduckgo", "tavily", "brave", "exa", "cloud"] },
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
      },
      searchedAt: { type: "number" }
    }
  },
  requiredResources: [{ kind: "network", key: "web-search", mode: "shared" }],
  permissions: ["tool.web.search"],
  timeoutMs: 15000,
  cancellable: true,
  idempotency: "safe",
  auditPolicy: { logInputSummary: true, logOutputSummary: true },
  enabled: true,
  maxRetries: 1,
  async execute(input, context) {
    try {
      return await webSearchViaBridge(input.query, input.limit ?? 8, context.signal, {
        topic: input.topic,
        timeRange: input.timeRange,
        searchDepth: input.searchDepth
      });
    } catch (error) {
      throwAsWebToolError(error);
    }
  }
};

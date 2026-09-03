import { webSearchViaBridge } from "../../web/webBridgeClient";
import type { ToolDefinition } from "../toolTypes";

export type WebSearchToolInput = { query: string; limit?: number };
export type WebSearchToolOutput = {
  engine: string;
  query: string;
  resultPageUrl: string;
  results: Array<{ rank: number; title: string; url: string; snippet: string; displayUrl?: string }>;
  searchedAt: number;
};

export const webSearchTool: ToolDefinition<WebSearchToolInput, WebSearchToolOutput> = {
  name: "web.search",
  description: "快轨全网搜索（不经过浏览器，直接 fetch DuckDuckGo HTML，秒级返回标题/链接/摘要）。适合先搜再开、榜单类研究；需要登录态或要点赞时再用 browser.search/open。",
  version: "1.0.0",
  riskLevel: "L0",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["query"],
    properties: {
      query: { type: "string", minLength: 1, maxLength: 500, description: "搜索关键词" },
      limit: { type: "number", minimum: 1, maximum: 20, description: "返回条数" }
    }
  },
  outputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["engine", "query", "resultPageUrl", "results", "searchedAt"],
    properties: {
      engine: { type: "string", enum: ["duckduckgo"] },
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
    return webSearchViaBridge(input.query, input.limit ?? 8, context.signal);
  }
};

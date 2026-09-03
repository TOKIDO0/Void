import { webFetchViaBridge } from "../../web/webBridgeClient";
import type { ToolDefinition } from "../toolTypes";

export type WebFetchToolInput = { url: string };
export type WebFetchToolOutput = {
  url: string;
  finalUrl: string;
  contentType: string;
  status: number;
  text: string;
  truncated: boolean;
  fetchedAt: number;
};

export const webFetchTool: ToolDefinition<WebFetchToolInput, WebFetchToolOutput> = {
  name: "web.fetch",
  description: "通用网页精读（不经过浏览器，直接 GET 单页转文本，1MB/12s 上限，私网拦截）。适合搜后精读原文，失败再回退到 browser.open/extract。",
  version: "1.0.0",
  riskLevel: "L0",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["url"],
    properties: { url: { type: "string", minLength: 8, maxLength: 2000, description: "https://..." } }
  },
  outputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["url", "finalUrl", "contentType", "status", "text", "truncated", "fetchedAt"],
    properties: {
      url: { type: "string" },
      finalUrl: { type: "string" },
      contentType: { type: "string" },
      status: { type: "number" },
      text: { type: "string", maxLength: 20000 },
      truncated: { type: "boolean" },
      fetchedAt: { type: "number" }
    }
  },
  requiredResources: [{ kind: "network", key: "web-fetch", mode: "shared" }],
  permissions: ["tool.web.fetch"],
  timeoutMs: 15000,
  cancellable: true,
  idempotency: "safe",
  auditPolicy: { logInputSummary: true, logOutputSummary: true },
  enabled: true,
  maxRetries: 1,
  async execute(input, context) {
    return webFetchViaBridge(input.url, context.signal);
  }
};

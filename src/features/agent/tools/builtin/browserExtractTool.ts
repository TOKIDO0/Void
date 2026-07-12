// L0 只读：从当前自动化页面抽取结构化链接/文案（阶段 G2）。

import {
  browserExtract,
  ensureBrowserSession
} from "../../browser/browserBridgeClient";
import type { BrowserExtractData, BrowserExtractMode } from "../../browser/browserBridgeTypes";
import {
  BROWSER_STATIC_RESOURCES,
  resolveTaskIdFromInput,
  throwAsToolError
} from "../../browser/browserToolShared";
import type { ToolDefinition } from "../toolTypes";

export type BrowserExtractToolInput = {
  taskId?: string;
  pageId?: string;
  /** links=链接列表（默认）；text=可见标题/段落；both=合并 */
  mode?: BrowserExtractMode;
  /** 可选：限定抽取范围的选择器 */
  scopeSelector?: string;
  /** 最多条数，默认 20，上限 40 */
  limit?: number;
};

export type BrowserExtractToolOutput = BrowserExtractData;

export const browserExtractTool: ToolDefinition<
  BrowserExtractToolInput,
  BrowserExtractToolOutput
> = {
  name: "browser.extract",
  description:
    "从当前自动化页抽取结构化链接/文案（只读）。click/type 前若看不清结构或 selector 易飘，必须先 extract。mode 默认 links；正文用 text/both。返回 items[].suggestedSelector 仅在页面上唯一匹配时才有，可直接交给 click；若省略则用 text/href 收窄，禁止空猜选择器。items[].role/name 为无障碍语义（ARIA 角色 + 可访问名），可据此判断元素类型（如 button/link）并按 name 选目标。搜索引擎结果优先 browser.readResult，不要用本工具代替。",
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
      mode: {
        type: "string",
        description: "links | text | both，默认 links"
      },
      scopeSelector: {
        type: "string",
        minLength: 1,
        maxLength: 500,
        description: "可选，限定抽取的 CSS/Playwright 选择器范围"
      },
      limit: {
        type: "number",
        description: "最多返回条数，默认 20，上限 40"
      }
    }
  },
  outputSchema: {
    type: "object",
    required: ["taskId", "pageId", "pageUrl", "pageTitle", "mode", "items", "count"],
    properties: {
      taskId: { type: "string" },
      pageId: { type: "string" },
      pageUrl: { type: "string" },
      pageTitle: { type: "string" },
      mode: { type: "string" },
      scopeSelector: { type: "string" },
      count: { type: "number" },
      items: {
        type: "array",
        items: {
          type: "object",
          required: ["index", "kind", "text"],
          properties: {
            index: { type: "number" },
            kind: { type: "string" },
            text: { type: "string" },
            href: { type: "string" },
            tagName: { type: "string" },
            role: { type: "string" },
            name: { type: "string" },
            suggestedSelector: { type: "string" }
          }
        }
      }
    }
  },
  requiredResources: BROWSER_STATIC_RESOURCES,
  permissions: ["tool.browser.extract"],
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
      return await browserExtract(
        {
          taskId,
          pageId: input.pageId,
          mode: input.mode,
          scopeSelector: input.scopeSelector,
          limit: input.limit
        },
        context.signal
      );
    } catch (error) {
      throwAsToolError(error);
    }
  }
};

// L2：用户确认搜索结果中的目标（不猜测）。确认门由执行器在 execute 前拦截。

import type { ToolDefinition } from "../toolTypes";
import { BROWSER_STATIC_RESOURCES } from "../../browser/browserToolShared";
import { resolveTaskIdFromInput } from "../../browser/browserToolShared";

export type BrowserSelectTargetToolInput = {
  /** 候选序号（来自搜索结果 rank） */
  rank?: number;
  title: string;
  url: string;
  snippet?: string;
  taskId?: string;
};

export type BrowserSelectTargetToolOutput = {
  taskId: string;
  selected: true;
  rank?: number;
  title: string;
  url: string;
  snippet?: string;
  confirmedAt: number;
};

export const browserSelectTargetTool: ToolDefinition<
  BrowserSelectTargetToolInput,
  BrowserSelectTargetToolOutput
> = {
  name: "browser.selectTarget",
  description:
    "请用户从搜索结果中确认目标条目（标题/URL）。未确认不得继续打开或下载。不猜测默认目标。",
  version: "1.0.0",
  riskLevel: "L2",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["title", "url"],
    properties: {
      rank: {
        type: "number",
        minimum: 1,
        maximum: 100,
        description: "搜索结果序号"
      },
      title: {
        type: "string",
        minLength: 1,
        maxLength: 500
      },
      url: {
        type: "string",
        minLength: 8,
        maxLength: 2000
      },
      snippet: {
        type: "string",
        maxLength: 2000
      },
      taskId: {
        type: "string",
        minLength: 1,
        maxLength: 120
      }
    }
  },
  outputSchema: {
    type: "object",
    required: ["taskId", "selected", "title", "url", "confirmedAt"],
    properties: {
      taskId: { type: "string" },
      selected: { type: "boolean" },
      rank: { type: "number" },
      title: { type: "string" },
      url: { type: "string" },
      snippet: { type: "string" },
      confirmedAt: { type: "number" }
    }
  },
  requiredResources: BROWSER_STATIC_RESOURCES,
  permissions: ["tool.browser.selectTarget"],
  timeoutMs: 5_000,
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
    // 真正的 L2 确认在 taskRunner 中完成；此处仅在批准后记录结构化选择。
    const taskId = resolveTaskIdFromInput(input, context);
    const url = input.url.trim();
    const title = input.title.trim();
    if (!url || !title) {
      throw {
        code: "SCHEMA_INVALID",
        message: "title 与 url 不能为空",
        retriable: false
      };
    }

    return {
      taskId,
      selected: true as const,
      rank: input.rank,
      title,
      url,
      snippet: input.snippet?.trim() || undefined,
      confirmedAt: Date.now()
    };
  }
};

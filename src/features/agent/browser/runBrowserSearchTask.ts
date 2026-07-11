/**
 * 阶段 C 端到端：「搜索 X」固定计划。
 * search → readResult → screenshot（可选）→ 关闭会话 → 结构化汇报。
 * 不接 VoidStage / System Prompt；由冒烟脚本或后续产品入口调用。
 */

import { runTask } from "../execution";
import type { TaskRunResult } from "../execution";
import { bootstrapAgentRuntime } from "../runtimeBootstrap";
import type { BrowserSearchResultItem } from "./browserBridgeTypes";
import { releaseBrowserSessionForTask } from "./browserSessionLifecycle";

export type BrowserSearchTaskOptions = {
  /** 搜索关键词 */
  query: string;
  /** 结果条数，默认 8 */
  limit?: number;
  /** 是否截图，默认 true（便于验收「真打开了浏览器」） */
  takeScreenshot?: boolean;
  signal?: AbortSignal;
};

export type BrowserSearchTaskStructuredResult = {
  query: string;
  engine: "duckduckgo";
  resultPageUrl?: string;
  pageTitle?: string;
  results: BrowserSearchResultItem[];
  screenshotPath?: string;
  taskId: string;
  taskStatus: string;
  reportMessage: string;
};

export type BrowserSearchTaskResult = {
  ok: boolean;
  structured: BrowserSearchTaskStructuredResult;
  run: TaskRunResult;
};

/**
 * 跑通「搜索 X」只读闭环，返回结构化 JSON（非自然语言糊一段）。
 */
export async function runBrowserSearchTask(
  options: BrowserSearchTaskOptions
): Promise<BrowserSearchTaskResult> {
  const query = options.query.trim();
  if (!query) {
    throw new Error("搜索关键词不能为空");
  }

  bootstrapAgentRuntime();

  const limit = options.limit ?? 8;
  const takeScreenshot = options.takeScreenshot !== false;

  const steps = [
    {
      id: "search",
      title: `搜索：${query}`,
      toolName: "browser.search",
      input: {
        query,
        limit
      }
    },
    {
      id: "read",
      title: "读取搜索结果",
      toolName: "browser.readResult",
      input: {
        limit
      },
      dependsOn: ["search"]
    },
    ...(takeScreenshot
      ? [
          {
            id: "shot",
            title: "截取结果页",
            toolName: "browser.screenshot",
            input: {
              fullPage: false
            },
            dependsOn: ["read"]
          }
        ]
      : [])
  ];

  const run = await runTask(
    {
      goal: `搜索 ${query}`,
      steps
    },
    {
      signal: options.signal
    }
  );

  // 任务终态：释放浏览器上下文（资源锁已由 runner 释放）
  await releaseBrowserSessionForTask(run.plan.id);

  const searchStep = run.plan.steps.find((step) => step.id === "search");
  const readStep = run.plan.steps.find((step) => step.id === "read");
  const shotStep = run.plan.steps.find((step) => step.id === "shot");

  const searchData =
    searchStep?.result && searchStep.result.ok
      ? (searchStep.result.data as {
          results?: BrowserSearchResultItem[];
          resultPageUrl?: string;
          query?: string;
          engine?: "duckduckgo";
        })
      : undefined;

  const readData =
    readStep?.result && readStep.result.ok
      ? (readStep.result.data as {
          results?: BrowserSearchResultItem[];
          pageUrl?: string;
          pageTitle?: string;
        })
      : undefined;

  const shotData =
    shotStep?.result && shotStep.result.ok
      ? (shotStep.result.data as { path?: string })
      : undefined;

  const results =
    (readData?.results && readData.results.length > 0
      ? readData.results
      : searchData?.results) ?? [];

  const structured: BrowserSearchTaskStructuredResult = {
    query,
    engine: "duckduckgo",
    resultPageUrl: readData?.pageUrl ?? searchData?.resultPageUrl,
    pageTitle: readData?.pageTitle,
    results,
    screenshotPath: shotData?.path,
    taskId: run.plan.id,
    taskStatus: run.plan.status,
    reportMessage: run.report.message
  };

  return {
    ok: run.plan.status === "succeeded" && results.length > 0,
    structured,
    run
  };
}

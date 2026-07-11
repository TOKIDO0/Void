/**
 * 阶段 D 样板任务：
 * 搜索 → 用户确认目标 → 打开 → 下载到临时目录
 * → 用户确认目标目录/覆盖策略 → 落盘 → 校验 → 汇报
 *
 * 编排采用分阶段 runTask：每步 input 都是已知结构化数据，不猜测、不改 VoidStage。
 */

import { runTask } from "../execution";
import type { TaskRunResult } from "../execution";
import type { ConfirmationDecision, ConfirmationRequest } from "../permissions";
import { bootstrapAgentRuntime } from "../runtimeBootstrap";
import type { BrowserSearchResultItem } from "./browserBridgeTypes";
import { releaseBrowserSessionForTask } from "./browserSessionLifecycle";
import type {
  FileDownloadToTempData,
  FilePlaceDownloadData,
  FileVerifyData,
  OverwritePolicy
} from "../file/fileBridgeTypes";

export type BrowserAssistSampleTaskOptions = {
  query: string;
  /** 选择第几条搜索结果（1-based）；须由调用方明确给出 */
  selectedRank?: number;
  destinationDirectory?: string;
  overwritePolicy?: OverwritePolicy;
  /**
   * 实际下载 URL。
   * 样板默认公开小 PDF，保证闭环可复现；产品侧应换成用户确认的资源链接。
   */
  downloadUrl?: string;
  suggestedFileName?: string;
  requestConfirmation?: (
    request: ConfirmationRequest
  ) => Promise<ConfirmationDecision>;
  signal?: AbortSignal;
  limit?: number;
};

export type BrowserAssistSampleStructuredResult = {
  query: string;
  selected?: {
    rank?: number;
    title: string;
    url: string;
  };
  opened?: {
    title: string;
    finalUrl: string;
  };
  download?: FileDownloadToTempData;
  placed?: FilePlaceDownloadData;
  verified?: FileVerifyData;
  confirmations: Array<{
    toolName: string;
    title: string;
    description: string;
    approved: boolean;
  }>;
  taskId: string;
  taskStatus: string;
  reportMessage: string;
  /** 人为失败场景时的分类错误 */
  failure?: {
    code?: string;
    message: string;
  };
};

export type BrowserAssistSampleTaskResult = {
  ok: boolean;
  structured: BrowserAssistSampleStructuredResult;
  runs: TaskRunResult[];
};

const DEFAULT_DESTINATION = "D:\\AI\\void-runtime\\downloads";
/** 公开小文本：无登录、稳定、体积小（样板闭环专用，非生产业务资源） */
const DEFAULT_SAMPLE_DOWNLOAD_URL =
  "https://raw.githubusercontent.com/microsoft/playwright/main/README.md";

export async function runBrowserAssistSampleTask(
  options: BrowserAssistSampleTaskOptions
): Promise<BrowserAssistSampleTaskResult> {
  const query = options.query.trim();
  if (!query) {
    throw new Error("搜索关键词不能为空");
  }

  bootstrapAgentRuntime();

  const limit = options.limit ?? 5;
  const selectedRank = options.selectedRank ?? 1;
  const destinationDirectory =
    options.destinationDirectory?.trim() || DEFAULT_DESTINATION;
  const overwritePolicy = options.overwritePolicy ?? "rename";
  const downloadUrl = options.downloadUrl?.trim() || DEFAULT_SAMPLE_DOWNLOAD_URL;
  const suggestedFileName =
    options.suggestedFileName?.trim() || "void-sample-download.md";

  const confirmations: BrowserAssistSampleStructuredResult["confirmations"] = [];
  const runs: TaskRunResult[] = [];

  const requestConfirmation = async (
    request: ConfirmationRequest
  ): Promise<ConfirmationDecision> => {
    if (options.requestConfirmation) {
      const decision = await options.requestConfirmation(request);
      confirmations.push({
        toolName: request.toolName,
        title: request.title,
        description: request.description,
        approved: decision.approved
      });
      return decision;
    }

    confirmations.push({
      toolName: request.toolName,
      title: request.title,
      description: request.description,
      approved: false
    });
    return {
      requestId: request.id,
      approved: false,
      decidedAt: Date.now(),
      note: "未提供确认回调，拒绝敏感步骤"
    };
  };

  const runnerOptions = {
    signal: options.signal,
    requestConfirmation
  };

  // 1) 搜索（L0）
  const searchRun = await runTask(
    {
      goal: `搜索 ${query}`,
      steps: [
        {
          id: "search",
          title: `搜索：${query}`,
          toolName: "browser.search",
          input: { query, limit }
        }
      ]
    },
    { signal: options.signal }
  );
  runs.push(searchRun);

  const searchStep = searchRun.plan.steps.find((step) => step.id === "search");
  const results =
    searchStep?.result && searchStep.result.ok
      ? ((searchStep.result.data as { results?: BrowserSearchResultItem[] }).results ?? [])
      : [];
  const selected =
    results.find((item) => item.rank === selectedRank) ?? results[0];

  if (searchRun.plan.status !== "succeeded" || !selected) {
    await releaseBrowserSessionForTask(searchRun.plan.id);
    return {
      ok: false,
      structured: {
        query,
        confirmations,
        taskId: searchRun.plan.id,
        taskStatus: searchRun.plan.status,
        reportMessage: searchRun.report.message,
        failure: {
          code: searchRun.plan.error?.code,
          message: searchRun.plan.error?.message ?? "搜索未返回可用结果"
        }
      },
      runs
    };
  }

  // 2) 确认目标 + 打开页面
  const openRun = await runTask(
    {
      goal: `确认并打开：${selected.title}`,
      steps: [
        {
          id: "select",
          title: "确认搜索目标",
          toolName: "browser.selectTarget",
          input: {
            rank: selected.rank,
            title: selected.title,
            url: selected.url,
            snippet: selected.snippet
          }
        },
        {
          id: "open",
          title: "打开目标页面",
          toolName: "browser.open",
          input: { url: selected.url },
          dependsOn: ["select"]
        }
      ]
    },
    runnerOptions
  );
  runs.push(openRun);

  if (openRun.plan.status !== "succeeded") {
    await releaseBrowserSessionForTask(searchRun.plan.id);
    await releaseBrowserSessionForTask(openRun.plan.id);
    return {
      ok: false,
      structured: {
        query,
        selected: {
          rank: selected.rank,
          title: selected.title,
          url: selected.url
        },
        confirmations,
        taskId: openRun.plan.id,
        taskStatus: openRun.plan.status,
        reportMessage: openRun.report.message,
        failure: {
          code: openRun.plan.error?.code,
          message: openRun.plan.error?.message ?? openRun.report.message
        }
      },
      runs
    };
  }

  const openStep = openRun.plan.steps.find((step) => step.id === "open");
  const opened =
    openStep?.result && openStep.result.ok
      ? {
          title: String((openStep.result.data as { title?: string }).title ?? ""),
          finalUrl: String((openStep.result.data as { finalUrl?: string }).finalUrl ?? "")
        }
      : undefined;

  // 3) 下载到临时目录（L2）
  const downloadRun = await runTask(
    {
      goal: `下载资源到临时目录`,
      steps: [
        {
          id: "download",
          title: "下载到临时目录",
          toolName: "file.downloadToTemp",
          input: {
            url: downloadUrl,
            suggestedFileName
          }
        }
      ]
    },
    runnerOptions
  );
  runs.push(downloadRun);

  const downloadStep = downloadRun.plan.steps.find((step) => step.id === "download");
  const downloadData =
    downloadStep?.result && downloadStep.result.ok
      ? (downloadStep.result.data as FileDownloadToTempData)
      : undefined;

  if (downloadRun.plan.status !== "succeeded" || !downloadData) {
    await releaseBrowserSessionForTask(searchRun.plan.id);
    await releaseBrowserSessionForTask(openRun.plan.id);
    return {
      ok: false,
      structured: {
        query,
        selected: {
          rank: selected.rank,
          title: selected.title,
          url: selected.url
        },
        opened,
        download: downloadData,
        confirmations,
        taskId: downloadRun.plan.id,
        taskStatus: downloadRun.plan.status,
        reportMessage: downloadRun.report.message,
        failure: {
          code: downloadRun.plan.error?.code,
          message: downloadRun.plan.error?.message ?? "下载到临时目录失败"
        }
      },
      runs
    };
  }

  // 4) 确认落盘（L2）
  const placeRun = await runTask(
    {
      goal: "确认并移动到最终目录",
      steps: [
        {
          id: "place",
          title: "确认并移动到最终目录",
          toolName: "file.placeDownload",
          input: {
            tempPath: downloadData.tempPath,
            destinationDirectory,
            fileName: downloadData.fileName || suggestedFileName,
            overwritePolicy
          }
        }
      ]
    },
    runnerOptions
  );
  runs.push(placeRun);

  const placeStep = placeRun.plan.steps.find((step) => step.id === "place");
  const placeData =
    placeStep?.result && placeStep.result.ok
      ? (placeStep.result.data as FilePlaceDownloadData)
      : undefined;

  let verifyData: FileVerifyData | undefined;

  if (placeData) {
    // 5) 校验最终文件（L0）
    const verifyRun = await runTask(
      {
        goal: `校验文件 ${placeData.finalPath}`,
        steps: [
          {
            id: "verify",
            title: "校验最终文件",
            toolName: "file.verify",
            input: { path: placeData.finalPath }
          }
        ]
      },
      { signal: options.signal }
    );
    runs.push(verifyRun);
    const verifyStep = verifyRun.plan.steps.find((step) => step.id === "verify");
    verifyData =
      verifyStep?.result && verifyStep.result.ok
        ? (verifyStep.result.data as FileVerifyData)
        : undefined;
  }

  await releaseBrowserSessionForTask(searchRun.plan.id);
  await releaseBrowserSessionForTask(openRun.plan.id);

  const lastRun = runs[runs.length - 1] ?? placeRun;
  const structured: BrowserAssistSampleStructuredResult = {
    query,
    selected: {
      rank: selected.rank,
      title: selected.title,
      url: selected.url
    },
    opened,
    download: downloadData,
    placed: placeData,
    verified: verifyData,
    confirmations,
    taskId: lastRun.plan.id,
    taskStatus: placeData && verifyData?.exists ? "succeeded" : lastRun.plan.status,
    reportMessage: placeData && verifyData?.exists
      ? `样板任务完成：已下载并校验 ${placeData.finalPath}（${verifyData.bytes} bytes, ${verifyData.mediaKind}）`
      : lastRun.report.message,
    failure:
      placeData && verifyData?.exists
        ? undefined
        : {
            code: lastRun.plan.error?.code,
            message: lastRun.plan.error?.message ?? lastRun.report.message
          }
  };

  const ok =
    Boolean(placeData)
    && Boolean(verifyData?.exists)
    && typeof verifyData?.bytes === "number"
    && Boolean(verifyData?.mediaKind)
    && confirmations.some((item) => item.toolName === "browser.selectTarget" && item.approved)
    && confirmations.some((item) => item.toolName === "file.placeDownload" && item.approved)
    && confirmations.every((item) => {
      // 所有确认描述必须有上下文（非空且不是裸「确定」）
      return item.description.length > 20;
    });

  return { ok, structured, runs };
}

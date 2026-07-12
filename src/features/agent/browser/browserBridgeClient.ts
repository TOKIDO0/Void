/**
 * 浏览器 sidecar HTTP 客户端。
 *
 * 约定：
 * - 地址固定回环 127.0.0.1:17872（与 voidBridgeRuntime / voidBridgeServer 一致）
 * - 工具实现只调本客户端，不 import playwright
 * - 错误映射为结构化 code，供 ToolError 使用
 */

import type {
  BrowserBridgeResponse,
  BrowserClickData,
  BrowserCloseSessionData,
  BrowserEnsureSessionData,
  BrowserExtractData,
  BrowserExtractMode,
  BrowserOpenData,
  BrowserReadResultData,
  BrowserRevealInSystemBrowserData,
  BrowserScreenshotData,
  BrowserSearchData,
  BrowserTypeData,
  BrowserWaitForData
} from "./browserBridgeTypes";

const DEFAULT_BRIDGE_ORIGIN = "http://127.0.0.1:17872";

function resolveBrowserBridgeOrigin(): string {
  // 允许 Node 冒烟/联调覆盖端口；浏览器环境无 process，走默认回环。
  // 不用直接引用 process，避免前端 tsconfig 无 Node 类型时报错。
  const env = (globalThis as {
    process?: { env?: Record<string, string | undefined> };
  }).process?.env;

  const origin = env?.VOID_BRIDGE_ORIGIN;
  if (origin && origin.trim()) {
    return origin.replace(/\/$/, "");
  }

  const port = env?.VOID_BRIDGE_PORT;
  if (port && port.trim()) {
    return `http://127.0.0.1:${port.trim()}`;
  }

  return DEFAULT_BRIDGE_ORIGIN;
}

async function postBrowserApi<T>(
  pathname: string,
  body: Record<string, unknown>,
  signal?: AbortSignal
): Promise<T> {
  const url = `${resolveBrowserBridgeOrigin()}${pathname}`;

  // 合并调用方取消信号与短连接超时，避免 sidecar 挂起拖死任务
  const timeoutController = new AbortController();
  const timeoutHandle = setTimeout(() => timeoutController.abort(), 90_000);
  const onCallerAbort = () => timeoutController.abort();
  if (signal) {
    if (signal.aborted) {
      timeoutController.abort();
    } else {
      signal.addEventListener("abort", onCallerAbort, { once: true });
    }
  }

  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify(body),
      signal: timeoutController.signal
    });
  } catch (error) {
    const message =
      error instanceof Error
        ? error.message
        : "无法连接浏览器桥接服务";
    const aborted = timeoutController.signal.aborted;
    throw createBridgeClientError(
      aborted && signal?.aborted ? "INTERNAL_ERROR" : aborted ? "TIMEOUT" : "BRIDGE_UNREACHABLE",
      aborted && signal?.aborted
        ? "浏览器请求已取消"
        : aborted
          ? `浏览器桥接超时（${url}）`
          : `浏览器桥接不可达（${url}）：${message}。请确认 sidecar 已启动（npm run dev:bridge / tauri:dev）。`
    );
  } finally {
    clearTimeout(timeoutHandle);
    signal?.removeEventListener("abort", onCallerAbort);
  }

  let payload: BrowserBridgeResponse<T>;
  try {
    payload = (await response.json()) as BrowserBridgeResponse<T>;
  } catch {
    throw createBridgeClientError(
      "INTERNAL_ERROR",
      `浏览器桥接返回非 JSON（HTTP ${response.status}）`
    );
  }

  if (!payload || typeof payload !== "object") {
    throw createBridgeClientError("INTERNAL_ERROR", "浏览器桥接响应格式错误");
  }

  if (!payload.ok) {
    throw createBridgeClientError(
      payload.error?.code ?? "INTERNAL_ERROR",
      payload.error?.message ?? "浏览器操作失败",
      payload.error?.details
    );
  }

  return payload.data;
}

function createBridgeClientError(
  code: string,
  message: string,
  details?: Record<string, unknown>
) {
  const error = new Error(message) as Error & {
    bridgeCode: string;
    details?: Record<string, unknown>;
  };
  error.bridgeCode = code;
  error.details = details;
  return error;
}

export function getBrowserBridgeErrorInfo(error: unknown): {
  code: string;
  message: string;
  details?: Record<string, unknown>;
} {
  if (
    typeof error === "object"
    && error !== null
    && "bridgeCode" in error
    && typeof (error as { bridgeCode?: unknown }).bridgeCode === "string"
  ) {
    const coded = error as Error & {
      bridgeCode: string;
      details?: Record<string, unknown>;
    };
    return {
      code: coded.bridgeCode,
      message: coded.message,
      details: coded.details
    };
  }

  if (error instanceof Error) {
    return { code: "INTERNAL_ERROR", message: error.message };
  }

  return { code: "INTERNAL_ERROR", message: "浏览器桥接未知错误" };
}

export async function ensureBrowserSession(
  taskId: string,
  signal?: AbortSignal
): Promise<BrowserEnsureSessionData> {
  return postBrowserApi<BrowserEnsureSessionData>(
    "/void-browser/session/ensure",
    { taskId },
    signal
  );
}

export async function closeBrowserSession(
  taskId: string,
  signal?: AbortSignal
): Promise<BrowserCloseSessionData> {
  return postBrowserApi<BrowserCloseSessionData>(
    "/void-browser/session/close",
    { taskId },
    signal
  );
}

export async function browserOpen(
  input: { taskId: string; url: string; pageId?: string },
  signal?: AbortSignal
): Promise<BrowserOpenData> {
  return postBrowserApi<BrowserOpenData>("/void-browser/open", input, signal);
}

export async function browserSearch(
  input: {
    taskId: string;
    query: string;
    engine?: "duckduckgo" | "bilibili";
    limit?: number;
  },
  signal?: AbortSignal
): Promise<BrowserSearchData> {
  return postBrowserApi<BrowserSearchData>("/void-browser/search", input, signal);
}

/** 用系统默认浏览器打开 URL，给用户在常用浏览器里查看 */
export async function browserRevealInSystemBrowser(
  input: { taskId: string; url: string; titleHint?: string },
  signal?: AbortSignal
): Promise<BrowserRevealInSystemBrowserData> {
  return postBrowserApi<BrowserRevealInSystemBrowserData>(
    "/void-browser/reveal-system",
    input,
    signal
  );
}

export async function browserReadResult(
  input: { taskId: string; pageId?: string; limit?: number },
  signal?: AbortSignal
): Promise<BrowserReadResultData> {
  return postBrowserApi<BrowserReadResultData>(
    "/void-browser/read-result",
    input,
    signal
  );
}

export async function browserScreenshot(
  input: { taskId: string; pageId?: string; fullPage?: boolean },
  signal?: AbortSignal
): Promise<BrowserScreenshotData> {
  return postBrowserApi<BrowserScreenshotData>(
    "/void-browser/screenshot",
    input,
    signal
  );
}

/** 阶段 G1 / Q1：点击（selector 或 role+name） */
export async function browserClick(
  input: {
    taskId: string;
    pageId?: string;
    selector?: string;
    role?: string;
    name?: string;
    button?: "left" | "right" | "middle";
    clickCount?: number;
  },
  signal?: AbortSignal
): Promise<BrowserClickData> {
  return postBrowserApi<BrowserClickData>("/void-browser/click", input, signal);
}

/** 阶段 G1 / Q1：输入文本（selector 或 role+name） */
export async function browserType(
  input: {
    taskId: string;
    pageId?: string;
    selector?: string;
    role?: string;
    name?: string;
    text: string;
    clear?: boolean;
    submit?: boolean;
  },
  signal?: AbortSignal
): Promise<BrowserTypeData> {
  return postBrowserApi<BrowserTypeData>("/void-browser/type", input, signal);
}

/** 阶段 G1：等待元素状态 */
export async function browserWaitFor(
  input: {
    taskId: string;
    pageId?: string;
    selector: string;
    state?: "attached" | "detached" | "visible" | "hidden";
    timeoutMs?: number;
  },
  signal?: AbortSignal
): Promise<BrowserWaitForData> {
  return postBrowserApi<BrowserWaitForData>("/void-browser/wait-for", input, signal);
}

/** 阶段 G2：结构化抽取（标题/链接/可见文案） */
export async function browserExtract(
  input: {
    taskId: string;
    pageId?: string;
    mode?: BrowserExtractMode;
    scopeSelector?: string;
    limit?: number;
    includeBelowFold?: boolean;
  },
  signal?: AbortSignal
): Promise<BrowserExtractData> {
  return postBrowserApi<BrowserExtractData>("/void-browser/extract", input, signal);
}

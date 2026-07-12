/**
 * 文件 sidecar HTTP 客户端（下载/落盘/校验）。
 */

import type {
  FileBridgeResponse,
  FileDownloadToTempData,
  FileListDirectoryData,
  FilePlaceDownloadData,
  FileReadTextData,
  FileVerifyData,
  OverwritePolicy
} from "./fileBridgeTypes";

const DEFAULT_BRIDGE_ORIGIN = "http://127.0.0.1:17872";

function resolveBridgeOrigin(): string {
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

function createFileBridgeError(
  code: string,
  message: string,
  details?: Record<string, unknown>
) {
  const error = new Error(message) as Error & {
    fileBridgeCode: string;
    details?: Record<string, unknown>;
  };
  error.fileBridgeCode = code;
  error.details = details;
  return error;
}

export function getFileBridgeErrorInfo(error: unknown): {
  code: string;
  message: string;
  details?: Record<string, unknown>;
} {
  if (
    typeof error === "object"
    && error !== null
    && "fileBridgeCode" in error
    && typeof (error as { fileBridgeCode?: unknown }).fileBridgeCode === "string"
  ) {
    const coded = error as Error & {
      fileBridgeCode: string;
      details?: Record<string, unknown>;
    };
    return {
      code: coded.fileBridgeCode,
      message: coded.message,
      details: coded.details
    };
  }
  if (error instanceof Error) {
    return { code: "INTERNAL_ERROR", message: error.message };
  }
  return { code: "INTERNAL_ERROR", message: "文件桥接未知错误" };
}

async function postFileApi<T>(
  pathname: string,
  body: Record<string, unknown>,
  signal?: AbortSignal
): Promise<T> {
  const url = `${resolveBridgeOrigin()}${pathname}`;
  const timeoutController = new AbortController();
  const timeoutHandle = setTimeout(() => timeoutController.abort(), 120_000);
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
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: timeoutController.signal
    });
  } catch (error) {
    const aborted = timeoutController.signal.aborted;
    const message = error instanceof Error ? error.message : "无法连接文件桥接服务";
    throw createFileBridgeError(
      aborted && signal?.aborted
        ? "INTERNAL_ERROR"
        : aborted
          ? "TIMEOUT"
          : "BRIDGE_UNREACHABLE",
      aborted && signal?.aborted
        ? "文件请求已取消"
        : aborted
          ? `文件桥接超时（${url}）`
          : `文件桥接不可达（${url}）：${message}`
    );
  } finally {
    clearTimeout(timeoutHandle);
    signal?.removeEventListener("abort", onCallerAbort);
  }

  let payload: FileBridgeResponse<T>;
  try {
    payload = (await response.json()) as FileBridgeResponse<T>;
  } catch {
    throw createFileBridgeError(
      "INTERNAL_ERROR",
      `文件桥接返回非 JSON（HTTP ${response.status}）`
    );
  }

  if (!payload?.ok) {
    throw createFileBridgeError(
      payload && "error" in payload ? payload.error.code : "INTERNAL_ERROR",
      payload && "error" in payload ? payload.error.message : "文件操作失败",
      payload && "error" in payload ? payload.error.details : undefined
    );
  }

  return payload.data;
}

export async function downloadToTemp(
  input: { taskId: string; url: string; suggestedFileName?: string },
  signal?: AbortSignal
): Promise<FileDownloadToTempData> {
  return postFileApi<FileDownloadToTempData>(
    "/void-file/download-to-temp",
    input,
    signal
  );
}

export async function placeDownload(
  input: {
    taskId: string;
    tempPath: string;
    destinationDirectory: string;
    fileName?: string;
    overwritePolicy: OverwritePolicy;
  },
  signal?: AbortSignal
): Promise<FilePlaceDownloadData> {
  return postFileApi<FilePlaceDownloadData>(
    "/void-file/place-download",
    input,
    signal
  );
}

export async function verifyFile(
  input: { path: string },
  signal?: AbortSignal
): Promise<FileVerifyData> {
  return postFileApi<FileVerifyData>("/void-file/verify", input, signal);
}

export async function listDirectory(
  input: { path: string },
  signal?: AbortSignal
): Promise<FileListDirectoryData> {
  return postFileApi<FileListDirectoryData>("/void-file/list-directory", input, signal);
}

export async function readText(
  input: { path: string },
  signal?: AbortSignal
): Promise<FileReadTextData> {
  return postFileApi<FileReadTextData>("/void-file/read-text", input, signal);
}

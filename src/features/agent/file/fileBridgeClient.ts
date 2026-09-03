/**
 * 文件 sidecar HTTP 客户端（下载/落盘/校验）。
 */

import type {
  FileBridgeResponse,
  FileDownloadToTempData,
  FileDownloadMediaPageData,
  FileCreateDirectoryData,
  FileFindByNameData,
  FileFindByNameRequest,
  FileInspectPathData,
  FileListDirectoryData,
  FileOrganizeDirectoryData,
  FileCreateExcelData,
  FileCreatePptxData,
  FileCreateDocxData,
  FilePlaceDownloadData,
  FileReadTextData,
  FileSearchTextData,
  FileSearchTextRequest,
  FileInspectWriteTargetData,
  FileListRecentArtifactsData,
  FileMoveData,
  MoveConflictPolicy,
  FileWriteTextData,
  FileEditTextData,
  TextWriteConflictPolicy,
  FileVerifyData,
  OverwritePolicy
} from "./fileBridgeTypes";
import { bridgeAuthHeadersForUrl } from "../../../lib/runtime/voidBridgeAuth";

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
    const authHeaders = await bridgeAuthHeadersForUrl(url);
    response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...authHeaders },
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


async function postFileApiWithTimeout<T>(
  pathname: string,
  body: Record<string, unknown>,
  timeoutMs: number,
  signal?: AbortSignal
): Promise<T> {
  const url = `${resolveBridgeOrigin()}${pathname}`;
  const timeoutController = new AbortController();
  const timeoutHandle = setTimeout(() => timeoutController.abort(), timeoutMs);
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
    const authHeaders = await bridgeAuthHeadersForUrl(url);
    response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...authHeaders },
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

export async function downloadMediaPage(
  input: { taskId: string; pageUrl: string; suggestedFileName?: string },
  signal?: AbortSignal
): Promise<FileDownloadMediaPageData> {
  return postFileApiWithTimeout<FileDownloadMediaPageData>(
    "/void-file/download-media-page",
    input,
    15 * 60_000,
    signal
  );
}

export async function downloadMedia(
  input: { url: string; extractAudio?: boolean; fileName?: string },
  signal?: AbortSignal
): Promise<FileDownloadMediaPageData> {
  const taskId = crypto.randomUUID();
  return postFileApiWithTimeout<FileDownloadMediaPageData>(
    "/void-file/download-media",
    { taskId, pageUrl: input.url, extractAudio: input.extractAudio ?? false, suggestedFileName: input.fileName },
    15 * 60_000,
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

export async function inspectPath(
  input: { path: string },
  signal?: AbortSignal
): Promise<FileInspectPathData> {
  return postFileApi<FileInspectPathData>("/void-file/inspect-path", input, signal);
}

export async function listRecentArtifacts(
  input: { limit?: number },
  signal?: AbortSignal
): Promise<FileListRecentArtifactsData> {
  return postFileApi<FileListRecentArtifactsData>(
    "/void-file/list-recent-artifacts",
    input,
    signal
  );
}

export async function readText(
  input: { path: string },
  signal?: AbortSignal
): Promise<FileReadTextData> {
  return postFileApi<FileReadTextData>("/void-file/read-text", input, signal);
}

export async function searchText(
  input: FileSearchTextRequest,
  signal?: AbortSignal
): Promise<FileSearchTextData> {
  return postFileApi<FileSearchTextData>("/void-file/search-text", input, signal);
}

export async function findByName(
  input: FileFindByNameRequest,
  signal?: AbortSignal
): Promise<FileFindByNameData> {
  return postFileApi<FileFindByNameData>("/void-file/find-by-name", input, signal);
}

export async function createDirectory(
  input: { path: string },
  signal?: AbortSignal
): Promise<FileCreateDirectoryData> {
  return postFileApi<FileCreateDirectoryData>("/void-file/create-directory", input, signal);
}

export async function moveFile(
  input: {
    sourcePath: string;
    destinationPath: string;
    conflictPolicy: MoveConflictPolicy;
  },
  signal?: AbortSignal
): Promise<FileMoveData> {
  return postFileApi<FileMoveData>("/void-file/move", input, signal);
}

export async function writeText(
  input: {
    path?: string;
    fileName?: string;
    content: string;
    conflictPolicy: TextWriteConflictPolicy;
  },
  signal?: AbortSignal
): Promise<FileWriteTextData> {
  return postFileApi<FileWriteTextData>("/void-file/write-text", input, signal);
}

export async function editText(
  input: {
    path: string;
    oldText: string;
    newText: string;
  },
  signal?: AbortSignal
): Promise<FileEditTextData> {
  return postFileApi<FileEditTextData>("/void-file/edit-text", input, signal);
}

export async function inspectWriteTarget(
  input: {
    path?: string;
    fileName?: string;
    conflictPolicy: TextWriteConflictPolicy;
  },
  signal?: AbortSignal
): Promise<FileInspectWriteTargetData> {
  return postFileApi<FileInspectWriteTargetData>(
    "/void-file/inspect-write-target",
    input,
    signal
  );
}

export async function organizeDirectory(
  input: { path?: string; dryRun?: boolean; strategy?: "byExtension" | "byDate" },
  signal?: AbortSignal
): Promise<FileOrganizeDirectoryData> {
  return postFileApi<FileOrganizeDirectoryData>("/void-file/organize-directory", input, signal);
}

export async function createExcel(
  input: { fileName: string; sheets: Array<{ name: string; headers: string[]; rows: (string | number)[][]; chart?: { type: "bar" | "pie"; title: string; xColumn: number; yColumn: number } }>; templateId?: string; title?: string },
  signal?: AbortSignal
): Promise<FileCreateExcelData> {
  return postFileApi<FileCreateExcelData>("/void-file/create-excel", input, signal);
}

export async function createPptx(
  input: { fileName: string; title?: string; slides: Array<{ title: string; bullets?: string[]; body?: string; chart?: { type: "bar" | "pie"; title: string; labels: string[]; values: number[] }; layout?: string }>; templateId?: string },
  signal?: AbortSignal
): Promise<FileCreatePptxData> {
  return postFileApi<FileCreatePptxData>("/void-file/create-pptx", input, signal);
}

export async function createDocx(
  input: { fileName: string; title?: string; subtitle?: string; sections: Array<{ heading: string; paragraphs?: string[]; bullets?: string[]; table?: { headers: string[]; rows: (string | number)[][]; caption?: string }; quote?: string }>; templateId?: string },
  signal?: AbortSignal
): Promise<FileCreateDocxData> {
  return postFileApi<FileCreateDocxData>("/void-file/create-docx", input, signal);
}

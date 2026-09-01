/**
 * 文件下载/落盘/校验 HTTP 路由：/void-file/*
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import { join } from "node:path";
import {
  isInvalidJsonBody,
  isRequestBodyTooLarge,
  readJsonBody
} from "../http/httpRequest";
import { fileDownloadManager } from "./fileDownloadManager";
import { mediaPageDownloadManager } from "./mediaPageDownloadManager";
import { genericMediaDownloadManager } from "./genericMediaDownloadManager";
import { fileAccessManager } from "./fileAccessManager";
import { fileMutationManager } from "./fileMutationManager";
import { fileOrganizeManager } from "./fileOrganizeManager";
import { createExcelFile } from "./fileExcelManager";
import { createPptxFile } from "./filePptManager";
import { getFileErrorPayload, resolveDownloadFinalRoot } from "./fileRuntimePaths";
import type {
  FileApiResponse,
  FileDownloadToTempData,
  FileDownloadMediaPageData,
  FileFindByNameData,
  FileFindByNameRequest,
  FileInspectPathData,
  FileInspectWriteTargetData,
  FileListDirectoryData,
  FileListRecentArtifactsData,
  FileCreateDirectoryData,
  FileMoveData,
  FileOrganizeDirectoryData,
  FileCreateExcelData,
  FileCreatePptxData,
  FilePlaceDownloadData,
  FileReadTextData,
  FileSearchTextData,
  FileVerifyData,
  FileWriteTextData,
  TextWriteConflictPolicy,
  OverwritePolicy
} from "./fileTypes";

function sendJson(response: ServerResponse, status: number, body: unknown) {
  if (response.destroyed || response.writableEnded) {
    return;
  }
  response.statusCode = status;
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  response.end(JSON.stringify(body));
}

function asRecord(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return {};
}

function readString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function readRawString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" ? value : undefined;
}

function readOptionalNumber(record: Record<string, unknown>, key: string): number | undefined {
  const value = record[key];
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw createInvalidFileRequest(`${key} 必须是数字`);
  }
  return value;
}

function readOptionalBoolean(record: Record<string, unknown>, key: string): boolean | undefined {
  const value = record[key];
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "boolean") {
    throw createInvalidFileRequest(`${key} 必须是布尔值`);
  }
  return value;
}

function readOptionalStringArray(record: Record<string, unknown>, key: string): string[] | undefined {
  const value = record[key];
  if (value === undefined) {
    return undefined;
  }
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw createInvalidFileRequest(`${key} 必须是字符串数组`);
  }
  return value;
}

function createInvalidFileRequest(message: string) {
  return Object.assign(new Error(message), { fileCode: "INVALID_REQUEST" });
}

function readSafeDefaultFileName(record: Record<string, unknown>): string | undefined {
  const fileName = readString(record, "fileName");
  if (!fileName) {
    return undefined;
  }

  if (
    fileName.includes("/")
    || fileName.includes("\\")
    || /[<>:"|?*\x00-\x1F]/.test(fileName)
    || /[ .]$/.test(fileName)
    || fileName === "."
    || fileName === ".."
  ) {
    throw createInvalidFileRequest(`fileName 只能是普通文件名，不能包含路径或非法字符：${fileName}`);
  }

  const reservedName = fileName.split(".")[0].toUpperCase();
  if (/^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/.test(reservedName)) {
    throw createInvalidFileRequest(`fileName 不能使用 Windows 保留名：${fileName}`);
  }

  return fileName;
}

function resolveTextWritePath(record: Record<string, unknown>): string {
  const path = readString(record, "path");
  const fileName = readSafeDefaultFileName(record);
  if (path && fileName) {
    throw createInvalidFileRequest("path 与 fileName 只能提供一个");
  }
  if (path) {
    return path;
  }
  if (fileName) {
    return join(resolveDownloadFinalRoot(), fileName);
  }
  throw createInvalidFileRequest("缺少 path 或 fileName");
}

function createRequestAbortSignal(
  request: IncomingMessage,
  response: ServerResponse
): AbortSignal {
  const controller = new AbortController();
  const abort = () => {
    if (!controller.signal.aborted) {
      controller.abort();
    }
  };

  request.once("aborted", abort);
  response.once("close", () => {
    if (!response.writableEnded) {
      abort();
    }
  });

  return controller.signal;
}

async function withFileHandler<T>(
  response: ServerResponse,
  work: () => Promise<T> | T
): Promise<void> {
  try {
    const data = await work();
    const payload: FileApiResponse<T> = { ok: true, data };
    sendJson(response, 200, payload);
  } catch (error) {
    if (isRequestBodyTooLarge(error)) {
      sendJson(response, 413, {
        ok: false,
        error: { code: "REQUEST_BODY_TOO_LARGE", message: error.message }
      });
      return;
    }
    if (isInvalidJsonBody(error)) {
      sendJson(response, 400, {
        ok: false,
        error: { code: "INVALID_REQUEST", message: error.message }
      });
      return;
    }
    const payloadError = getFileErrorPayload(error);
    const status = resolveFileErrorStatus(payloadError.code);
    const payload: FileApiResponse<never> = {
      ok: false,
      error: payloadError
    };
    sendJson(response, status, payload);
  }
}

function resolveFileErrorStatus(code: string): number {
  switch (code) {
    case "INVALID_REQUEST":
    case "MEDIA_HOST_NOT_ALLOWED":
    case "CROSS_DEVICE_MOVE":
      return 400;
    case "DOWNLOAD_BLOCKED":
    case "PATH_NOT_ALLOWED":
    case "OVERWRITE_REFUSED":
      return 403;
    case "FILE_NOT_FOUND":
      return 404;
    case "DESTINATION_EXISTS":
      return 409;
    case "FILE_TOO_LARGE":
      return 413;
    case "INVALID_UTF8":
    case "BINARY_FILE":
    case "UNSUPPORTED_DOCUMENT":
      return 415;
    case "YTDLP_NOT_FOUND":
    case "FFMPEG_NOT_FOUND":
      return 503;
    default:
      return 500;
  }
}

function parseOverwritePolicy(value: unknown): OverwritePolicy {
  if (value === "refuse" || value === "overwrite" || value === "rename") {
    return value;
  }
  throw Object.assign(new Error("overwritePolicy 必须是 refuse | overwrite | rename"), {
    fileCode: "INVALID_REQUEST"
  });
}

function parseTextWriteConflictPolicy(value: unknown): TextWriteConflictPolicy {
  if (value === "refuse" || value === "overwrite" || value === "rename") {
    return value;
  }
  throw Object.assign(new Error("conflictPolicy 必须是 refuse | overwrite | rename"), {
    fileCode: "INVALID_REQUEST"
  });
}

function readOptionalFindByNameKind(
  record: Record<string, unknown>
): FileFindByNameRequest["kind"] | undefined {
  const value = record.kind;
  if (value === undefined) {
    return undefined;
  }
  if (value === "any" || value === "file" || value === "directory") {
    return value;
  }
  throw createInvalidFileRequest("kind 必须是 any | file | directory");
}

/**
 * 处理 /void-file/* 。命中返回 true。
 */
export async function handleFileHttpRequest(
  request: IncomingMessage,
  response: ServerResponse,
  pathname: string
): Promise<boolean> {
  if (!pathname.startsWith("/void-file")) {
    return false;
  }

  if (request.method === "GET" && pathname === "/void-file/health") {
    sendJson(response, 200, { status: "ok" });
    return true;
  }

  if (request.method !== "POST") {
    sendJson(response, 405, {
      ok: false,
      error: { code: "INVALID_REQUEST", message: "仅支持 POST/GET health" }
    });
    return true;
  }

  if (pathname === "/void-file/download-to-temp") {
    await withFileHandler<FileDownloadToTempData>(response, async () => {
      const body = asRecord(await readJsonBody(request));
      const taskId = readString(body, "taskId");
      const url = readString(body, "url");
      if (!taskId || !url) {
        throw Object.assign(new Error("缺少 taskId 或 url"), { fileCode: "INVALID_REQUEST" });
      }
      return fileDownloadManager.downloadToTemp({
        taskId,
        url,
        suggestedFileName: readString(body, "suggestedFileName"),
        signal: createRequestAbortSignal(request, response)
      });
    });
    return true;
  }

  if (pathname === "/void-file/download-media-page") {
    await withFileHandler<FileDownloadMediaPageData>(response, async () => {
      const body = asRecord(await readJsonBody(request));
      const taskId = readString(body, "taskId");
      const pageUrl = readString(body, "pageUrl");
      if (!taskId || !pageUrl) {
        throw Object.assign(new Error("缺少 taskId 或 pageUrl"), { fileCode: "INVALID_REQUEST" });
      }
      return mediaPageDownloadManager.downloadMediaPage({
        taskId,
        pageUrl,
        suggestedFileName: readString(body, "suggestedFileName")
      });
    });
    return true;
  }

  if (pathname === "/void-file/download-media") {
    await withFileHandler<FileDownloadMediaPageData>(response, async () => {
      const body = asRecord(await readJsonBody(request));
      const taskId = readString(body, "taskId");
      const pageUrl = readString(body, "pageUrl");
      const extractAudio = body.extractAudio === true;
      if (!taskId || !pageUrl) {
        throw Object.assign(new Error("缺少 taskId 或 pageUrl"), { fileCode: "INVALID_REQUEST" });
      }
      return genericMediaDownloadManager.downloadGenericMedia({
        taskId,
        pageUrl,
        extractAudio,
        suggestedFileName: readString(body, "suggestedFileName")
      });
    });
    return true;
  }

  if (pathname === "/void-file/place-download") {
    await withFileHandler<FilePlaceDownloadData>(response, async () => {
      const body = asRecord(await readJsonBody(request));
      const taskId = readString(body, "taskId");
      const tempPath = readString(body, "tempPath");
      const destinationDirectory = readString(body, "destinationDirectory");
      if (!taskId || !tempPath || !destinationDirectory) {
        throw Object.assign(new Error("缺少 taskId / tempPath / destinationDirectory"), {
          fileCode: "INVALID_REQUEST"
        });
      }
      return fileDownloadManager.placeDownload({
        taskId,
        tempPath,
        destinationDirectory,
        fileName: readString(body, "fileName"),
        overwritePolicy: parseOverwritePolicy(body.overwritePolicy)
      });
    });
    return true;
  }

  if (pathname === "/void-file/verify") {
    await withFileHandler<FileVerifyData>(response, async () => {
      const body = asRecord(await readJsonBody(request));
      const path = readString(body, "path");
      if (!path) {
        throw Object.assign(new Error("缺少 path"), { fileCode: "INVALID_REQUEST" });
      }
      return fileDownloadManager.verify(path);
    });
    return true;
  }

  if (pathname === "/void-file/list-directory") {
    await withFileHandler<FileListDirectoryData>(response, async () => {
      const body = asRecord(await readJsonBody(request));
      const path = readString(body, "path");
      if (!path) {
        throw Object.assign(new Error("缺少 path"), { fileCode: "INVALID_REQUEST" });
      }
      return fileAccessManager.listDirectory(path);
    });
    return true;
  }

  if (pathname === "/void-file/inspect-path") {
    await withFileHandler<FileInspectPathData>(response, async () => {
      const body = asRecord(await readJsonBody(request));
      const path = readString(body, "path");
      if (!path) {
        throw Object.assign(new Error("缺少 path"), { fileCode: "INVALID_REQUEST" });
      }
      return fileAccessManager.inspectPath(path);
    });
    return true;
  }

  if (pathname === "/void-file/list-recent-artifacts") {
    await withFileHandler<FileListRecentArtifactsData>(response, async () => {
      const body = asRecord(await readJsonBody(request));
      return fileAccessManager.listRecentArtifacts(readOptionalNumber(body, "limit"));
    });
    return true;
  }

  if (pathname === "/void-file/read-text") {
    await withFileHandler<FileReadTextData>(response, async () => {
      const body = asRecord(await readJsonBody(request));
      const path = readString(body, "path");
      if (!path) {
        throw Object.assign(new Error("缺少 path"), { fileCode: "INVALID_REQUEST" });
      }
      return fileAccessManager.readText(path);
    });
    return true;
  }

  if (pathname === "/void-file/search-text") {
    await withFileHandler<FileSearchTextData>(response, async () => {
      const body = asRecord(await readJsonBody(request));
      const path = readString(body, "path");
      const query = readString(body, "query");
      if (!path || !query) {
        throw Object.assign(new Error("缺少 path 或 query"), { fileCode: "INVALID_REQUEST" });
      }
      return fileAccessManager.searchText(
        {
          path,
          query,
          caseSensitive: readOptionalBoolean(body, "caseSensitive"),
          maxResults: readOptionalNumber(body, "maxResults"),
          maxDepth: readOptionalNumber(body, "maxDepth"),
          extensions: readOptionalStringArray(body, "extensions")
        },
        createRequestAbortSignal(request, response)
      );
    });
    return true;
  }

  if (pathname === "/void-file/find-by-name") {
    await withFileHandler<FileFindByNameData>(response, async () => {
      const body = asRecord(await readJsonBody(request));
      const path = readString(body, "path");
      const query = readString(body, "query");
      if (!path || !query) {
        throw Object.assign(new Error("缺少 path 或 query"), { fileCode: "INVALID_REQUEST" });
      }
      return fileAccessManager.findByName(
        {
          path,
          query,
          caseSensitive: readOptionalBoolean(body, "caseSensitive"),
          maxResults: readOptionalNumber(body, "maxResults"),
          maxDepth: readOptionalNumber(body, "maxDepth"),
          kind: readOptionalFindByNameKind(body)
        },
        createRequestAbortSignal(request, response)
      );
    });
    return true;
  }

  if (pathname === "/void-file/create-directory") {
    await withFileHandler<FileCreateDirectoryData>(response, async () => {
      const body = asRecord(await readJsonBody(request));
      const path = readString(body, "path");
      if (!path) {
        throw Object.assign(new Error("缺少 path"), { fileCode: "INVALID_REQUEST" });
      }
      return fileMutationManager.createDirectory(path);
    });
    return true;
  }

  if (pathname === "/void-file/move") {
    await withFileHandler<FileMoveData>(response, async () => {
      const body = asRecord(await readJsonBody(request));
      const sourcePath = readString(body, "sourcePath");
      const destinationPath = readString(body, "destinationPath");
      const conflictPolicy = body.conflictPolicy === "rename" ? "rename" : "refuse";
      if (!sourcePath || !destinationPath) {
        throw Object.assign(new Error("缺少 sourcePath 或 destinationPath"), {
          fileCode: "INVALID_REQUEST"
        });
      }
      return fileMutationManager.move(sourcePath, destinationPath, conflictPolicy);
    });
    return true;
  }

  if (pathname === "/void-file/write-text") {
    await withFileHandler<FileWriteTextData>(response, async () => {
      const body = asRecord(await readJsonBody(request, 768 * 1024));
      const path = resolveTextWritePath(body);
      const content = readRawString(body, "content");
      if (content === undefined) {
        throw createInvalidFileRequest("缺少 content");
      }
      return fileMutationManager.writeText(
        path,
        content,
        body.conflictPolicy === undefined
          ? "refuse"
          : parseTextWriteConflictPolicy(body.conflictPolicy)
      );
    });
    return true;
  }

  if (pathname === "/void-file/inspect-write-target") {
    await withFileHandler<FileInspectWriteTargetData>(response, async () => {
      const body = asRecord(await readJsonBody(request));
      const path = resolveTextWritePath(body);
      return fileMutationManager.inspectTextWriteTarget(
        path,
        body.conflictPolicy === undefined
          ? "refuse"
          : parseTextWriteConflictPolicy(body.conflictPolicy)
      );
    });
    return true;
  }

  if (pathname === "/void-file/organize-directory") {
    await withFileHandler<FileOrganizeDirectoryData>(response, async () => {
      const body = asRecord(await readJsonBody(request));
      const strategyRaw = readString(body, "strategy");
      const strategy = strategyRaw === "byDate" ? "byDate" : strategyRaw === "byExtension" || !strategyRaw ? "byExtension" : undefined;
      if (strategyRaw && !strategy) {
        throw createInvalidFileRequest("strategy 必须是 byExtension | byDate");
      }
      return fileOrganizeManager.organizeDirectory({
        path: readString(body, "path"),
        dryRun: readOptionalBoolean(body, "dryRun"),
        strategy: strategy as "byExtension" | "byDate" | undefined
      });
    });
    return true;
  }

  if (pathname === "/void-file/create-excel") {
    await withFileHandler<FileCreateExcelData>(response, async () => {
      const body = asRecord(await readJsonBody(request, 2 * 1024 * 1024));
      const fileName = readString(body, "fileName");
      if (!fileName) throw createInvalidFileRequest("缺少 fileName");
      const sheetsRaw = body.sheets;
      if (!Array.isArray(sheetsRaw)) throw createInvalidFileRequest("sheets 必须是数组");
      const sheets = sheetsRaw as FileCreateExcelData["sheets"] extends Array<infer T> ? T[] : never;
      // 简化校验：sheets 结构由 fileExcelManager 深度校验
      return createExcelFile({
        fileName,
        sheets: sheets as never,
        templateId: readString(body, "templateId"),
        title: readString(body, "title")
      });
    });
    return true;
  }

  if (pathname === "/void-file/create-pptx") {
    await withFileHandler<FileCreatePptxData>(response, async () => {
      const body = asRecord(await readJsonBody(request, 2 * 1024 * 1024));
      const fileName = readString(body, "fileName");
      if (!fileName) throw createInvalidFileRequest("缺少 fileName");
      const slidesRaw = body.slides;
      if (!Array.isArray(slidesRaw)) throw createInvalidFileRequest("slides 必须是数组");
      return createPptxFile({
        fileName,
        title: readString(body, "title"),
        slides: slidesRaw as never,
        templateId: readString(body, "templateId")
      });
    });
    return true;
  }

  sendJson(response, 404, {
    ok: false,
    error: { code: "INVALID_REQUEST", message: `未知文件路由：${pathname}` }
  });
  return true;
}

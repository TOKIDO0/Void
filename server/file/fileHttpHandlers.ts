/**
 * 文件下载/落盘/校验 HTTP 路由：/void-file/*
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import {
  isInvalidJsonBody,
  isRequestBodyTooLarge,
  readJsonBody
} from "../http/httpRequest";
import { fileDownloadManager } from "./fileDownloadManager";
import { fileAccessManager } from "./fileAccessManager";
import { fileMutationManager } from "./fileMutationManager";
import { getFileErrorPayload } from "./fileRuntimePaths";
import type {
  FileApiResponse,
  FileDownloadToTempData,
  FileListDirectoryData,
  FileCreateDirectoryData,
  FileMoveData,
  FilePlaceDownloadData,
  FileReadTextData,
  FileVerifyData,
  OverwritePolicy
} from "./fileTypes";

function sendJson(response: ServerResponse, status: number, body: unknown) {
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
    const status =
      payloadError.code === "INVALID_REQUEST"
        ? 400
        : payloadError.code === "PATH_NOT_ALLOWED" || payloadError.code === "OVERWRITE_REFUSED"
          ? 403
        : payloadError.code === "FILE_NOT_FOUND"
          ? 404
          : payloadError.code === "FILE_TOO_LARGE"
            ? 413
            : payloadError.code === "INVALID_UTF8" || payloadError.code === "BINARY_FILE"
              ? 415
              : payloadError.code === "DESTINATION_EXISTS"
                ? 409
                : payloadError.code === "CROSS_DEVICE_MOVE"
                  ? 400
            : 500;
    const payload: FileApiResponse<never> = {
      ok: false,
      error: payloadError
    };
    sendJson(response, status, payload);
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

  sendJson(response, 404, {
    ok: false,
    error: { code: "INVALID_REQUEST", message: `未知文件路由：${pathname}` }
  });
  return true;
}

/**
 * 文件下载/落盘/校验 HTTP 路由：/void-file/*
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import { fileDownloadManager } from "./fileDownloadManager";
import { getFileErrorPayload } from "./fileRuntimePaths";
import type {
  FileApiResponse,
  FileDownloadToTempData,
  FilePlaceDownloadData,
  FileVerifyData,
  OverwritePolicy
} from "./fileTypes";

async function readJsonBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  const raw = Buffer.concat(chunks).toString("utf8").trim();
  if (!raw) {
    return {};
  }
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    throw Object.assign(new Error("请求体不是合法 JSON"), { fileCode: "INVALID_REQUEST" });
  }
}

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
    const payloadError = getFileErrorPayload(error);
    const status =
      payloadError.code === "INVALID_REQUEST"
        ? 400
        : payloadError.code === "PATH_NOT_ALLOWED" || payloadError.code === "OVERWRITE_REFUSED"
          ? 403
          : payloadError.code === "FILE_NOT_FOUND"
            ? 404
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

  sendJson(response, 404, {
    ok: false,
    error: { code: "INVALID_REQUEST", message: `未知文件路由：${pathname}` }
  });
  return true;
}

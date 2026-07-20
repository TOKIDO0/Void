/**
 * 官方软件安装包 HTTP 路由：/void-software/*
 * 解析与下载均在 sidecar 完成，模型不能直接指定任意下载 URL。
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import {
  isInvalidJsonBody,
  isRequestBodyTooLarge,
  readJsonBody
} from "../http/httpRequest";
import { getFileErrorPayload } from "../file/fileRuntimePaths";
import {
  getSoftwareById,
  listSoftwareCatalog,
  matchSoftwareByQuery
} from "./softwareCatalog";
import { resolveInstallerCandidate } from "./softwareSourceResolver";
import { downloadOfficialInstaller } from "./softwareSecureDownload";

// 短时 resolution 缓存：resolve → 用户确认 → download，禁止模型篡改 URL
const RESOLUTION_TTL_MS = 15 * 60 * 1000;
const resolutionStore = new Map<
  string,
  {
    softwareId: string;
    downloadUrl: string;
    sourcePageUrl: string;
    fileName?: string;
    architecture: string;
    createdAt: number;
  }
>();

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
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function purgeExpiredResolutions() {
  const now = Date.now();
  for (const [id, item] of resolutionStore) {
    if (now - item.createdAt > RESOLUTION_TTL_MS) {
      resolutionStore.delete(id);
    }
  }
}

function createResolutionId(softwareId: string) {
  return `swres_${softwareId}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

async function withHandler<T>(response: ServerResponse, work: () => Promise<T> | T) {
  try {
    const data = await work();
    sendJson(response, 200, { ok: true, data });
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
    const failureCode =
      typeof (error as { details?: { failureCode?: unknown } })?.details?.failureCode === "string"
        ? (error as { details: { failureCode: string } }).details.failureCode
        : undefined;
    const status =
      payloadError.code === "INVALID_REQUEST"
        ? 400
        : payloadError.code === "PATH_NOT_ALLOWED" || payloadError.code === "OVERWRITE_REFUSED"
          ? 403
          : payloadError.code === "FILE_TOO_LARGE"
            ? 413
            : payloadError.code === "FILE_NOT_FOUND"
              ? 404
              : 500;
    sendJson(response, status, {
      ok: false,
      error: {
        ...payloadError,
        details: {
          ...(payloadError.details ?? {}),
          ...(failureCode ? { failureCode } : {})
        }
      }
    });
  }
}

/**
 * 处理 /void-software/* 。命中返回 true。
 */
export async function handleSoftwareHttpRequest(
  request: IncomingMessage,
  response: ServerResponse,
  pathname: string
): Promise<boolean> {
  if (!pathname.startsWith("/void-software")) {
    return false;
  }

  if (request.method === "GET" && pathname === "/void-software/health") {
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

  if (pathname === "/void-software/list") {
    await withHandler(response, () => {
      const onlyReady = false;
      const softwares = listSoftwareCatalog()
        .filter((entry) => (onlyReady ? entry.readiness === "adapter_ready" : true))
        .map((entry) => ({
          softwareId: entry.softwareId,
          displayName: entry.displayName,
          aliases: entry.aliases,
          readiness: entry.readiness,
          officialPageUrls: entry.officialPageUrls
        }));
      return {
        count: softwares.length,
        softwares,
        note: "官方软件目录是开放集合；未登记软件不会自动从第三方站下载。"
      };
    });
    return true;
  }

  if (pathname === "/void-software/resolve") {
    await withHandler(response, async () => {
      purgeExpiredResolutions();
      const body = asRecord(await readJsonBody(request));
      const query = readString(body, "query");
      const softwareIdInput = readString(body, "softwareId");
      const architecture = readString(body, "architecture") || "x64";
      if (!query && !softwareIdInput) {
        throw Object.assign(new Error("缺少 query 或 softwareId"), {
          fileCode: "INVALID_REQUEST"
        });
      }

      let softwareId = softwareIdInput;
      let matchedAlias = softwareIdInput || "";
      if (!softwareId && query) {
        const match = matchSoftwareByQuery(query);
        if (match.kind === "none" || !match.entry) {
          throw Object.assign(new Error(`未登记软件「${query}」`), {
            fileCode: "DOWNLOAD_FAILED",
            details: { failureCode: "UNSUPPORTED_SOFTWARE", query }
          });
        }
        if (match.kind === "ambiguous") {
          throw Object.assign(
            new Error(
              `「${query}」匹配到多个软件：${(match.candidates || [])
                .map((item) => item.displayName)
                .join("、")}`
            ),
            {
              fileCode: "DOWNLOAD_FAILED",
              details: {
                failureCode: "AMBIGUOUS_SOFTWARE",
                candidates: (match.candidates || []).map((item) => item.softwareId)
              }
            }
          );
        }
        softwareId = match.entry.softwareId;
        matchedAlias = match.matchedAlias || match.entry.displayName;
      }

      const entry = getSoftwareById(softwareId || "");
      if (!entry) {
        throw Object.assign(new Error(`未登记软件：${softwareId}`), {
          fileCode: "DOWNLOAD_FAILED",
          details: { failureCode: "UNSUPPORTED_SOFTWARE" }
        });
      }

      if (entry.readiness !== "adapter_ready") {
        return {
          softwareId: entry.softwareId,
          displayName: entry.displayName,
          matchedAlias: matchedAlias || entry.displayName,
          readiness: entry.readiness,
          platform: "windows",
          architecture,
          officialPageUrls: entry.officialPageUrls,
          allowedDownloadDomains: entry.allowedDownloadDomains,
          resolutionId: "",
          canAutoDownload: false,
          nextStep:
            `已识别「${entry.displayName}」，但自动解析适配器未就绪。请打开官网获取官方安装包，或提供官方直链后走通用文件下载。`,
          failureCode: "ADAPTER_NOT_READY"
        };
      }

      const candidate = await resolveInstallerCandidate({
        softwareId: entry.softwareId,
        architecture
      });
      const resolutionId = createResolutionId(entry.softwareId);
      resolutionStore.set(resolutionId, {
        softwareId: entry.softwareId,
        downloadUrl: candidate.downloadUrl,
        sourcePageUrl: candidate.sourcePageUrl,
        fileName: candidate.fileName,
        architecture,
        createdAt: Date.now()
      });

      return {
        softwareId: entry.softwareId,
        displayName: entry.displayName,
        matchedAlias: matchedAlias || entry.displayName,
        readiness: entry.readiness,
        platform: "windows",
        architecture,
        officialPageUrls: entry.officialPageUrls,
        allowedDownloadDomains: entry.allowedDownloadDomains,
        resolutionId,
        canAutoDownload: true,
        sourcePageUrl: candidate.sourcePageUrl,
        // 不把完整 downloadUrl 暴露给模型做二次篡改用途；只给展示用主机信息
        downloadHost: safeHost(candidate.downloadUrl),
        fileName: candidate.fileName || "",
        nextStep: "请向用户确认后调用 software.downloadInstaller(resolutionId)。"
      };
    });
    return true;
  }

  if (pathname === "/void-software/download") {
    await withHandler(response, async () => {
      purgeExpiredResolutions();
      const body = asRecord(await readJsonBody(request));
      const taskId = readString(body, "taskId");
      const resolutionId = readString(body, "resolutionId");
      if (!taskId || !resolutionId) {
        throw Object.assign(new Error("缺少 taskId 或 resolutionId"), {
          fileCode: "INVALID_REQUEST"
        });
      }

      const resolution = resolutionStore.get(resolutionId);
      if (!resolution) {
        throw Object.assign(new Error("resolutionId 无效或已过期，请重新 resolve"), {
          fileCode: "INVALID_REQUEST",
          details: { failureCode: "UNSUPPORTED_SOFTWARE" }
        });
      }

      // 先删除再下载：一次性 resolution，禁止并发重放
      resolutionStore.delete(resolutionId);

      const entry = getSoftwareById(resolution.softwareId);
      if (!entry) {
        throw Object.assign(new Error("软件目录项已不存在"), {
          fileCode: "DOWNLOAD_FAILED",
          details: { failureCode: "UNSUPPORTED_SOFTWARE" }
        });
      }

      const destinationDirectory = readString(body, "destinationDirectory");
      const overwritePolicy =
        body.overwritePolicy === "refuse" ? "refuse" : "rename";

      const result = await downloadOfficialInstaller({
        taskId,
        entry,
        downloadUrl: resolution.downloadUrl,
        sourcePageUrl: resolution.sourcePageUrl,
        suggestedFileName: resolution.fileName,
        destinationDirectory,
        overwritePolicy
      });

      return result;
    });
    return true;
  }

  sendJson(response, 404, {
    ok: false,
    error: { code: "INVALID_REQUEST", message: `未知软件路由：${pathname}` }
  });
  return true;
}

function safeHost(urlText: string): string {
  try {
    return new URL(urlText).hostname;
  } catch {
    return "";
  }
}

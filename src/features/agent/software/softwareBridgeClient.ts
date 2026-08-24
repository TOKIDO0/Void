/**
 * 官方软件安装包 sidecar 客户端。
 * 前端工具只调这里；下载 URL 永不由模型直接传入 download。
 */

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

function createSoftwareBridgeError(
  code: string,
  message: string,
  details?: Record<string, unknown>
) {
  const error = new Error(message) as Error & {
    softwareBridgeCode: string;
    details?: Record<string, unknown>;
  };
  error.softwareBridgeCode = code;
  error.details = details;
  return error;
}

export function getSoftwareBridgeErrorInfo(error: unknown): {
  code: string;
  message: string;
  details?: Record<string, unknown>;
} {
  if (
    typeof error === "object"
    && error !== null
    && "softwareBridgeCode" in error
    && typeof (error as { softwareBridgeCode?: unknown }).softwareBridgeCode === "string"
  ) {
    const coded = error as Error & {
      softwareBridgeCode: string;
      details?: Record<string, unknown>;
    };
    return {
      code: coded.softwareBridgeCode,
      message: coded.message,
      details: coded.details
    };
  }
  if (error instanceof Error) {
    return { code: "INTERNAL_ERROR", message: error.message };
  }
  return { code: "INTERNAL_ERROR", message: "软件桥接未知错误" };
}

type BridgeResponse<T> =
  | { ok: true; data: T }
  | {
      ok: false;
      error: { code: string; message: string; details?: Record<string, unknown> };
    };

async function postSoftwareApi<T>(
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
    const message = error instanceof Error ? error.message : "无法连接软件桥接服务";
    throw createSoftwareBridgeError(
      aborted && signal?.aborted
        ? "INTERNAL_ERROR"
        : aborted
          ? "TIMEOUT"
          : "BRIDGE_UNREACHABLE",
      aborted && signal?.aborted
        ? "软件请求已取消"
        : aborted
          ? `软件桥接超时（${url}）`
          : `软件桥接不可达（${url}）：${message}`
    );
  } finally {
    clearTimeout(timeoutHandle);
    signal?.removeEventListener("abort", onCallerAbort);
  }

  let payload: BridgeResponse<T>;
  try {
    payload = (await response.json()) as BridgeResponse<T>;
  } catch {
    throw createSoftwareBridgeError(
      "INTERNAL_ERROR",
      `软件桥接返回非 JSON（HTTP ${response.status}）`
    );
  }

  if (!payload?.ok) {
    throw createSoftwareBridgeError(
      payload && "error" in payload ? payload.error.code : "INTERNAL_ERROR",
      payload && "error" in payload ? payload.error.message : "软件操作失败",
      payload && "error" in payload ? payload.error.details : undefined
    );
  }

  return payload.data;
}

export type SoftwareResolveData = {
  softwareId: string;
  displayName: string;
  matchedAlias: string;
  readiness: string;
  platform: string;
  architecture: string;
  officialPageUrls: string[];
  allowedDownloadDomains: string[];
  resolutionId: string;
  canAutoDownload: boolean;
  sourcePageUrl?: string;
  downloadHost?: string;
  fileName?: string;
  nextStep: string;
  failureCode?: string;
};

export type SoftwareDownloadData = {
  softwareId: string;
  finalPath: string;
  fileName: string;
  bytes: number;
  sha256: string;
  sourcePageUrl: string;
  finalDownloadUrl: string;
  contentType?: string;
  signatureStatus: string;
  publisher?: string;
  downloadedAt: number;
};

export async function resolveSoftwareInstaller(
  input: { query?: string; softwareId?: string; architecture?: string },
  signal?: AbortSignal
): Promise<SoftwareResolveData> {
  return postSoftwareApi<SoftwareResolveData>(
    "/void-software/resolve",
    input,
    60_000,
    signal
  );
}

export async function downloadSoftwareInstaller(
  input: {
    taskId: string;
    resolutionId: string;
    destinationDirectory?: string;
    overwritePolicy?: "refuse" | "rename";
  },
  signal?: AbortSignal
): Promise<SoftwareDownloadData> {
  // 安装包可能较大，超时放宽
  return postSoftwareApi<SoftwareDownloadData>(
    "/void-software/download",
    input,
    10 * 60_000,
    signal
  );
}

export async function listSoftwareFromBridge(
  signal?: AbortSignal
): Promise<{
  count: number;
  softwares: Array<{
    softwareId: string;
    displayName: string;
    aliases: string[];
    readiness: string;
    officialPageUrls: string[];
  }>;
  note: string;
}> {
  return postSoftwareApi("/void-software/list", {}, 15_000, signal);
}

import {
  bridgeAuthHeadersForUrl,
  isLoopbackBridgeUrl
} from "../../../lib/runtime/voidBridgeAuth";

const DEFAULT_BRIDGE_ORIGIN = "http://127.0.0.1:17872";
const SECURITY_STATUS_TIMEOUT_MS = 3000;

export type LocalRuntimeSecurityCheck = {
  id: string;
  ok: boolean;
  severity: "info" | "warning" | "danger";
  message: string;
};

export type LocalRuntimeSecurityStatusData = {
  status: "ok";
  overall: "healthy" | "attention" | "unsafe";
  inspectedAt: number;
  bridge: {
    host: string;
    port: number;
    origin: string;
    listenIsLoopback: boolean;
    tokenRequired: boolean;
    allowedOrigins: string[];
    allowedListenHosts: string[];
    allowedHostnames: string[];
    securityHeaders: string[];
    timeouts: {
      headersTimeoutMs: number;
      requestTimeoutMs: number;
      keepAliveTimeoutMs: number;
      maxHeadersCount: number;
    };
  };
  proxy: {
    requestBodyMaxBytes: number;
    maxConcurrentRequests: number;
    activeRequests: number;
  };
  browser: {
    browserReady: boolean;
    activeSessions: number;
    maxSessions: number;
    sessionIdleTtlMs: number;
    headless: boolean;
  };
  network: {
    interfaceCount: number;
    nonLoopbackAddressCount: number;
    addressCounts: {
      loopback: number;
      private: number;
      linkLocal: number;
      uniqueLocal: number;
      public: number;
      other: number;
    };
  };
  checks: LocalRuntimeSecurityCheck[];
};

type LocalRuntimeSecurityResponse =
  | { ok: true; data: LocalRuntimeSecurityStatusData }
  | { ok: false; error: { code: string; message: string; details?: Record<string, unknown> } };

function resolveBridgeOrigin(): string {
  const env = (globalThis as {
    process?: { env?: Record<string, string | undefined> };
  }).process?.env;
  const origin = env?.VOID_BRIDGE_ORIGIN?.trim();
  if (origin) {
    return origin.replace(/\/$/, "");
  }
  const port = env?.VOID_BRIDGE_PORT?.trim();
  return port ? `http://127.0.0.1:${port}` : DEFAULT_BRIDGE_ORIGIN;
}

function createSecurityBridgeError(code: string, message: string, details?: Record<string, unknown>) {
  const error = new Error(message) as Error & {
    securityBridgeCode: string;
    details?: Record<string, unknown>;
  };
  error.securityBridgeCode = code;
  error.details = details;
  return error;
}

export function getSecurityBridgeErrorInfo(error: unknown): {
  code: string;
  message: string;
  details?: Record<string, unknown>;
} {
  if (
    typeof error === "object"
    && error !== null
    && "securityBridgeCode" in error
    && typeof (error as { securityBridgeCode?: unknown }).securityBridgeCode === "string"
  ) {
    const coded = error as Error & {
      securityBridgeCode: string;
      details?: Record<string, unknown>;
    };
    return {
      code: coded.securityBridgeCode,
      message: coded.message,
      details: coded.details
    };
  }
  if (error instanceof Error) {
    return { code: "INTERNAL_ERROR", message: error.message };
  }
  return { code: "INTERNAL_ERROR", message: "本地安全自检未知错误" };
}

export async function inspectLocalRuntimeSecurity(
  signal?: AbortSignal
): Promise<LocalRuntimeSecurityStatusData> {
  const url = `${resolveBridgeOrigin()}/void-bridge/security-status`;
  if (!isLoopbackBridgeUrl(url)) {
    throw createSecurityBridgeError(
      "BRIDGE_ORIGIN_NOT_LOOPBACK",
      `本地安全自检只允许访问本机回环 bridge，当前配置不是本机地址：${url}`
    );
  }

  const timeoutController = new AbortController();
  const timeoutHandle = setTimeout(() => timeoutController.abort(), SECURITY_STATUS_TIMEOUT_MS);
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
      method: "GET",
      headers: authHeaders,
      signal: timeoutController.signal
    });
  } catch (error) {
    const aborted = timeoutController.signal.aborted;
    const message = error instanceof Error ? error.message : "无法连接本地安全自检服务";
    throw createSecurityBridgeError(
      aborted && signal?.aborted
        ? "INTERNAL_ERROR"
        : aborted
          ? "TIMEOUT"
          : "BRIDGE_UNREACHABLE",
      aborted && signal?.aborted
        ? "本地安全自检已取消"
        : aborted
          ? `本地安全自检超时（${url}）`
          : `本地安全自检不可达（${url}）：${message}`
    );
  } finally {
    clearTimeout(timeoutHandle);
    signal?.removeEventListener("abort", onCallerAbort);
  }

  let payload: LocalRuntimeSecurityResponse;
  try {
    payload = (await response.json()) as LocalRuntimeSecurityResponse;
  } catch {
    throw createSecurityBridgeError(
      "INTERNAL_ERROR",
      `本地安全自检返回非 JSON（HTTP ${response.status}）`
    );
  }

  if (!response.ok || !payload?.ok) {
    throw createSecurityBridgeError(
      payload && "error" in payload ? payload.error.code : "INTERNAL_ERROR",
      payload && "error" in payload ? payload.error.message : "本地安全自检失败",
      payload && "error" in payload ? payload.error.details : undefined
    );
  }

  return payload.data;
}

/**
 * VOID 模型 / 语音 HTTP 转发的共享实现。
 *
 * 原逻辑内联在 vite.config.ts 的开发插件里，仅在 vite dev 环境可用。
 * 迁移到 Tauri 后，生产环境没有 vite dev，需要由独立的 sidecar 进程提供同等转发。
 * 因此把「读请求体 / 组装转发头 / 透传响应 / 错误详情」这套与运行载体无关的纯逻辑抽到此处，
 * 供 vite 插件（开发）与 sidecar 服务（生产）复用，避免两份实现分叉。
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { HttpRequestError, isRequestBodyTooLarge } from "./http/httpRequest";

/** 允许透传给上游的请求头白名单（模型 + 豆包 openspeech v3 鉴权头） */
const ALLOWED_FORWARD_HEADERS = [
  "accept",
  "authorization",
  "content-type",
  // 豆包 openspeech v3 鉴权头（STT/TTS 同一套）：App ID + Access Key + Resource ID。
  // 缺任一都会被上游判 401；App-Key 与 App-Id 为不同接口的别名，一并放行以防分叉。
  "x-api-app-key",
  "x-api-app-id",
  "x-api-access-key",
  "x-api-key",
  "x-api-request-id",
  "x-api-resource-id",
  "x-group-id",
  "anthropic-version"
];

/** 语音响应需要透传回浏览器的响应头 */
const VOICE_PASS_THROUGH_HEADERS = ["content-type", "content-length", "x-tt-logid", "x-request-id"];
const PROXY_REQUEST_BODY_MAX_BYTES = 4 * 1024 * 1024;
const PROXY_MAX_CONCURRENT_REQUESTS = readPositiveIntegerEnv(
  "VOID_PROXY_MAX_CONCURRENT_REQUESTS",
  8
);

let activeProxyRequests = 0;

export function getProxyRuntimeStatus() {
  return {
    requestBodyMaxBytes: PROXY_REQUEST_BODY_MAX_BYTES,
    maxConcurrentRequests: PROXY_MAX_CONCURRENT_REQUESTS,
    activeRequests: activeProxyRequests
  };
}

/** 读取完整请求体为 Buffer */
export function readRequestBody(
  request: IncomingMessage,
  maxBytes = PROXY_REQUEST_BODY_MAX_BYTES
): Promise<Buffer> {
  const declaredLength = Number(request.headers["content-length"]);
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    request.resume();
    return Promise.reject(
      new HttpRequestError(
        "REQUEST_BODY_TOO_LARGE",
        `代理请求体不能超过 ${maxBytes} 字节`
      )
    );
  }

  return new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let receivedBytes = 0;
    let settled = false;

    const cleanup = () => {
      request.off("data", onData);
      request.off("end", onEnd);
      request.off("error", onError);
    };

    const onData = (chunk: Buffer | string) => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      receivedBytes += buffer.length;
      if (receivedBytes > maxBytes) {
        settled = true;
        cleanup();
        request.resume();
        reject(
          new HttpRequestError(
            "REQUEST_BODY_TOO_LARGE",
            `代理请求体不能超过 ${maxBytes} 字节`
          )
        );
        return;
      }
      chunks.push(buffer);
    };

    const onEnd = () => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      resolve(Buffer.concat(chunks));
    };

    const onError = (error: Error) => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      reject(error);
    };

    request.on("data", onData);
    request.on("end", onEnd);
    request.on("error", onError);
  });
}

/** 按白名单从浏览器请求头组装转发给上游的 Headers */
export function buildForwardedHeaders(headers: IncomingMessage["headers"]): Headers {
  const forwardedHeaders = new Headers();
  for (const headerName of ALLOWED_FORWARD_HEADERS) {
    const headerValue = headers[headerName];
    if (typeof headerValue === "string") {
      forwardedHeaders.set(headerName, headerValue);
    }
  }
  return forwardedHeaders;
}

/** 把上游语音响应的关键头透传回浏览器 */
export function copyVoiceResponseHeaders(proxyResponse: Response, response: ServerResponse): void {
  for (const headerName of VOICE_PASS_THROUGH_HEADERS) {
    const headerValue = proxyResponse.headers.get(headerName);
    if (headerValue) {
      response.setHeader(headerName, headerValue);
    }
  }
}

export function isLoopbackHostname(hostname: string): boolean {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1";
}

/**
 * 模型接口 HTTP 转发：仅允许 HTTPS（或回环）目标，SSE 流式逐块透传，其余整体读回。
 * 目标地址由请求头 `x-void-target-url` 指定。
 */
export async function handleModelProxy(request: IncomingMessage, response: ServerResponse): Promise<void> {
  const parsedTargetUrl = resolveTargetUrl(request, response, "Only HTTPS model endpoints are allowed");
  if (!parsedTargetUrl) {
    return;
  }

  const releaseProxySlot = tryAcquireProxySlot(response);
  if (!releaseProxySlot) {
    return;
  }

  let clientAbort: ReturnType<typeof createClientDisconnectAbortController> | null = null;
  try {
    const requestBody = await readRequestBody(request);
    const forwardedHeaders = buildForwardedHeaders(request.headers);
    const method = request.method ?? "GET";
    clientAbort = createClientDisconnectAbortController(request, response);
    const proxyResponse = await fetch(parsedTargetUrl, {
      method,
      headers: forwardedHeaders,
      signal: clientAbort.signal,
      // GET/HEAD 不允许携带 body（undici 会直接抛错）；模型列表拉取即 GET。
      body: method === "GET" || method === "HEAD" ? undefined : requestBody
    });

    response.statusCode = proxyResponse.status;
    response.setHeader("Content-Type", proxyResponse.headers.get("content-type") ?? "application/json");

    if (proxyResponse.headers.get("content-type")?.includes("text/event-stream") && proxyResponse.body) {
      response.setHeader("Cache-Control", "no-cache");
      response.setHeader("Connection", "keep-alive");
      await streamResponseBody(proxyResponse, response);
      return;
    }

    const responseText = await proxyResponse.text();
    if (!response.destroyed && !response.writableEnded) {
      response.end(responseText);
    }
  } catch (error) {
    if (isRequestBodyTooLarge(error)) {
      respondProxyBodyTooLarge(response, error);
      return;
    }
    respondProxyError(response, error, parsedTargetUrl.toString(), "[void-model-proxy]");
  } finally {
    clientAbort?.cleanup();
    releaseProxySlot();
  }
}

/**
 * 语音接口 HTTP 转发：仅允许 HTTPS（或回环）目标，响应体逐块透传（音频/JSON 通用）。
 * 目标地址由请求头 `x-void-target-url` 指定。
 */
export async function handleVoiceProxy(request: IncomingMessage, response: ServerResponse): Promise<void> {
  const parsedTargetUrl = resolveTargetUrl(request, response, "Only HTTPS voice endpoints are allowed");
  if (!parsedTargetUrl) {
    return;
  }

  const releaseProxySlot = tryAcquireProxySlot(response);
  if (!releaseProxySlot) {
    return;
  }

  let clientAbort: ReturnType<typeof createClientDisconnectAbortController> | null = null;
  try {
    const requestBody = await readRequestBody(request);
    const forwardedHeaders = buildForwardedHeaders(request.headers);
    const method = request.method ?? "GET";
    clientAbort = createClientDisconnectAbortController(request, response);
    const proxyResponse = await fetch(parsedTargetUrl, {
      method,
      headers: forwardedHeaders,
      signal: clientAbort.signal,
      body: method === "GET" || method === "HEAD" ? undefined : requestBody
    });

    response.statusCode = proxyResponse.status;
    response.setHeader("Content-Type", proxyResponse.headers.get("content-type") ?? "application/octet-stream");
    copyVoiceResponseHeaders(proxyResponse, response);
    await streamResponseBody(proxyResponse, response);
    if (!response.destroyed && !response.writableEnded) {
      response.end();
    }
  } catch (error) {
    if (isRequestBodyTooLarge(error)) {
      respondProxyBodyTooLarge(response, error);
      return;
    }
    respondProxyError(response, error, parsedTargetUrl.toString(), "[void-voice-proxy]");
  } finally {
    clientAbort?.cleanup();
    releaseProxySlot();
  }
}

function createClientDisconnectAbortController(
  request: IncomingMessage,
  response: ServerResponse
): { signal: AbortSignal; cleanup: () => void } {
  const controller = new AbortController();
  let cleaned = false;
  const abortUpstream = () => {
    if (!cleaned) {
      controller.abort();
    }
  };
  request.on("aborted", abortUpstream);
  response.on("close", abortUpstream);
  return {
    signal: controller.signal,
    cleanup: () => {
      cleaned = true;
      request.off("aborted", abortUpstream);
      response.off("close", abortUpstream);
    }
  };
}

/** 解析并校验 `x-void-target-url` 目标地址；不合法时直接写回错误并返回 null */
function resolveTargetUrl(
  request: IncomingMessage,
  response: ServerResponse,
  protocolRejectMessage: string
): URL | null {
  const targetUrl = request.headers["x-void-target-url"];
  if (typeof targetUrl !== "string") {
    response.statusCode = 400;
    response.end("Missing target URL");
    return null;
  }

  let parsedTargetUrl: URL;
  try {
    parsedTargetUrl = new URL(targetUrl);
  } catch {
    response.statusCode = 400;
    response.end("Invalid target URL");
    return null;
  }

  if (parsedTargetUrl.protocol !== "https:" && !isLoopbackHostname(parsedTargetUrl.hostname)) {
    response.statusCode = 400;
    response.end(protocolRejectMessage);
    return null;
  }

  return parsedTargetUrl;
}

/** 把 fetch 响应体逐块写入 Node 响应（不 end，由调用方决定收尾） */
async function streamResponseBody(proxyResponse: Response, response: ServerResponse): Promise<void> {
  if (!proxyResponse.body) {
    return;
  }
  const reader = proxyResponse.body.getReader();
  try {
    while (true) {
      if (response.destroyed || response.writableEnded) {
        await reader.cancel();
        return;
      }

      const { done, value } = await reader.read();
      if (done) {
        break;
      }

      if (response.destroyed || response.writableEnded) {
        await reader.cancel();
        return;
      }

      const canContinue = response.write(Buffer.from(value));
      if (!canContinue) {
        await waitForResponseDrainOrClose(response);
      }
    }
  } finally {
    reader.releaseLock();
  }
}

function waitForResponseDrainOrClose(response: ServerResponse): Promise<void> {
  if (response.destroyed || response.writableEnded) {
    return Promise.resolve();
  }

  return new Promise((resolve) => {
    const cleanup = () => {
      response.off("drain", onDrain);
      response.off("close", onClose);
      response.off("error", onError);
      resolve();
    };
    const onDrain = () => cleanup();
    const onClose = () => cleanup();
    const onError = () => cleanup();

    response.once("drain", onDrain);
    response.once("close", onClose);
    response.once("error", onError);
  });
}

function readPositiveIntegerEnv(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) {
    return fallback;
  }
  const parsed = Number.parseInt(raw, 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function tryAcquireProxySlot(response: ServerResponse): (() => void) | null {
  if (activeProxyRequests >= PROXY_MAX_CONCURRENT_REQUESTS) {
    respondProxyBusy(response);
    return null;
  }

  activeProxyRequests += 1;
  let released = false;
  return () => {
    if (released) {
      return;
    }
    released = true;
    activeProxyRequests = Math.max(0, activeProxyRequests - 1);
  };
}

function respondProxyBusy(response: ServerResponse): void {
  if (response.destroyed || response.writableEnded) {
    return;
  }
  response.statusCode = 429;
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  response.end(JSON.stringify({
    ok: false,
    error: {
      code: "PROXY_BUSY",
      message: `本地代理并发已达上限（${PROXY_MAX_CONCURRENT_REQUESTS}）`
    }
  }));
}

/** 统一的转发失败响应：结构化错误详情 + 502 */
function respondProxyError(response: ServerResponse, error: unknown, targetUrl: string, logPrefix: string): void {
  if (response.destroyed || response.writableEnded) {
    return;
  }
  const proxyErrorDetails = buildProxyErrorDetails(error, redactProxyTargetUrl(targetUrl));
  console.error(`${logPrefix} request failed`, proxyErrorDetails);
  response.statusCode = 502;
  response.setHeader("Content-Type", "application/json");
  response.end(JSON.stringify(proxyErrorDetails));
}

function respondProxyBodyTooLarge(response: ServerResponse, error: unknown): void {
  if (response.destroyed || response.writableEnded) {
    return;
  }
  response.statusCode = 413;
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  response.end(JSON.stringify({
    ok: false,
    error: {
      code: "REQUEST_BODY_TOO_LARGE",
      message: error instanceof Error ? error.message : "代理请求体超限"
    }
  }));
}

function buildProxyErrorDetails(error: unknown, targetUrl: string) {
  if (!(error instanceof Error)) {
    return { error: "Proxy request failed", targetUrl };
  }

  const nestedCause = asErrorLike(error.cause);
  return {
    error: error.message || "Proxy request failed",
    targetUrl,
    causeName: nestedCause?.name || "",
    causeMessage: nestedCause?.message || "",
    causeCode: readErrorLikeField(nestedCause, "code"),
    causeErrno: readErrorLikeField(nestedCause, "errno"),
    causeSyscall: readErrorLikeField(nestedCause, "syscall")
  };
}

function redactProxyTargetUrl(targetUrl: string): string {
  try {
    const parsed = new URL(targetUrl);
    const querySuffix = parsed.search ? "?[redacted]" : "";
    return `${parsed.origin}${parsed.pathname}${querySuffix}`;
  } catch {
    return "[invalid-target-url]";
  }
}

function asErrorLike(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  return value as Record<string, unknown>;
}

function readErrorLikeField(errorLike: Record<string, unknown> | null, fieldName: string): string | number {
  const fieldValue = errorLike?.[fieldName];
  if (typeof fieldValue === "string" || typeof fieldValue === "number") {
    return fieldValue;
  }
  return "";
}

/**
 * VOID 模型 / 语音 HTTP 转发的共享实现。
 *
 * 原逻辑内联在 vite.config.ts 的开发插件里，仅在 vite dev 环境可用。
 * 迁移到 Tauri 后，生产环境没有 vite dev，需要由独立的 sidecar 进程提供同等转发。
 * 因此把「读请求体 / 组装转发头 / 透传响应 / 错误详情」这套与运行载体无关的纯逻辑抽到此处，
 * 供 vite 插件（开发）与 sidecar 服务（生产）复用，避免两份实现分叉。
 */
import type { IncomingMessage, ServerResponse } from "node:http";

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

/** 读取完整请求体为 Buffer */
export function readRequestBody(request: IncomingMessage): Promise<Buffer> {
  return new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => resolve(Buffer.concat(chunks)));
    request.on("error", reject);
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

  const requestBody = await readRequestBody(request);
  const forwardedHeaders = buildForwardedHeaders(request.headers);

  try {
    const proxyResponse = await fetch(parsedTargetUrl, {
      method: request.method,
      headers: forwardedHeaders,
      body: requestBody
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
    response.end(responseText);
  } catch (error) {
    respondProxyError(response, error, parsedTargetUrl.toString(), "[void-model-proxy]");
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

  const requestBody = await readRequestBody(request);
  const forwardedHeaders = buildForwardedHeaders(request.headers);
  const method = request.method ?? "GET";

  try {
    const proxyResponse = await fetch(parsedTargetUrl, {
      method,
      headers: forwardedHeaders,
      body: method === "GET" || method === "HEAD" ? undefined : requestBody
    });

    response.statusCode = proxyResponse.status;
    response.setHeader("Content-Type", proxyResponse.headers.get("content-type") ?? "application/octet-stream");
    copyVoiceResponseHeaders(proxyResponse, response);
    await streamResponseBody(proxyResponse, response);
    response.end();
  } catch (error) {
    respondProxyError(response, error, parsedTargetUrl.toString(), "[void-voice-proxy]");
  }
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
  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    response.write(Buffer.from(value));
  }
}

/** 统一的转发失败响应：结构化错误详情 + 502 */
function respondProxyError(response: ServerResponse, error: unknown, targetUrl: string, logPrefix: string): void {
  const proxyErrorDetails = buildProxyErrorDetails(error, targetUrl);
  console.error(`${logPrefix} request failed`, proxyErrorDetails);
  response.statusCode = 502;
  response.setHeader("Content-Type", "application/json");
  response.end(JSON.stringify(proxyErrorDetails));
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

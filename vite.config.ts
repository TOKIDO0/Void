import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import type { IncomingMessage } from "node:http";
import { attachVoiceSttBridge } from "./server/voiceSttBridge";
import { attachVoiceTtsBridge } from "./server/voiceTtsBridge";

export default defineConfig({
  plugins: [
    react(),
    {
      name: "void-model-proxy",
      configureServer(server) {
        // 挂载豆包流式语音识别 WebSocket 桥接（/void-voice-proxy/stt）
        // 与豆包双向流式 TTS 桥接（/void-voice-proxy/tts）
        if (server.httpServer) {
          attachVoiceSttBridge(server.httpServer);
          attachVoiceTtsBridge(server.httpServer);
        }

        server.middlewares.use("/void-model-proxy", async (request, response) => {
          const targetUrl = request.headers["x-void-target-url"];
          if (typeof targetUrl !== "string") {
            response.statusCode = 400;
            response.end("Missing target URL");
            return;
          }

          let parsedTargetUrl: URL;
          try {
            parsedTargetUrl = new URL(targetUrl);
          } catch {
            response.statusCode = 400;
            response.end("Invalid target URL");
            return;
          }

          if (parsedTargetUrl.protocol !== "https:" && !isLoopbackHostname(parsedTargetUrl.hostname)) {
            response.statusCode = 400;
            response.end("Only HTTPS model endpoints are allowed");
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
              const reader = proxyResponse.body.getReader();
              while (true) {
                const { done, value } = await reader.read();
                if (done) {
                  break;
                }
                response.write(Buffer.from(value));
              }
              response.end();
              return;
            }

            const responseText = await proxyResponse.text();
            response.end(responseText);
          } catch (error) {
            const proxyErrorDetails = buildProxyErrorDetails(error, parsedTargetUrl.toString());
            console.error("[void-model-proxy] request failed", proxyErrorDetails);
            response.statusCode = 502;
            response.setHeader("Content-Type", "application/json");
            response.end(JSON.stringify(proxyErrorDetails));
          }
        });

        server.middlewares.use("/void-voice-proxy", async (request, response) => {
          const targetUrl = request.headers["x-void-target-url"];
          if (typeof targetUrl !== "string") {
            response.statusCode = 400;
            response.end("Missing target URL");
            return;
          }

          let parsedTargetUrl: URL;
          try {
            parsedTargetUrl = new URL(targetUrl);
          } catch {
            response.statusCode = 400;
            response.end("Invalid target URL");
            return;
          }

          if (parsedTargetUrl.protocol !== "https:" && !isLoopbackHostname(parsedTargetUrl.hostname)) {
            response.statusCode = 400;
            response.end("Only HTTPS voice endpoints are allowed");
            return;
          }

          const requestBody = await readRequestBody(request);
          const forwardedHeaders = buildForwardedHeaders(request.headers);

          try {
            const proxyResponse = await fetch(parsedTargetUrl, {
              method: request.method,
              headers: forwardedHeaders,
              body: request.method === "GET" || request.method === "HEAD" ? undefined : requestBody
            });

            response.statusCode = proxyResponse.status;
            response.setHeader("Content-Type", proxyResponse.headers.get("content-type") ?? "application/octet-stream");
            copyProxyResponseHeaders(proxyResponse, response);

            if (proxyResponse.body) {
              const reader = proxyResponse.body.getReader();
              while (true) {
                const { done, value } = await reader.read();
                if (done) {
                  break;
                }
                response.write(Buffer.from(value));
              }
            }

            response.end();
          } catch (error) {
            const proxyErrorDetails = buildProxyErrorDetails(error, parsedTargetUrl.toString());
            console.error("[void-voice-proxy] request failed", proxyErrorDetails);
            response.statusCode = 502;
            response.setHeader("Content-Type", "application/json");
            response.end(JSON.stringify(proxyErrorDetails));
          }
        });
      }
    }
  ]
});

function readRequestBody(request: IncomingMessage) {
  return new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => resolve(Buffer.concat(chunks)));
    request.on("error", reject);
  });
}

function buildForwardedHeaders(headers: Record<string, string | string[] | undefined>) {
  const forwardedHeaders = new Headers();
  const allowedHeaders = [
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

  for (const headerName of allowedHeaders) {
    const headerValue = headers[headerName];
    if (typeof headerValue === "string") {
      forwardedHeaders.set(headerName, headerValue);
    }
  }

  return forwardedHeaders;
}

function copyProxyResponseHeaders(proxyResponse: Response, response: NodeJS.WritableStream & {
  setHeader(name: string, value: string): void;
}) {
  const passThroughHeaders = [
    "content-type",
    "content-length",
    "x-tt-logid",
    "x-request-id"
  ];

  for (const headerName of passThroughHeaders) {
    const headerValue = proxyResponse.headers.get(headerName);
    if (headerValue) {
      response.setHeader(headerName, headerValue);
    }
  }
}

function isLoopbackHostname(hostname: string) {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1";
}

function buildProxyErrorDetails(error: unknown, targetUrl: string) {
  if (!(error instanceof Error)) {
    return {
      error: "Proxy request failed",
      targetUrl
    };
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

function asErrorLike(value: unknown) {
  if (!value || typeof value !== "object") {
    return null;
  }

  return value as Record<string, unknown>;
}

function readErrorLikeField(errorLike: Record<string, unknown> | null, fieldName: string) {
  const fieldValue = errorLike?.[fieldName];
  if (typeof fieldValue === "string" || typeof fieldValue === "number") {
    return fieldValue;
  }

  return "";
}

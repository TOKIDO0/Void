import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import type { IncomingMessage } from "node:http";

export default defineConfig({
  plugins: [
    react(),
    {
      name: "void-model-proxy",
      configureServer(server) {
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

          if (parsedTargetUrl.protocol !== "https:" && parsedTargetUrl.hostname !== "localhost") {
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
            const responseText = await proxyResponse.text();

            response.statusCode = proxyResponse.status;
            response.setHeader("Content-Type", proxyResponse.headers.get("content-type") ?? "application/json");
            response.end(responseText);
          } catch (error) {
            response.statusCode = 502;
            response.setHeader("Content-Type", "application/json");
            response.end(JSON.stringify({
              error: error instanceof Error ? error.message : "Model proxy request failed"
            }));
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
  const allowedHeaders = ["authorization", "content-type", "x-api-key", "anthropic-version"];

  for (const headerName of allowedHeaders) {
    const headerValue = headers[headerName];
    if (typeof headerValue === "string") {
      forwardedHeaders.set(headerName, headerValue);
    }
  }

  return forwardedHeaders;
}

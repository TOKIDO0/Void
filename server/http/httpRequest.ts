import type { IncomingMessage } from "node:http";

export const JSON_BODY_MAX_BYTES = 64 * 1024;

export class HttpRequestError extends Error {
  constructor(
    public readonly code: "INVALID_JSON" | "REQUEST_BODY_TOO_LARGE",
    message: string
  ) {
    super(message);
    this.name = "HttpRequestError";
  }
}

/**
 * 统一读取工具路由 JSON。达到上限后立即停止累积，继续排空 socket 数据，
 * 让 handler 能稳定返回 413，而不是因连接被强制销毁丢失错误响应。
 */
export function readJsonBody(
  request: IncomingMessage,
  maxBytes = JSON_BODY_MAX_BYTES
): Promise<unknown> {
  const declaredLength = Number(request.headers["content-length"]);
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    request.resume();
    return Promise.reject(
      new HttpRequestError(
        "REQUEST_BODY_TOO_LARGE",
        `JSON 请求体不能超过 ${maxBytes} 字节`
      )
    );
  }

  return new Promise((resolve, reject) => {
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
            `JSON 请求体不能超过 ${maxBytes} 字节`
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
      const raw = Buffer.concat(chunks).toString("utf8").trim();
      if (!raw) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(raw) as unknown);
      } catch {
        reject(new HttpRequestError("INVALID_JSON", "请求体不是合法 JSON"));
      }
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

export function isRequestBodyTooLarge(error: unknown): boolean {
  return error instanceof HttpRequestError && error.code === "REQUEST_BODY_TOO_LARGE";
}

export function isInvalidJsonBody(error: unknown): boolean {
  return error instanceof HttpRequestError && error.code === "INVALID_JSON";
}

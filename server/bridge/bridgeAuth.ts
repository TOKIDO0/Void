import { timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";

export const BRIDGE_TOKEN_HEADER = "x-void-bridge-token";

export function readConfiguredBridgeToken(): string {
  return process.env.VOID_BRIDGE_TOKEN?.trim() ?? "";
}

export function isBridgeTokenRequired(): boolean {
  return readConfiguredBridgeToken().length > 0;
}

export function isBridgeTokenAccepted(request: IncomingMessage): boolean {
  const expected = readConfiguredBridgeToken();
  if (!expected) {
    return true;
  }

  const provided = request.headers[BRIDGE_TOKEN_HEADER];
  if (Array.isArray(provided) || typeof provided !== "string") {
    return false;
  }

  const expectedBuffer = Buffer.from(expected, "utf8");
  const providedBuffer = Buffer.from(provided.trim(), "utf8");
  if (expectedBuffer.length !== providedBuffer.length) {
    return false;
  }
  return timingSafeEqual(expectedBuffer, providedBuffer);
}

export function sendBridgeAuthReject(response: ServerResponse): void {
  response.statusCode = 403;
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  response.end(JSON.stringify({
    ok: false,
    error: {
      code: "BRIDGE_TOKEN_FORBIDDEN",
      message: "本地 bridge token 缺失或无效"
    }
  }));
}

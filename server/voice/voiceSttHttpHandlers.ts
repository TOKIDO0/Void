import type { IncomingMessage, ServerResponse } from "node:http";
import { getVoiceSttEngineStatus } from "./voiceSttEngine";
import { VOICE_STT_MODEL_NAME, resolveVoiceSttModelDir } from "./voiceSttModelManager";
import { issueVoiceSttTicket } from "./voiceSttTicketStore";

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  response.statusCode = status;
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  response.end(JSON.stringify(body));
}

/**
 * /void-voice/* 本地语音路由。
 * 到达这里之前，server 已完成 Host/Origin/bridge token 校验。
 */
export async function handleVoiceSttHttpRequest(
  request: IncomingMessage,
  response: ServerResponse,
  pathname: string
): Promise<boolean> {
  if (!pathname.startsWith("/void-voice")) {
    return false;
  }

  if (pathname === "/void-voice/stt/ticket") {
    if (request.method !== "POST") {
      sendJson(response, 405, { ok: false, error: { code: "INVALID_REQUEST", message: "仅支持 POST" } });
      return true;
    }
    const ticket = issueVoiceSttTicket();
    if (!ticket) {
      sendJson(response, 429, {
        ok: false,
        error: { code: "LOCAL_STT_BUSY", message: "取票过于频繁，请稍后重试。" }
      });
      return true;
    }
    sendJson(response, 200, {
      ok: true,
      data: {
        ...ticket,
        mode: "local",
        model: VOICE_STT_MODEL_NAME,
        modelDir: resolveVoiceSttModelDir()
      }
    });
    return true;
  }

  if (pathname === "/void-voice/stt/status") {
    if (request.method !== "GET") {
      sendJson(response, 405, { ok: false, error: { code: "INVALID_REQUEST", message: "仅支持 GET" } });
      return true;
    }
    sendJson(response, 200, { ok: true, data: getVoiceSttEngineStatus() });
    return true;
  }

  sendJson(response, 404, {
    ok: false,
    error: { code: "INVALID_REQUEST", message: `未知语音路由：${pathname}` }
  });
  return true;
}

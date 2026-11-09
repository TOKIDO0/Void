import type { IncomingMessage, ServerResponse } from "node:http";
import { isInvalidJsonBody, isRequestBodyTooLarge, readJsonBody } from "../http/httpRequest";
import { getVoiceSttEngineStatus } from "./voiceSttEngine";
import { VOICE_STT_MODEL_NAME, resolveVoiceSttModelDir } from "./voiceSttModelManager";
import { issueVoiceSttTicket } from "./voiceSttTicketStore";
import { getVoiceTtsEngineStatus, synthesizeLocalTts, VoiceTtsEngineError } from "./voiceTtsEngine";

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  response.statusCode = status;
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  response.end(JSON.stringify(body));
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
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

  if (pathname === "/void-voice/tts") {
    if (request.method !== "POST") {
      sendJson(response, 405, { ok: false, error: { code: "INVALID_REQUEST", message: "仅支持 POST" } });
      return true;
    }

    // 客户端断开（barge-in / 换回合 / 关窗口）时取消排队与合成中的任务，
    // 避免长句继续占用 worker 队列。
    const abortController = new AbortController();
    const abortOnDisconnect = () => abortController.abort();
    request.on("aborted", abortOnDisconnect);
    response.on("close", abortOnDisconnect);

    try {
      try {
        const body = asRecord(await readJsonBody(request));
        const text = typeof body.text === "string" ? body.text.trim() : "";
        const voice = typeof body.voice === "number" ? body.voice : undefined;
        const audio = await synthesizeLocalTts(text, voice, abortController.signal);
        if (abortController.signal.aborted || response.destroyed) {
          return true;
        }
        response.statusCode = 200;
        response.setHeader("Content-Type", `audio/L16; rate=${audio.sampleRate}; channels=1`);
        response.setHeader("X-VOID-TTS-Sample-Rate", String(audio.sampleRate));
        response.setHeader("X-VOID-TTS-Provider", audio.provider);
        response.setHeader("Content-Length", String(audio.pcm.length));
        response.end(audio.pcm);
      } catch (error) {
        if (abortController.signal.aborted || response.destroyed) {
          return true;
        }
        if (isRequestBodyTooLarge(error)) {
          sendJson(response, 413, { ok: false, error: { code: "REQUEST_BODY_TOO_LARGE", message: (error as Error).message } });
          return true;
        }
        if (isInvalidJsonBody(error)) {
          sendJson(response, 400, { ok: false, error: { code: "INVALID_REQUEST", message: (error as Error).message } });
          return true;
        }
        if (error instanceof VoiceTtsEngineError) {
          const status = error.code === "LOCAL_TTS_TEXT_INVALID"
            ? 400
            : error.code === "LOCAL_TTS_BUSY"
              ? 429
              : error.code === "LOCAL_TTS_ABORTED"
                ? 499
                : error.code === "LOCAL_TTS_MODEL_MISSING" || error.code === "LOCAL_TTS_MODEL_INVALID" || error.code === "LOCAL_TTS_ENGINE_INIT_FAILED"
                  ? 503
                  : 500;
          sendJson(response, status, { ok: false, error: { code: error.code, message: error.message } });
          return true;
        }
        sendJson(response, 500, { ok: false, error: { code: "LOCAL_TTS_GENERATE_FAILED", message: "本地语音合成失败。" } });
      }
    } finally {
      request.off("aborted", abortOnDisconnect);
      response.off("close", abortOnDisconnect);
    }
    return true;
  }

  if (pathname === "/void-voice/tts/status") {
    if (request.method !== "GET") {
      sendJson(response, 405, { ok: false, error: { code: "INVALID_REQUEST", message: "仅支持 GET" } });
      return true;
    }
    sendJson(response, 200, { ok: true, data: getVoiceTtsEngineStatus() });
    return true;
  }

  sendJson(response, 404, {
    ok: false,
    error: { code: "INVALID_REQUEST", message: `未知语音路由：${pathname}` }
  });
  return true;
}

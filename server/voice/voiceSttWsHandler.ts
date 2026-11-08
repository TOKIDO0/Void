import type { Server } from "node:http";
import { WebSocketServer, WebSocket } from "ws";
import { isLoopbackHostHeader } from "../bridge/bridgeAuth";
import {
  acquireVoiceSttSession,
  releaseVoiceSttSession,
  VoiceSttEngineError,
  type VoiceSttSession
} from "./voiceSttEngine";
import { consumeVoiceSttTicket } from "./voiceSttTicketStore";

const WS_PATH = "/void-voice/stt";
const MAX_PAYLOAD_BYTES = 1_000_000;

type AttachOptions = {
  allowedOrigins: ReadonlySet<string>;
};

type ClientMessage =
  | { type: "start"; sampleRate?: number; format?: string }
  | { type: "audio"; audioBase64?: string }
  | { type: "commit" }
  | { type: "stop" };

/**
 * /void-voice/stt 的 WS upgrade。
 * 鉴权只靠单次票据；Host 必须回环，Origin 必须在 allowlist（无 Origin 的本地脚本允许）。
 * 不读取/记录音频内容。
 */
export function attachVoiceSttWebSocket(server: Server, options: AttachOptions): void {
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_PAYLOAD_BYTES });

  server.on("upgrade", (request, socket, head) => {
    const requestUrl = parseRequestUrl(request.url);
    if (!requestUrl || requestUrl.pathname !== WS_PATH) {
      return;
    }
    if (!isLoopbackHostHeader(request.headers.host)) {
      rejectUpgrade(socket, 403, "Forbidden");
      return;
    }
    const origin = request.headers.origin;
    if (origin && !options.allowedOrigins.has(origin)) {
      rejectUpgrade(socket, 403, "Forbidden");
      return;
    }
    const ticket = requestUrl.searchParams.get("ticket")?.trim() ?? "";
    if (!ticket || !consumeVoiceSttTicket(ticket)) {
      rejectUpgrade(socket, 401, "Unauthorized");
      return;
    }
    wss.handleUpgrade(request, socket, head, (ws) => handleConnection(ws));
  });

  server.on("close", () => {
    wss.close();
  });
}

function handleConnection(ws: WebSocket): void {
  let session: VoiceSttSession | null = null;
  let started = false;
  let released = false;

  const cleanup = () => {
    if (released) {
      return;
    }
    released = true;
    releaseVoiceSttSession(session);
    session = null;
  };

  const send = (payload: unknown): void => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(payload));
    }
  };

  const sendError = (error: unknown): void => {
    if (error instanceof VoiceSttEngineError) {
      send({ type: "error", code: error.code, message: error.message, recoverable: error.recoverable });
      return;
    }
    send({ type: "error", code: "LOCAL_STT_INTERNAL", message: "本地语音识别失败。", recoverable: false });
  };

  ws.on("message", (data) => {
    let message: ClientMessage;
    try {
      message = JSON.parse(String(data)) as ClientMessage;
    } catch {
      return;
    }

    if (message.type === "start") {
      if (started) {
        return;
      }
      if (message.sampleRate !== undefined && message.sampleRate !== 16000) {
        send({ type: "error", code: "LOCAL_STT_INVALID_AUDIO", message: "仅支持 16kHz 音频。", recoverable: false });
        cleanup();
        ws.close();
        return;
      }
      if (message.format !== undefined && message.format !== "pcm_s16le") {
        send({ type: "error", code: "LOCAL_STT_INVALID_AUDIO", message: "仅支持 pcm_s16le。", recoverable: false });
        cleanup();
        ws.close();
        return;
      }
      void (async () => {
        try {
          session = await acquireVoiceSttSession({
            onPartial: (text) => send({ type: "partial", text, isInterim: true }),
            onFinal: (text) => send({ type: "final", text })
          });
          // acquire 期间客户端可能已断开：必须自己释放，避免 activeSessions 泄漏。
          if (released || ws.readyState !== WebSocket.OPEN) {
            releaseVoiceSttSession(session);
            session = null;
            return;
          }
          started = true;
          send({ type: "ready" });
        } catch (error) {
          sendError(error);
          cleanup();
          ws.close();
        }
      })();
      return;
    }

    if (!started || !session) {
      send({ type: "error", code: "LOCAL_STT_NOT_READY", message: "语音会话未就绪。", recoverable: false });
      return;
    }

    if (message.type === "audio") {
      try {
        session.acceptPcm16Base64(message.audioBase64 ?? "");
      } catch (error) {
        sendError(error);
        cleanup();
        ws.close();
      }
      return;
    }

    if (message.type === "commit") {
      session.commit();
      return;
    }

    if (message.type === "stop") {
      cleanup();
      ws.close();
    }
  });

  ws.on("close", cleanup);
  ws.on("error", cleanup);
}

function parseRequestUrl(rawUrl: string | undefined): URL | null {
  try {
    return new URL(rawUrl ?? "", "http://127.0.0.1");
  } catch {
    return null;
  }
}

function rejectUpgrade(socket: import("node:stream").Duplex, status: number, text: string): void {
  try {
    socket.write(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
  } catch {
    // 忽略写失败，直接销毁。
  }
  socket.destroy();
}

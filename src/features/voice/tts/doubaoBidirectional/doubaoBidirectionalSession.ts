/**
 * 豆包双向 TTS 浏览器侧 PCM 会话。
 * 会话创建即预连接；音频帧通过 ReadableStream 直接进入 AudioWorklet，
 * finish/done 只负责排空收尾，不再决定何时开始播放。
 */
import { createNetworkError } from "../../../../lib/model-providers/providerErrors";
import {
  MANAGED_VOICE_PROXY_TTS_PATH,
  MANAGED_VOICE_PROXY_WS_ORIGIN
} from "../../voiceProviderConfig";
import type { DoubaoBidirectionalAudioParams } from "./doubaoBidirectionalProtocol";
import {
  isDoubaoBidirectionalServerEvent,
  type DoubaoBidirectionalClientEvent
} from "./doubaoBidirectionalProtocol";

const HANDSHAKE_TIMEOUT_MS = 10_000;
const COMPLETE_TIMEOUT_MS = 60_000;

export type DoubaoBidirectionalSessionConfig = {
  speaker: string;
  audioParams: DoubaoBidirectionalAudioParams;
};

export type BidirectionalStreamHandlers = {
  onPcmStreamReady: (
    stream: ReadableStream<Uint8Array>,
    sampleRate: number,
    sessionId: string
  ) => void | Promise<void>;
  onError?: (error: unknown) => void;
};

export type BidirectionalStreamSession = {
  pushText(text: string): void;
  complete(): Promise<void>;
};

export function openBidirectionalStreamSession(
  config: DoubaoBidirectionalSessionConfig,
  handlers: BidirectionalStreamHandlers,
  signal?: AbortSignal
): BidirectionalStreamSession {
  const bridgeUrl = resolveBridgeUrl();
  const sessionId = crypto.randomUUID();
  const createdAt = performance.now();
  const pendingTexts: string[] = [];
  let websocket: WebSocket | null = null;
  let streamController: ReadableStreamDefaultController<Uint8Array> | null = null;
  let handshakeReady = false;
  let finishSent = false;
  let completeRequested = false;
  let settled = false;
  let pushedAnyText = false;
  let audioChunkCount = 0;
  let firstTextAt = 0;
  let firstAudioAt = 0;
  let handshakeTimer = 0;
  let completeTimer = 0;
  let resolveComplete: (() => void) | null = null;

  const pcmStream = new ReadableStream<Uint8Array>({
    start(controller) {
      streamController = controller;
    },
    cancel() {
      if (!settled) {
        settleFailure(new DOMException("The operation was aborted.", "AbortError"));
      }
    }
  });
  const completePromise = new Promise<void>((resolve) => {
    resolveComplete = resolve;
  });

  const cleanup = () => {
    window.clearTimeout(handshakeTimer);
    window.clearTimeout(completeTimer);
    signal?.removeEventListener("abort", onAbort);
    const currentSocket = websocket;
    websocket = null;
    if (currentSocket && currentSocket.readyState < WebSocket.CLOSING) {
      try { currentSocket.close(); } catch { /* 已关闭 */ }
    }
  };

  const closeStream = () => {
    if (!streamController) return;
    try { streamController.close(); } catch { /* 已结算 */ }
    streamController = null;
  };

  const errorStream = (error: unknown) => {
    if (!streamController) return;
    try { streamController.error(error); } catch { /* 已结算 */ }
    streamController = null;
  };

  const settleSuccess = () => {
    if (settled) return;
    settled = true;
    closeStream();
    cleanup();
    resolveComplete?.();
  };

  const settleFailure = (error: unknown) => {
    if (settled) return;
    settled = true;
    errorStream(error);
    cleanup();
    handlers.onError?.(error);
    // 语音是 best-effort；失败必须结算，不能永久锁住文本回合。
    resolveComplete?.();
  };

  const onAbort = () => {
    settleFailure(new DOMException("The operation was aborted.", "AbortError"));
  };
  signal?.addEventListener("abort", onAbort, { once: true });

  const send = (event: DoubaoBidirectionalClientEvent) => {
    if (websocket?.readyState === WebSocket.OPEN) {
      websocket.send(JSON.stringify(event));
    }
  };

  const flushPendingTexts = () => {
    while (pendingTexts.length > 0) {
      const text = pendingTexts.shift();
      if (text) send({ type: "text", text });
    }
    if (completeRequested && !finishSent) {
      finishSent = true;
      send({ type: "finish" });
    }
  };

  const openSocket = () => {
    if (settled || signal?.aborted) return;
    try {
      websocket = new WebSocket(bridgeUrl);
    } catch (error) {
      settleFailure(createNetworkError("托管 TTS 服务连接失败。", bridgeUrl, error));
      return;
    }

    handshakeTimer = window.setTimeout(() => {
      settleFailure(createNetworkError(
        `豆包 TTS 握手超时（${HANDSHAKE_TIMEOUT_MS}ms）。`,
        bridgeUrl
      ));
    }, HANDSHAKE_TIMEOUT_MS);

    websocket.addEventListener("open", () => {
      if (import.meta.env.DEV) {
        console.info("[VOID TTS latency] websocket_open", {
          sessionId,
          elapsedMs: Math.round(performance.now() - createdAt)
        });
      }
      send({
        type: "start",
        speaker: config.speaker,
        audioParams: config.audioParams
      });
    });

    websocket.addEventListener("message", (messageEvent) => {
      let payload: unknown;
      try {
        payload = JSON.parse(String(messageEvent.data));
      } catch {
        return;
      }
      if (!isDoubaoBidirectionalServerEvent(payload)) return;

      if (payload.type === "ready") {
        handshakeReady = true;
        window.clearTimeout(handshakeTimer);
        if (import.meta.env.DEV) {
          console.info("[VOID TTS latency] bridge_ready", {
            sessionId,
            elapsedMs: Math.round(performance.now() - createdAt)
          });
        }
        flushPendingTexts();
        return;
      }

      if (payload.type === "audio") {
        const chunk = base64ToBytes(payload.audioBase64);
        if (!chunk.length || !streamController) return;
        audioChunkCount += 1;
        if (!firstAudioAt) {
          firstAudioAt = performance.now();
          if (import.meta.env.DEV) {
            console.info("[VOID TTS latency] first_audio", {
              sessionId,
              fromSessionMs: Math.round(firstAudioAt - createdAt),
              fromFirstTextMs: firstTextAt ? Math.round(firstAudioAt - firstTextAt) : null
            });
          }
        }
        streamController.enqueue(chunk);
        return;
      }

      if (payload.type === "done") {
        if (import.meta.env.DEV) {
          console.info("[VOID TTS latency] done", {
            sessionId,
            chunks: audioChunkCount,
            elapsedMs: Math.round(performance.now() - createdAt)
          });
        }
        if (!audioChunkCount) {
          settleFailure(createNetworkError(
            "豆包 TTS 合成完成但未返回 PCM 音频，请检查音色与资源配置。",
            bridgeUrl
          ));
          return;
        }
        settleSuccess();
        return;
      }

      if (payload.type === "error") {
        settleFailure(createNetworkError(payload.message, bridgeUrl));
      }
    });

    websocket.addEventListener("error", () => {
      // WebSocket error 没有稳定细节，统一由 close 给出 code/reason。
    });

    websocket.addEventListener("close", (event) => {
      if (settled) return;
      if (import.meta.env.DEV) {
        console.warn("[VOID TTS latency] bridge_closed", {
          sessionId,
          code: event.code,
          reason: event.reason,
          chunks: audioChunkCount,
          handshakeReady,
          finishSent
        });
      }
      if (audioChunkCount > 0) {
        // 已交付的 PCM 可正常排空；异常 close 不丢弃已经收到的声音。
        settleSuccess();
        return;
      }
      settleFailure(createNetworkError("豆包 TTS 桥接连接已关闭。", bridgeUrl));
    });
  };

  // 播放流先交给上层，再立即预连接。首个文本到来时通常已经完成部分握手。
  void Promise.resolve(
    handlers.onPcmStreamReady(pcmStream, config.audioParams.sampleRate, sessionId)
  ).catch((error) => {
    settleFailure(error);
  });
  openSocket();

  return {
    pushText(text: string) {
      const normalized = text.trim();
      if (!normalized || settled || signal?.aborted || finishSent) return;
      pushedAnyText = true;
      if (!firstTextAt) {
        firstTextAt = performance.now();
        if (import.meta.env.DEV) {
          console.info("[VOID TTS latency] first_text", {
            sessionId,
            elapsedMs: Math.round(firstTextAt - createdAt)
          });
        }
      }
      if (handshakeReady) send({ type: "text", text: normalized });
      else pendingTexts.push(normalized);
    },
    complete() {
      if (settled) return completePromise;
      completeRequested = true;
      if (!pushedAnyText) {
        settleSuccess();
        return completePromise;
      }
      completeTimer = window.setTimeout(() => {
        settleFailure(createNetworkError(
          `豆包 TTS 会话完成超时（${COMPLETE_TIMEOUT_MS}ms）。`,
          bridgeUrl
        ));
      }, COMPLETE_TIMEOUT_MS);
      if (handshakeReady && !finishSent) {
        finishSent = true;
        send({ type: "finish" });
      }
      return completePromise;
    }
  };
}

function resolveBridgeUrl() {
  return `${MANAGED_VOICE_PROXY_WS_ORIGIN}${MANAGED_VOICE_PROXY_TTS_PATH}`;
}

function base64ToBytes(base64: string) {
  const binary = window.atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

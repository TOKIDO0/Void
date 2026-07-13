/**
 * 豆包双向流式 TTS 浏览器侧会话。
 *
 * 真源链路：
 *   浏览器 --(start/text/finish JSON)--> CF Worker /tts --(二进制)--> 豆包
 *   豆包 --(音频帧)--> Worker --(ready/audio/done/error JSON)--> 浏览器
 *
 * 播放策略：
 * - 首句即可开连、边推文本边收合成（不必等整轮文字结束）。
 * - 音频侧默认整段 Blob 再播：Tauri WebView2 对 audio/mpeg MediaSource 支持不可靠，
 *   MSE 路径会出现「合成成功、play 不报错、但完全无声」。
 * - 仅在非 Tauri 且明确支持 MSE 时尝试边收边播；任何 append/init 失败立即回退 Blob。
 */
import { createNetworkError } from "../../../../lib/model-providers/providerErrors";
import { isTauriRuntime } from "../../../../lib/runtime/voidBridgeRuntime";
import {
  MANAGED_VOICE_PROXY_TTS_PATH,
  MANAGED_VOICE_PROXY_WS_ORIGIN
} from "../../voiceProviderConfig";
import type { DoubaoBidirectionalAudioParams } from "./doubaoBidirectionalProtocol";
import {
  isDoubaoBidirectionalServerEvent,
  type DoubaoBidirectionalClientEvent
} from "./doubaoBidirectionalProtocol";

const DOUBAO_TTS_AUDIO_MIME_TYPE = "audio/mpeg";
const MSE_AUDIO_MPEG = 'audio/mpeg; codecs="mp3"';

export type DoubaoBidirectionalSessionConfig = {
  speaker: string;
  audioParams: DoubaoBidirectionalAudioParams;
};

export type BidirectionalStreamHandlers = {
  /** 拿到可播放地址时回调一次（MSE 对象 URL 或最终 Blob URL） */
  onPlaybackReady: (audioUrl: string, mimeType: string) => void | Promise<void>;
  /** 合成失败；调用方 best-effort，不阻断文字 */
  onError?: (error: unknown) => void;
};

export type BidirectionalStreamSession = {
  /** 追加一句待合成文本；首句触发建连 */
  pushText(text: string): void;
  /** 声明本轮文本已结束，等待音频收尾 */
  complete(): Promise<void>;
};

/**
 * 打开可边推文本、边收音频的双向流式会话。
 * 生命周期由 pushText / complete / AbortSignal 驱动。
 */
export function openBidirectionalStreamSession(
  config: DoubaoBidirectionalSessionConfig,
  handlers: BidirectionalStreamHandlers,
  signal?: AbortSignal
): BidirectionalStreamSession {
  const bridgeUrl = resolveBridgeUrl();
  const pendingTexts: string[] = [];
  const audioChunks: Uint8Array[] = [];

  let websocket: WebSocket | null = null;
  let handshakeReady = false;
  let finishSent = false;
  let completeRequested = false;
  let settled = false;
  let playbackReadyEmitted = false;

  let mediaSource: MediaSource | null = null;
  let sourceBuffer: SourceBuffer | null = null;
  let objectUrl = "";
  // Tauri/WebView2 下 MSE mp3 不可靠，强制走整段 Blob，保证有声。
  let useMediaSource = canUseMediaSourceMpeg();
  const mseQueue: Uint8Array[] = [];
  let mseEnding = false;

  let resolveComplete: (() => void) | null = null;
  const completePromise = new Promise<void>((resolve) => {
    resolveComplete = resolve;
  });

  const cleanupSocket = () => {
    signal?.removeEventListener("abort", onAbort);
    if (!websocket) {
      return;
    }
    try {
      websocket.close();
    } catch {
      // 忽略关闭异常
    }
    websocket = null;
  };

  const settleSuccess = () => {
    if (settled) {
      return;
    }
    settled = true;
    cleanupSocket();
    resolveComplete?.();
  };

  /**
   * 已收到音频但尚未开播时，优先抢救成整段 Blob 再播。
   * 典型竞态：Worker 发完 done 后立刻关连接，浏览器 close 抢在异步结算前到达。
   * 返回 true 表示已转入成功路径，调用方不要再当失败处理。
   */
  const salvagePlaybackFromChunks = async () => {
    if (settled || signal?.aborted || playbackReadyEmitted || audioChunks.length === 0) {
      return false;
    }

    const blob = new Blob(audioChunks as BlobPart[], { type: DOUBAO_TTS_AUDIO_MIME_TYPE });
    objectUrl = URL.createObjectURL(blob);
    playbackReadyEmitted = true;
    try {
      await handlers.onPlaybackReady(objectUrl, DOUBAO_TTS_AUDIO_MIME_TYPE);
    } catch (error) {
      // 播放回调失败仍算合成已交付；错误留给播放层日志。
      console.warn("[VOID TTS] salvage playback callback failed", error);
    }
    settleSuccess();
    return true;
  };

  const settleFailure = (error: unknown) => {
    if (settled) {
      return;
    }

    // 播放已交付但 complete 尚未 settle：把 close 当成功收尾，不要刷失败日志。
    if (playbackReadyEmitted) {
      settleSuccess();
      return;
    }

    // 有音频却被 close/error 抢先：抢救播放，不报失败。
    if (
      audioChunks.length > 0
      && !(error instanceof DOMException && error.name === "AbortError")
    ) {
      void salvagePlaybackFromChunks().then((salvaged) => {
        if (!salvaged && !settled) {
          settled = true;
          cleanupSocket();
          if (objectUrl && !playbackReadyEmitted) {
            URL.revokeObjectURL(objectUrl);
            objectUrl = "";
          }
          handlers.onError?.(error);
          resolveComplete?.();
        }
      });
      return;
    }

    settled = true;
    cleanupSocket();
    if (objectUrl && !playbackReadyEmitted) {
      URL.revokeObjectURL(objectUrl);
      objectUrl = "";
    }
    handlers.onError?.(error);
    // complete() 不因合成失败 reject，避免打断文字回合；与旧 best-effort 一致。
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
      if (text) {
        send({ type: "text", text });
      }
    }
    if (completeRequested && !finishSent) {
      finishSent = true;
      send({ type: "finish" });
    }
  };

  const pumpMediaSourceQueue = () => {
    if (!sourceBuffer || sourceBuffer.updating) {
      return;
    }
    if (mseQueue.length > 0) {
      const nextChunk = mseQueue.shift();
      if (!nextChunk || nextChunk.length === 0) {
        pumpMediaSourceQueue();
        return;
      }
      try {
        // 复制为独立 ArrayBuffer，避免 SharedArrayBuffer / 视图偏移导致 appendBuffer 类型与运行时问题。
        const copy = new Uint8Array(nextChunk.byteLength);
        copy.set(nextChunk);
        sourceBuffer.appendBuffer(copy);
      } catch (error) {
        // MSE 追加失败：若尚未开播，后续改走整段 Blob。
        useMediaSource = false;
        if (!playbackReadyEmitted) {
          mediaSource = null;
          sourceBuffer = null;
          if (objectUrl) {
            URL.revokeObjectURL(objectUrl);
            objectUrl = "";
          }
        }
        console.warn("[VOID TTS] MediaSource append failed, fallback to full blob", error);
      }
      return;
    }
    if (mseEnding && mediaSource && mediaSource.readyState === "open") {
      try {
        mediaSource.endOfStream();
      } catch {
        // 忽略 endOfStream 竞态
      }
      settleSuccess();
    }
  };

  /**
   * 初始化 MediaSource；只有首块真正 append 成功后才回调 onPlaybackReady，
   * 避免 HTMLAudioElement 对空 MSE 立刻 play() 失败。
   */
  const ensureMediaSourceInitialized = () => {
    if (!useMediaSource || mediaSource || typeof MediaSource === "undefined") {
      return;
    }

    mediaSource = new MediaSource();
    objectUrl = URL.createObjectURL(mediaSource);

    mediaSource.addEventListener("sourceopen", () => {
      if (!mediaSource || sourceBuffer) {
        return;
      }
      try {
        sourceBuffer = mediaSource.addSourceBuffer(
          MediaSource.isTypeSupported(MSE_AUDIO_MPEG) ? MSE_AUDIO_MPEG : "audio/mpeg"
        );
        sourceBuffer.mode = "sequence";
        sourceBuffer.addEventListener("updateend", () => {
          // 首块写入完成后再交给播放器，降低「有 URL 但还没数据」的 play 失败率。
          if (!playbackReadyEmitted && objectUrl) {
            playbackReadyEmitted = true;
            void handlers.onPlaybackReady(objectUrl, DOUBAO_TTS_AUDIO_MIME_TYPE);
          }
          pumpMediaSourceQueue();
        });
        pumpMediaSourceQueue();
      } catch (error) {
        useMediaSource = false;
        if (objectUrl) {
          URL.revokeObjectURL(objectUrl);
          objectUrl = "";
        }
        mediaSource = null;
        sourceBuffer = null;
        console.warn("[VOID TTS] MediaSource init failed, fallback to full blob", error);
      }
    }, { once: true });
  };

  const handleAudioChunk = async (chunk: Uint8Array) => {
    if (!chunk.length || signal?.aborted) {
      return;
    }
    audioChunks.push(chunk);

    if (useMediaSource) {
      mseQueue.push(chunk);
      ensureMediaSourceInitialized();
      pumpMediaSourceQueue();
    }
  };

  const handleDone = async () => {
    if (settled) {
      return;
    }

    if (signal?.aborted) {
      settleFailure(new DOMException("The operation was aborted.", "AbortError"));
      return;
    }

    if (!audioChunks.length) {
      settleFailure(
        createNetworkError("豆包 TTS 合成完成但未返回音频，请检查 Speaker 音色 ID 是否有效。", bridgeUrl)
      );
      return;
    }

    // MSE 路径：标记结束，等 SourceBuffer 抽干后 endOfStream。
    if (useMediaSource && playbackReadyEmitted && mediaSource) {
      mseEnding = true;
      pumpMediaSourceQueue();
      return;
    }

    // 可靠路径：先同步创建 Blob URL 并标记已交付，再 await 播放回调。
    // 这样即便随后 WS close 抢到，也不会再走「桥接连接已关闭」失败分支。
    if (!playbackReadyEmitted) {
      const blob = new Blob(audioChunks as BlobPart[], { type: DOUBAO_TTS_AUDIO_MIME_TYPE });
      objectUrl = URL.createObjectURL(blob);
      playbackReadyEmitted = true;
      try {
        await handlers.onPlaybackReady(objectUrl, DOUBAO_TTS_AUDIO_MIME_TYPE);
      } catch (error) {
        console.warn("[VOID TTS] onPlaybackReady failed", error);
      }
    }
    settleSuccess();
  };

  const ensureSocket = () => {
    if (websocket || settled || signal?.aborted) {
      return;
    }

    try {
      websocket = new WebSocket(bridgeUrl);
    } catch (error) {
      settleFailure(createNetworkError("托管 TTS 服务连接失败。", bridgeUrl, error));
      return;
    }

    websocket.binaryType = "arraybuffer";

    websocket.addEventListener("open", () => {
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

      if (!isDoubaoBidirectionalServerEvent(payload)) {
        return;
      }

      if (payload.type === "ready") {
        handshakeReady = true;
        if (import.meta.env.DEV) {
          console.info("[VOID TTS] bridge ready");
        }
        flushPendingTexts();
        return;
      }

      if (payload.type === "audio") {
        void handleAudioChunk(base64ToBytes(payload.audioBase64));
        return;
      }

      if (payload.type === "done") {
        if (import.meta.env.DEV) {
          console.info("[VOID TTS] bridge done", { chunks: audioChunks.length });
        }
        void handleDone();
        return;
      }

      if (payload.type === "error") {
        settleFailure(createNetworkError(payload.message, bridgeUrl));
      }
    });

    websocket.addEventListener("error", () => {
      // error 后通常还会 close；统一交给 close 做抢救/失败结算，避免双报。
    });

    websocket.addEventListener("close", (closeEvent) => {
      if (settled) {
        return;
      }
      if (import.meta.env.DEV) {
        console.warn("[VOID TTS] bridge closed", {
          code: closeEvent.code,
          reason: closeEvent.reason,
          chunks: audioChunks.length,
          handshakeReady,
          finishSent,
          playbackReadyEmitted
        });
      }
      // 已收齐音频：优先抢救播放，不把正常收尾竞态报成失败。
      if (audioChunks.length > 0) {
        void salvagePlaybackFromChunks().then((salvaged) => {
          if (!salvaged && !settled) {
            settleFailure(createNetworkError("豆包 TTS 桥接连接已关闭。", bridgeUrl));
          }
        });
        return;
      }
      settleFailure(createNetworkError("豆包 TTS 桥接连接已关闭。", bridgeUrl));
    });
  };

  return {
    pushText(text: string) {
      const normalized = text.trim();
      if (!normalized || settled || signal?.aborted) {
        return;
      }
      ensureSocket();
      if (handshakeReady && !finishSent) {
        send({ type: "text", text: normalized });
      } else {
        pendingTexts.push(normalized);
      }
    },
    complete() {
      if (settled) {
        return completePromise;
      }
      completeRequested = true;
      // 从未推送任何文本：直接结束，避免空连接挂起。
      if (!websocket && pendingTexts.length === 0 && audioChunks.length === 0) {
        settleSuccess();
        return completePromise;
      }
      ensureSocket();
      if (handshakeReady && !finishSent) {
        finishSent = true;
        send({ type: "finish" });
      }
      return completePromise;
    }
  };
}

/**
 * 兼容旧调用：一次性喂入全部句子，等待整段结束并返回 Blob。
 * 新流式路径请用 openBidirectionalStreamSession。
 */
export function synthesizeBidirectional(
  sentences: string[],
  config: DoubaoBidirectionalSessionConfig,
  signal?: AbortSignal
): Promise<Blob> {
  const bridgeUrl = resolveBridgeUrl();

  return new Promise<Blob>((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException("The operation was aborted.", "AbortError"));
      return;
    }

    let websocket: WebSocket;
    try {
      websocket = new WebSocket(bridgeUrl);
    } catch (error) {
      reject(createNetworkError("托管 TTS 服务连接失败。", bridgeUrl, error));
      return;
    }

    websocket.binaryType = "arraybuffer";
    const audioChunks: Uint8Array[] = [];
    let settled = false;

    const cleanup = () => {
      signal?.removeEventListener("abort", onAbort);
      try {
        websocket.close();
      } catch {
        // 忽略关闭异常
      }
    };

    const settleResolve = (blob: Blob) => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      resolve(blob);
    };

    const settleReject = (error: unknown) => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      reject(error);
    };

    const onAbort = () => {
      settleReject(new DOMException("The operation was aborted.", "AbortError"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });

    const send = (event: DoubaoBidirectionalClientEvent) => {
      if (websocket.readyState === WebSocket.OPEN) {
        websocket.send(JSON.stringify(event));
      }
    };

    websocket.addEventListener("open", () => {
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

      if (!isDoubaoBidirectionalServerEvent(payload)) {
        return;
      }

      if (payload.type === "ready") {
        for (const sentence of sentences) {
          const text = sentence.trim();
          if (text) {
            send({ type: "text", text });
          }
        }
        send({ type: "finish" });
        return;
      }

      if (payload.type === "audio") {
        audioChunks.push(base64ToBytes(payload.audioBase64));
        return;
      }

      if (payload.type === "done") {
        if (!audioChunks.length) {
          settleReject(
            createNetworkError("豆包 TTS 合成完成但未返回音频，请检查 Speaker 音色 ID 是否有效。", bridgeUrl)
          );
          return;
        }
        settleResolve(new Blob(audioChunks as BlobPart[], { type: DOUBAO_TTS_AUDIO_MIME_TYPE }));
        return;
      }

      if (payload.type === "error") {
        settleReject(createNetworkError(payload.message, bridgeUrl));
      }
    });

    websocket.addEventListener("error", () => {
      settleReject(createNetworkError("托管 TTS 桥接连接失败。", bridgeUrl));
    });

    websocket.addEventListener("close", () => {
      if (!settled) {
        settleReject(createNetworkError("豆包 TTS 桥接连接已关闭。", bridgeUrl));
      }
    });
  });
}

/**
 * MSE mp3 仅在非 Tauri 浏览器里尝试。
 * WebView2 常对 audio/mpeg SourceBuffer 假支持：append 成功、play 不抛错，但扬声器无声。
 */
function canUseMediaSourceMpeg() {
  if (typeof MediaSource === "undefined") {
    return false;
  }
  if (isTauriRuntime()) {
    return false;
  }
  return MediaSource.isTypeSupported(MSE_AUDIO_MPEG) || MediaSource.isTypeSupported("audio/mpeg");
}

function resolveBridgeUrl() {
  return `${MANAGED_VOICE_PROXY_WS_ORIGIN}${MANAGED_VOICE_PROXY_TTS_PATH}`;
}

function base64ToBytes(base64: string): Uint8Array {
  const binary = window.atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

import { createNetworkError } from "../../../lib/model-providers/providerErrors";
import {
  DOUBAO_ASR_ENDPOINT,
  MANAGED_VOICE_PROXY_STT_PATH,
  MANAGED_VOICE_PROXY_WS_ORIGIN
} from "../voiceProviderConfig";
import type { VoiceInputRuntimeStatus } from "../voiceState";
import type { VoiceSttProvider, VoiceSttStartOptions } from "./voiceSttContract";
import { VoiceMicCapture } from "./voiceMicCapture";
import { RecoveryBudget } from "./recoveryBudget";
import { isVoiceSttBridgeServerEvent, type VoiceSttBridgeClientEvent } from "./voiceSttBridgeProtocol";

const STT_READY_TIMEOUT_MS = 8000;

/**
 * 托管流式 STT 客户端。
 *
 * 麦克风采集/恢复已抽到 VoiceMicCapture；本类只负责托管 Worker WS 的
 * 建连、partial/final 转发、可恢复错误重连与停止。
 */
export class DoubaoStreamingSttProvider implements VoiceSttProvider {
  private readonly endpointUrl = DOUBAO_ASR_ENDPOINT;
  private readonly bridgeUrl = resolveBridgeUrl();
  private readonly recoveryBudget = new RecoveryBudget();
  private readonly capture: VoiceMicCapture;
  private websocket: WebSocket | null = null;
  private options: VoiceSttStartOptions | null = null;
  private sessionReady = false;
  private reconnectPromise: Promise<void> | null = null;
  private stopped = true;
  private intentionalClose = false;
  private cancelPendingHandshake: (() => void) | null = null;

  constructor() {
    this.capture = new VoiceMicCapture({
      budget: this.recoveryBudget,
      microphoneErrorUrl: this.endpointUrl,
      audioWorkletErrorUrl: this.bridgeUrl
    });
  }

  async start(options: VoiceSttStartOptions) {
    this.options = options;
    this.stopped = false;
    this.intentionalClose = false;
    this.sessionReady = false;
    this.emitRuntimeStatus("starting");
    options.onInputStateChange?.("standby");

    let microphoneStream: MediaStream;
    try {
      microphoneStream = await this.capture.acquire();
    } catch (error) {
      this.emitRuntimeStatus("error");
      throw error;
    }

    if (this.stopped) {
      await this.capture.stop();
      return;
    }

    try {
      this.createWebSocket();
      await this.waitUntilSessionReady(options);
      if (this.stopped) {
        await this.capture.stop();
        return;
      }
      await this.startMicStreaming(microphoneStream, options);
      this.emitRuntimeStatus("ready");
      options.onInputStateChange?.("standby");
      options.onActivityLevelChange?.("silent");
    } catch (error) {
      await this.capture.stop();
      this.teardownSocket();
      if (this.stopped) {
        return;
      }
      this.emitRuntimeStatus("error");
      throw error;
    }
  }

  async stop() {
    if (this.stopped) {
      return;
    }
    this.stopped = true;
    this.intentionalClose = true;
    if (this.websocket?.readyState === WebSocket.OPEN) {
      this.websocket.send(JSON.stringify({ type: "stop" satisfies VoiceSttBridgeClientEvent["type"] }));
    }
    this.teardownSocket();
    await this.capture.stop();
    this.sessionReady = false;
    this.reconnectPromise = null;
    this.options?.onActivityLevelChange?.("silent");
    this.options?.onInputStateChange?.("mic_off");
    this.emitRuntimeStatus("off");
    this.options = null;
  }

  private async startMicStreaming(stream: MediaStream, options: VoiceSttStartOptions) {
    await this.capture.begin(stream, {
      onChunk: (audioBase64) => this.sendAudioChunk(audioBase64),
      onSpeechEnd: () => {
        options.onActivityLevelChange?.("silent");
        options.onInputStateChange?.("transcribing");
        this.sendCommit();
      },
      onActivityLevelChange: (level) => {
        options.onActivityLevelChange?.(level);
        if (level === "active") {
          options.onInputStateChange?.("listening");
        }
      },
      onRecovering: () => {
        this.emitRuntimeStatus("recovering");
        options.onInputStateChange?.("standby");
      },
      onRecovered: (reason) => {
        this.emitRuntimeStatus("ready");
        console.info("[VOID STT] 麦克风输入已自动恢复。", { reason });
      },
      onError: (error) => options.onError(error)
    });
  }

  private waitUntilSessionReady(options: VoiceSttStartOptions) {
    return new Promise<void>((resolve, reject) => {
      const websocket = this.websocket;
      if (!websocket) {
        reject(createNetworkError("STT 桥接连接创建失败。", this.bridgeUrl));
        return;
      }

      let settled = false;
      const readyTimer = window.setTimeout(() => {
        settleReject(createNetworkError(
          `托管 STT 握手超时（${STT_READY_TIMEOUT_MS}ms 内未收到 ready）。请检查网络与语音代理。`,
          this.bridgeUrl
        ));
      }, STT_READY_TIMEOUT_MS);

      const cleanupHandshakeListeners = () => {
        window.clearTimeout(readyTimer);
        websocket.removeEventListener("open", onOpen);
        websocket.removeEventListener("error", onError);
        if (this.cancelPendingHandshake === cancelHandshake) {
          this.cancelPendingHandshake = null;
        }
      };
      const settleResolve = () => {
        if (settled) return;
        settled = true;
        cleanupHandshakeListeners();
        this.sessionReady = true;
        resolve();
      };
      const settleReject = (error: Error) => {
        if (settled) return;
        settled = true;
        cleanupHandshakeListeners();
        this.sessionReady = false;
        reject(error);
      };
      const cancelHandshake = () => {
        settleReject(new DOMException("The operation was aborted.", "AbortError"));
      };
      this.cancelPendingHandshake?.();
      this.cancelPendingHandshake = cancelHandshake;
      const onOpen = () => {
        websocket.send(JSON.stringify({
          type: "start",
          sampleRate: 16000,
          format: "pcm_s16le"
        } satisfies VoiceSttBridgeClientEvent));
      };
      const onMessage = (event: MessageEvent) => {
        let payload: unknown;
        try {
          payload = JSON.parse(String(event.data));
        } catch {
          return;
        }
        if (!isVoiceSttBridgeServerEvent(payload)) return;
        if (payload.type === "ready") {
          settleResolve();
          return;
        }
        if (payload.type === "partial") {
          options.onPartialResult({ text: payload.text, isInterim: payload.isInterim });
          return;
        }
        if (payload.type === "final") {
          options.onFinalResult(payload.text, { commitImmediately: payload.commitImmediately === true });
          options.onInputStateChange?.("standby");
          return;
        }
        if (payload.type === "error") {
          const error = new Error(payload.message);
          if (!settled) {
            settleReject(error);
          } else if (payload.recoverable) {
            if (!this.recoveryBudget.tryConsume()) {
              options.onError(new Error(`${payload.message}，短时间内已连续自动恢复失败。`));
            } else {
              void this.reconnect(options);
            }
          } else {
            options.onError(error);
          }
        }
      };
      const onError = () => settleReject(createNetworkError("托管 STT 服务连接失败。", this.bridgeUrl));
      const onClose = (event: CloseEvent) => {
        if (websocket !== this.websocket || this.intentionalClose) return;
        if (!settled) {
          const reason = event.reason?.trim();
          settleReject(createNetworkError(
            reason
              ? `STT 桥接在就绪前关闭（${event.code}）：${reason}`
              : `STT 桥接在就绪前关闭（${event.code}）。请确认路径为 Worker /stt。`,
            this.bridgeUrl
          ));
          return;
        }
        if (this.sessionReady) {
          this.sessionReady = false;
          options.onError(createNetworkError(
            event.reason?.trim()
              ? `STT 连接已断开（${event.code}）：${event.reason}`
              : `STT 连接已断开（${event.code}）。`,
            this.bridgeUrl
          ));
        }
      };

      websocket.addEventListener("open", onOpen);
      websocket.addEventListener("message", onMessage);
      websocket.addEventListener("error", onError);
      websocket.addEventListener("close", onClose);
    });
  }

  private sendAudioChunk(audioBase64: string) {
    if (!this.websocket || !this.sessionReady || this.websocket.readyState !== WebSocket.OPEN) return;
    this.websocket.send(JSON.stringify({
      type: "audio",
      audioBase64
    } satisfies VoiceSttBridgeClientEvent));
  }

  private sendCommit() {
    if (!this.websocket || !this.sessionReady || this.websocket.readyState !== WebSocket.OPEN) return;
    this.websocket.send(JSON.stringify({ type: "commit" } satisfies VoiceSttBridgeClientEvent));
  }

  private createWebSocket() {
    this.websocket = new WebSocket(this.bridgeUrl);
  }

  private reconnect(options: VoiceSttStartOptions) {
    if (this.reconnectPromise) return this.reconnectPromise;
    this.reconnectPromise = (async () => {
      if (this.stopped) return;
      this.emitRuntimeStatus("recovering");
      const previousSocket = this.websocket;
      this.websocket = null;
      this.sessionReady = false;
      this.intentionalClose = true;
      try { previousSocket?.close(); } catch { /* 已关闭 */ }
      this.intentionalClose = false;
      try {
        if (this.stopped) return;
        this.createWebSocket();
        await this.waitUntilSessionReady(options);
        if (this.stopped) {
          this.teardownSocket();
          return;
        }
        this.emitRuntimeStatus("ready");
        console.info("[VOID STT] 上游识别会话已自动恢复。");
      } catch (error) {
        if (!this.stopped) options.onError(toError(error, "STT 自动重连失败。"));
      } finally {
        this.reconnectPromise = null;
      }
    })();
    return this.reconnectPromise;
  }

  private emitRuntimeStatus(status: VoiceInputRuntimeStatus) {
    this.options?.onRuntimeStatusChange?.(status);
  }

  private teardownSocket() {
    this.cancelPendingHandshake?.();
    const socket = this.websocket;
    this.websocket = null;
    this.sessionReady = false;
    if (!socket) return;
    this.intentionalClose = true;
    try { socket.close(); } catch { /* 忽略关闭异常 */ }
  }
}

function resolveBridgeUrl() {
  return `${MANAGED_VOICE_PROXY_WS_ORIGIN}${MANAGED_VOICE_PROXY_STT_PATH}`;
}

function toError(error: unknown, fallback: string) {
  return error instanceof Error ? error : new Error(fallback);
}

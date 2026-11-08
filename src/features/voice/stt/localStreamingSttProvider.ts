import { createNetworkError } from "../../../lib/model-providers/providerErrors";
import { resolveVoidBridgeOrigin } from "../../../lib/runtime/voidBridgeRuntime";
import type { VoiceInputRuntimeStatus } from "../voiceState";
import type { VoiceSttProvider, VoiceSttStartOptions } from "./voiceSttContract";
import { VoiceMicCapture } from "./voiceMicCapture";
import { RecoveryBudget } from "./recoveryBudget";
import { fetchVoiceSttTicket, resolveVoiceSttWsUrl } from "./voiceSttBridgeClient";
import { isVoiceSttBridgeServerEvent, type VoiceSttBridgeClientEvent } from "./voiceSttBridgeProtocol";

const STT_READY_TIMEOUT_MS = 8000;

type ServerErrorPayload = { message: string; code?: string; recoverable?: boolean };

/**
 * 本地流式 STT 客户端：麦克风复用 VoiceMicCapture，音频经本机 sidecar
 * 单次票据 WS 送入 sherpa-onnx；失败只如实报错，不自动切托管。
 */
export class LocalStreamingSttProvider implements VoiceSttProvider {
  private readonly bridgeOrigin = resolveVoidBridgeOrigin();
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
      microphoneErrorUrl: this.bridgeOrigin,
      audioWorkletErrorUrl: this.bridgeOrigin
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
      const ticket = await fetchVoiceSttTicket();
      if (this.stopped) {
        await this.capture.stop();
        return;
      }
      this.createWebSocket(ticket.ticket);
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
      onRecovering: (reason) => {
        this.emitRuntimeStatus("recovering");
        options.onInputStateChange?.("standby");
        console.info("[VOID STT] 本地麦克风输入恢复中。", { reason });
      },
      onRecovered: (reason) => {
        this.emitRuntimeStatus("ready");
        console.info("[VOID STT] 本地麦克风输入已自动恢复。", { reason });
      },
      onError: (error) => options.onError(error)
    });
  }

  private waitUntilSessionReady(options: VoiceSttStartOptions) {
    return new Promise<void>((resolve, reject) => {
      const websocket = this.websocket;
      if (!websocket) {
        reject(createNetworkError("本地 STT 连接创建失败。", this.bridgeOrigin));
        return;
      }

      let settled = false;
      const readyTimer = window.setTimeout(() => {
        settleReject(createNetworkError(
          `本地 STT 握手超时（${STT_READY_TIMEOUT_MS}ms 内未收到 ready）。`,
          this.bridgeOrigin
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
          const error = mapServerError(payload);
          if (!settled) {
            settleReject(error);
          } else if (payload.recoverable) {
            if (!this.recoveryBudget.tryConsume()) {
              options.onError(new Error(`${error.message}，短时间内已连续自动恢复失败。`));
            } else {
              void this.reconnect(options);
            }
          } else {
            options.onError(error);
          }
        }
      };
      const onError = () => settleReject(createNetworkError("本机语音服务连接失败。", this.bridgeOrigin));
      const onClose = (event: CloseEvent) => {
        if (websocket !== this.websocket || this.intentionalClose) return;
        if (!settled) {
          const reason = event.reason?.trim();
          settleReject(createNetworkError(
            reason
              ? `本地语音桥接在就绪前关闭（${event.code}）：${reason}`
              : `本地语音桥接在就绪前关闭（${event.code}）。`,
            this.bridgeOrigin
          ));
          return;
        }
        if (this.sessionReady) {
          this.sessionReady = false;
          options.onError(createNetworkError(
            event.reason?.trim()
              ? `本地语音连接已断开（${event.code}）：${event.reason}`
              : `本地语音连接已断开（${event.code}）。`,
            this.bridgeOrigin
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

  private createWebSocket(ticket: string) {
    this.websocket = new WebSocket(resolveVoiceSttWsUrl(ticket));
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
        const ticket = await fetchVoiceSttTicket();
        if (this.stopped) return;
        this.createWebSocket(ticket.ticket);
        await this.waitUntilSessionReady(options);
        if (this.stopped) {
          this.teardownSocket();
          return;
        }
        this.emitRuntimeStatus("ready");
        console.info("[VOID STT] 本地识别会话已自动恢复。");
      } catch (error) {
        if (!this.stopped) options.onError(toError(error, "本地 STT 自动重连失败。"));
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

function mapServerError(payload: ServerErrorPayload): Error {
  const message = (() => {
    switch (payload.code) {
      case "LOCAL_STT_MODEL_MISSING":
        return "本地语音模型未就绪；请安装模型，或改用托管语音。";
      case "LOCAL_STT_MODEL_INVALID":
        return "本地语音模型损坏；请重新安装模型。";
      case "LOCAL_STT_ENGINE_INIT_FAILED":
        return "本地语音引擎加载失败。";
      case "LOCAL_STT_BUSY":
        return "本地语音识别忙，请稍后重试。";
      default:
        return payload.message || "本地语音识别失败。";
    }
  })();
  return Object.assign(new Error(message), { voiceSttCode: payload.code });
}

function toError(error: unknown, fallback: string) {
  return error instanceof Error ? error : new Error(fallback);
}

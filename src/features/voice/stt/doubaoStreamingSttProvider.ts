import { createNetworkError } from "../../../lib/model-providers/providerErrors";
import {
  DOUBAO_ASR_ENDPOINT,
  MANAGED_VOICE_PROXY_STT_PATH,
  MANAGED_VOICE_PROXY_WS_ORIGIN
} from "../voiceProviderConfig";
import type { VoiceInputRuntimeStatus } from "../voiceState";
import { VoicePcmEncoder } from "./voicePcmEncoder";
import type { VoiceSttProvider, VoiceSttStartOptions } from "./voiceSttContract";
import { isVoiceSttBridgeServerEvent, type VoiceSttBridgeClientEvent } from "./voiceSttBridgeProtocol";

const STT_READY_TIMEOUT_MS = 8000;
const RECOVERABLE_ERROR_WINDOW_MS = 30_000;
const MAX_RECOVERIES_PER_WINDOW = 2;
const PCM_HEALTH_CHECK_INTERVAL_MS = 2000;
const PCM_STALL_TIMEOUT_MS = 5000;
const TRACK_MUTE_RECOVERY_DELAY_MS = 2000;

/**
 * 豆包流式 STT 客户端与麦克风生命周期的唯一 owner。
 *
 * 同一条 MediaStream 同时供 AudioWorklet 编码、本地 VAD 和 speech-end 使用；
 * 运行中通过轨道、设备、AudioContext 与 PCM 心跳恢复，禁止 UI 显示开启但实际无音频。
 */
export class DoubaoStreamingSttProvider implements VoiceSttProvider {
  private readonly endpointUrl = DOUBAO_ASR_ENDPOINT;
  private readonly bridgeUrl = resolveBridgeUrl();
  private websocket: WebSocket | null = null;
  private encoder: VoicePcmEncoder | null = null;
  private activeTrack: MediaStreamTrack | null = null;
  private options: VoiceSttStartOptions | null = null;
  private sessionReady = false;
  private reconnectPromise: Promise<void> | null = null;
  private mediaRecoveryPromise: Promise<void> | null = null;
  private stopped = true;
  private recoverableErrorCount = 0;
  private recoverableErrorWindowStartedAt = 0;
  private intentionalClose = false;
  private healthCheckTimer = 0;
  private trackMuteTimer = 0;
  private cancelPendingHandshake: (() => void) | null = null;

  async start(options: VoiceSttStartOptions) {
    this.options = options;
    this.stopped = false;
    this.intentionalClose = false;
    this.sessionReady = false;
    this.emitRuntimeStatus("starting");
    options.onInputStateChange?.("standby");

    let microphoneStream: MediaStream;
    try {
      microphoneStream = await this.requestMicrophoneStream();
    } catch (error) {
      this.emitRuntimeStatus("error");
      throw error;
    }

    if (this.stopped) {
      stopMediaStream(microphoneStream);
      return;
    }

    try {
      this.createWebSocket();
      await this.waitUntilSessionReady(options);
      if (this.stopped) {
        stopMediaStream(microphoneStream);
        return;
      }
      await this.startMediaInput(microphoneStream, options);
      this.attachRuntimeListeners();
      this.startHealthCheck();
      this.emitRuntimeStatus("ready");
      options.onInputStateChange?.("standby");
      options.onActivityLevelChange?.("silent");
    } catch (error) {
      stopMediaStream(microphoneStream);
      await this.stopMediaInput();
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
    this.detachRuntimeListeners();
    this.stopHealthCheck();
    window.clearTimeout(this.trackMuteTimer);
    if (this.websocket?.readyState === WebSocket.OPEN) {
      this.websocket.send(JSON.stringify({ type: "stop" satisfies VoiceSttBridgeClientEvent["type"] }));
    }
    this.teardownSocket();
    await this.stopMediaInput();
    this.sessionReady = false;
    this.reconnectPromise = null;
    this.mediaRecoveryPromise = null;
    this.options?.onActivityLevelChange?.("silent");
    this.options?.onInputStateChange?.("mic_off");
    this.emitRuntimeStatus("off");
    this.options = null;
  }

  private async requestMicrophoneStream() {
    try {
      return await navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: 1,
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true
        }
      });
    } catch (error) {
      throw createNetworkError("麦克风权限获取失败。", this.endpointUrl, error);
    }
  }

  private async startMediaInput(stream: MediaStream, options: VoiceSttStartOptions) {
    const track = stream.getAudioTracks()[0];
    if (!track) {
      stopMediaStream(stream);
      throw createNetworkError("没有可用的麦克风音轨。", this.endpointUrl);
    }

    this.activeTrack = track;
    track.addEventListener("ended", this.handleTrackEnded);
    track.addEventListener("mute", this.handleTrackMuted);
    track.addEventListener("unmute", this.handleTrackUnmuted);

    const encoder = new VoicePcmEncoder(stream, {
      onChunk: (chunk) => this.sendAudioChunk(chunk.audioBase64),
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
      onRuntimeStateChange: (state) => {
        if (state === "suspended" && document.visibilityState === "visible") {
          void this.resumeOrRecoverMedia("audio-context-suspended");
        }
      }
    });
    this.encoder = encoder;
    try {
      await encoder.start();
    } catch (error) {
      await encoder.stop();
      if (this.encoder === encoder) {
        this.encoder = null;
      }
      this.detachTrackListeners(track);
      this.activeTrack = null;
      throw createNetworkError("麦克风 AudioWorklet 启动失败，无法开始识别。", this.bridgeUrl, error);
    }
  }

  private async stopMediaInput() {
    const track = this.activeTrack;
    this.activeTrack = null;
    if (track) {
      this.detachTrackListeners(track);
    }
    const encoder = this.encoder;
    this.encoder = null;
    await encoder?.stop();
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
            if (!this.canRecoverAgain()) {
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

  private recoverMediaInput(reason: string) {
    if (this.mediaRecoveryPromise || this.stopped || !this.options) return this.mediaRecoveryPromise;
    if (!this.canRecoverAgain()) {
      this.options.onError(new Error(`麦克风输入连续恢复失败（${reason}）。`));
      return null;
    }
    const options = this.options;
    this.mediaRecoveryPromise = (async () => {
      this.emitRuntimeStatus("recovering");
      options.onInputStateChange?.("standby");
      try {
        await this.stopMediaInput();
        if (this.stopped) return;
        const stream = await this.requestMicrophoneStream();
        if (this.stopped) {
          stopMediaStream(stream);
          return;
        }
        await this.startMediaInput(stream, options);
        this.emitRuntimeStatus("ready");
        console.info("[VOID STT] 麦克风输入已自动恢复。", { reason });
      } catch (error) {
        if (!this.stopped) options.onError(toError(error, "麦克风输入恢复失败。"));
      } finally {
        this.mediaRecoveryPromise = null;
      }
    })();
    return this.mediaRecoveryPromise;
  }

  private async resumeOrRecoverMedia(reason: string) {
    try {
      await this.encoder?.ensureRunning();
    } catch {
      await this.recoverMediaInput(reason);
    }
  }

  private canRecoverAgain() {
    const now = Date.now();
    if (!this.recoverableErrorWindowStartedAt || now - this.recoverableErrorWindowStartedAt > RECOVERABLE_ERROR_WINDOW_MS) {
      this.recoverableErrorWindowStartedAt = now;
      this.recoverableErrorCount = 0;
    }
    this.recoverableErrorCount += 1;
    return this.recoverableErrorCount <= MAX_RECOVERIES_PER_WINDOW;
  }

  private readonly handleTrackEnded = () => { void this.recoverMediaInput("track-ended"); };
  private readonly handleTrackMuted = () => {
    window.clearTimeout(this.trackMuteTimer);
    this.trackMuteTimer = window.setTimeout(() => {
      if (this.activeTrack?.muted) void this.recoverMediaInput("track-muted");
    }, TRACK_MUTE_RECOVERY_DELAY_MS);
  };
  private readonly handleTrackUnmuted = () => { window.clearTimeout(this.trackMuteTimer); };
  private readonly handleDeviceChange = () => { void this.recoverMediaInput("device-change"); };
  private readonly handleVisibilityChange = () => {
    if (document.visibilityState === "visible") void this.resumeOrRecoverMedia("app-resumed");
  };

  private attachRuntimeListeners() {
    navigator.mediaDevices.addEventListener?.("devicechange", this.handleDeviceChange);
    document.addEventListener("visibilitychange", this.handleVisibilityChange);
  }

  private detachRuntimeListeners() {
    navigator.mediaDevices.removeEventListener?.("devicechange", this.handleDeviceChange);
    document.removeEventListener("visibilitychange", this.handleVisibilityChange);
  }

  private startHealthCheck() {
    this.stopHealthCheck();
    this.healthCheckTimer = window.setInterval(() => {
      if (
        !this.stopped
        && this.encoder
        && this.encoder.contextState === "running"
        && Date.now() - this.encoder.lastPcmChunkAt > PCM_STALL_TIMEOUT_MS
      ) {
        void this.recoverMediaInput("pcm-heartbeat-timeout");
      }
    }, PCM_HEALTH_CHECK_INTERVAL_MS);
  }

  private stopHealthCheck() {
    window.clearInterval(this.healthCheckTimer);
    this.healthCheckTimer = 0;
  }

  private detachTrackListeners(track: MediaStreamTrack) {
    track.removeEventListener("ended", this.handleTrackEnded);
    track.removeEventListener("mute", this.handleTrackMuted);
    track.removeEventListener("unmute", this.handleTrackUnmuted);
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

function stopMediaStream(stream: MediaStream) {
  stream.getTracks().forEach((track) => track.stop());
}

function toError(error: unknown, fallback: string) {
  return error instanceof Error ? error : new Error(fallback);
}

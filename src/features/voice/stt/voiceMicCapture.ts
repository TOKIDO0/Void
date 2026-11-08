import { createNetworkError } from "../../../lib/model-providers/providerErrors";
import type { VoiceActivityLevel } from "../voiceState";
import { VoicePcmEncoder } from "./voicePcmEncoder";
import { RecoveryBudget } from "./recoveryBudget";

const PCM_HEALTH_CHECK_INTERVAL_MS = 2000;
const PCM_STALL_TIMEOUT_MS = 5000;
const TRACK_MUTE_RECOVERY_DELAY_MS = 2000;

export type VoiceMicCaptureCallbacks = {
  /** 16k/s16le PCM 块（base64），由 transport 决定发往 Worker 或本机 sidecar。 */
  onChunk: (audioBase64: string) => void;
  /** 本地 VAD 判定说完；transport 负责提交当前回合。 */
  onSpeechEnd: () => void;
  onActivityLevelChange: (level: VoiceActivityLevel) => void;
  onRecovering?: (reason: string) => void;
  onRecovered?: (reason: string) => void;
  onError: (error: Error) => void;
};

type VoiceMicCaptureOptions = {
  /** 与 WS 重连共享的恢复预算。 */
  budget: RecoveryBudget;
  /** getUserMedia 失败时的错误上下文 URL。 */
  microphoneErrorUrl: string;
  /** AudioWorklet 启动失败时的错误上下文 URL。 */
  audioWorkletErrorUrl: string;
};

/**
 * 唯一麦克风采集 owner。
 *
 * 同一条 MediaStream 负责 getUserMedia、AudioWorklet 16k PCM、本地 VAD、
 * speech-end、track/设备/可见性恢复与 PCM 心跳。managed/local 两个 transport
 * 只消费 onChunk/onSpeechEnd，不再各自开麦。
 */
export class VoiceMicCapture {
  private readonly options: VoiceMicCaptureOptions;
  private acquiredStream: MediaStream | null = null;
  private activeTrack: MediaStreamTrack | null = null;
  private encoder: VoicePcmEncoder | null = null;
  private callbacks: VoiceMicCaptureCallbacks | null = null;
  private stopped = true;
  private recoveryPromise: Promise<void> | null = null;
  private globalListenersAttached = false;
  private healthCheckTimer = 0;
  private trackMuteTimer = 0;

  constructor(options: VoiceMicCaptureOptions) {
    this.options = options;
  }

  /** 开麦。必须在 transport 就绪前调用，但此时还不会推 PCM。 */
  async acquire(): Promise<MediaStream> {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: 1,
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true
        }
      });
      this.acquiredStream = stream;
      return stream;
    } catch (error) {
      throw createNetworkError("麦克风权限获取失败。", this.options.microphoneErrorUrl, error);
    }
  }

  /** transport 就绪后启动编码/监听/心跳。 */
  async begin(stream: MediaStream, callbacks: VoiceMicCaptureCallbacks): Promise<void> {
    this.callbacks = callbacks;
    this.stopped = false;

    const track = stream.getAudioTracks()[0];
    if (!track) {
      this.releaseStream(stream);
      throw createNetworkError("没有可用的麦克风音轨。", this.options.microphoneErrorUrl);
    }

    this.acquiredStream = stream;
    this.activeTrack = track;
    this.attachTrackListeners(track);

    const encoder = new VoicePcmEncoder(stream, {
      onChunk: (chunk) => callbacks.onChunk(chunk.audioBase64),
      onSpeechEnd: () => callbacks.onSpeechEnd(),
      onActivityLevelChange: (level) => callbacks.onActivityLevelChange(level),
      onRuntimeStateChange: (state) => {
        if (state === "suspended" && document.visibilityState === "visible") {
          void this.resumeOrRecover("audio-context-suspended");
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
      this.releaseStream(stream);
      throw createNetworkError("麦克风 AudioWorklet 启动失败，无法开始识别。", this.options.audioWorkletErrorUrl, error);
    }

    if (this.stopped) {
      await this.stopCurrentInput();
      return;
    }

    this.attachGlobalListeners();
    this.startHealthCheck();
  }

  /** 停止采集并释放麦克风；可重复调用。 */
  async stop(): Promise<void> {
    this.stopped = true;
    this.detachGlobalListeners();
    this.stopHealthCheck();
    window.clearTimeout(this.trackMuteTimer);
    this.trackMuteTimer = 0;
    await this.stopCurrentInput();
    this.callbacks = null;
    this.recoveryPromise = null;
  }

  /**
   * 麦克风输入恢复：track ended/mute、设备变化、页面恢复、PCM 心跳超时。
   * 与 WS 重连共用预算，避免一边重连一边反复重新开麦。
   */
  private recover(reason: string): Promise<void> | null {
    if (this.recoveryPromise || this.stopped || !this.callbacks) {
      return this.recoveryPromise;
    }
    if (!this.options.budget.tryConsume()) {
      this.callbacks.onError(new Error(`麦克风输入连续恢复失败（${reason}）。`));
      return null;
    }

    const callbacks = this.callbacks;
    this.recoveryPromise = (async () => {
      callbacks.onRecovering?.(reason);
      try {
        await this.stopCurrentInput();
        if (this.stopped) {
          return;
        }
        const stream = await this.acquire();
        if (this.stopped) {
          this.releaseStream(stream);
          return;
        }
        await this.begin(stream, callbacks);
        if (!this.stopped) {
          callbacks.onRecovered?.(reason);
        }
      } catch (error) {
        if (!this.stopped) {
          callbacks.onError(toError(error, "麦克风输入恢复失败。"));
        }
      } finally {
        this.recoveryPromise = null;
      }
    })();
    return this.recoveryPromise;
  }

  private async resumeOrRecover(reason: string): Promise<void> {
    try {
      await this.encoder?.ensureRunning();
    } catch {
      await this.recover(reason);
    }
  }

  private async stopCurrentInput(): Promise<void> {
    const track = this.activeTrack;
    this.activeTrack = null;
    if (track) {
      this.detachTrackListeners(track);
    }
    const encoder = this.encoder;
    this.encoder = null;
    await encoder?.stop();
    const stream = this.acquiredStream;
    this.acquiredStream = null;
    if (stream) {
      this.releaseStream(stream);
    }
  }

  private readonly handleTrackEnded = () => {
    void this.recover("track-ended");
  };

  private readonly handleTrackMuted = () => {
    window.clearTimeout(this.trackMuteTimer);
    this.trackMuteTimer = window.setTimeout(() => {
      if (this.activeTrack?.muted) {
        void this.recover("track-muted");
      }
    }, TRACK_MUTE_RECOVERY_DELAY_MS);
  };

  private readonly handleTrackUnmuted = () => {
    window.clearTimeout(this.trackMuteTimer);
    this.trackMuteTimer = 0;
  };

  private readonly handleDeviceChange = () => {
    void this.recover("device-change");
  };

  private readonly handleVisibilityChange = () => {
    if (document.visibilityState === "visible") {
      void this.resumeOrRecover("app-resumed");
    }
  };

  private attachGlobalListeners(): void {
    if (this.globalListenersAttached) {
      return;
    }
    this.globalListenersAttached = true;
    navigator.mediaDevices.addEventListener?.("devicechange", this.handleDeviceChange);
    document.addEventListener("visibilitychange", this.handleVisibilityChange);
  }

  private detachGlobalListeners(): void {
    if (!this.globalListenersAttached) {
      return;
    }
    this.globalListenersAttached = false;
    navigator.mediaDevices.removeEventListener?.("devicechange", this.handleDeviceChange);
    document.removeEventListener("visibilitychange", this.handleVisibilityChange);
  }

  private attachTrackListeners(track: MediaStreamTrack): void {
    track.addEventListener("ended", this.handleTrackEnded);
    track.addEventListener("mute", this.handleTrackMuted);
    track.addEventListener("unmute", this.handleTrackUnmuted);
  }

  private detachTrackListeners(track: MediaStreamTrack): void {
    track.removeEventListener("ended", this.handleTrackEnded);
    track.removeEventListener("mute", this.handleTrackMuted);
    track.removeEventListener("unmute", this.handleTrackUnmuted);
  }

  private startHealthCheck(): void {
    if (this.healthCheckTimer) {
      return;
    }
    this.healthCheckTimer = window.setInterval(() => {
      if (
        !this.stopped
        && this.encoder
        && this.encoder.contextState === "running"
        && Date.now() - this.encoder.lastPcmChunkAt > PCM_STALL_TIMEOUT_MS
      ) {
        void this.recover("pcm-heartbeat-timeout");
      }
    }, PCM_HEALTH_CHECK_INTERVAL_MS);
  }

  private stopHealthCheck(): void {
    window.clearInterval(this.healthCheckTimer);
    this.healthCheckTimer = 0;
  }

  private releaseStream(stream: MediaStream): void {
    stream.getTracks().forEach((track) => track.stop());
  }
}

function toError(error: unknown, fallback: string): Error {
  return error instanceof Error ? error : new Error(fallback);
}

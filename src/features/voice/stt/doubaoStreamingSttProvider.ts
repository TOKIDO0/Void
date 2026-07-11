import { createNetworkError } from "../../../lib/model-providers/providerErrors";
import { DOUBAO_ASR_ENDPOINT, MANAGED_VOICE_PROXY_WS_ORIGIN } from "../voiceProviderConfig";
import { VoicePcmEncoder } from "./voicePcmEncoder";
import type { VoiceSttProvider, VoiceSttStartOptions } from "./voiceSttContract";
import { isVoiceSttBridgeServerEvent, type VoiceSttBridgeClientEvent } from "./voiceSttBridgeProtocol";

// 托管 Worker 上的 STT 路径，浏览器与 Tauri 使用同一服务。
const STT_BRIDGE_PATH = "/void-voice-proxy/stt";

export class DoubaoStreamingSttProvider implements VoiceSttProvider {
  private readonly endpointUrl = DOUBAO_ASR_ENDPOINT;
  private readonly bridgeUrl: string;
  private websocket: WebSocket | null = null;
  private encoder: VoicePcmEncoder | null = null;

  constructor() {
    this.bridgeUrl = resolveBridgeUrl();
  }

  async start(options: VoiceSttStartOptions) {
    let microphoneStream: MediaStream;
    try {
      microphoneStream = await navigator.mediaDevices.getUserMedia({
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

    try {
      this.websocket = new WebSocket(this.bridgeUrl);
    } catch (error) {
      microphoneStream.getTracks().forEach((track) => track.stop());
      throw createNetworkError("托管 STT 服务连接失败。", this.bridgeUrl, error);
    }

    try {
      await new Promise<void>((resolve, reject) => {
        if (!this.websocket) {
          reject(createNetworkError("STT 桥接连接创建失败。", this.bridgeUrl));
          return;
        }

        const websocket = this.websocket;
        let didResolve = false;

        websocket.addEventListener("open", () => {
          const startEvent: VoiceSttBridgeClientEvent = {
            type: "start",
            sampleRate: 16000,
            format: "pcm_s16le"
          };
          websocket.send(JSON.stringify(startEvent));
          didResolve = true;
          resolve();
        }, { once: true });

        websocket.addEventListener("message", (event) => {
          let payload: unknown;
          try {
            payload = JSON.parse(String(event.data));
          } catch {
            return;
          }

          if (!isVoiceSttBridgeServerEvent(payload)) {
            return;
          }

          if (payload.type === "partial") {
            options.onPartialResult({
              text: payload.text,
              isInterim: payload.isInterim
            });
            return;
          }

          if (payload.type === "final") {
            options.onFinalResult(payload.text);
            return;
          }

          if (payload.type === "error") {
            options.onError(new Error(payload.message));
          }
        });

        websocket.addEventListener("error", () => {
          reject(createNetworkError("托管 STT 服务连接失败。", this.bridgeUrl));
        }, { once: true });

        websocket.addEventListener("close", () => {
          if (!didResolve) {
            reject(createNetworkError("STT 桥接连接已关闭。", this.bridgeUrl));
          }
        }, { once: true });
      });
    } catch (error) {
      microphoneStream.getTracks().forEach((track) => track.stop());
      this.websocket = null;
      throw error;
    }

    this.encoder = new VoicePcmEncoder(microphoneStream, (chunk) => {
      if (!this.websocket) {
        return;
      }

      if (this.websocket.readyState !== WebSocket.OPEN) {
        return;
      }

      const audioEvent: VoiceSttBridgeClientEvent = {
        type: "audio",
        audioBase64: chunk.audioBase64
      };
      this.websocket.send(JSON.stringify(audioEvent));
    });
  }

  async stop() {
    // 仅在连接仍打开时通知桥接收尾，避免对已关闭连接发送导致告警
    if (this.websocket?.readyState === WebSocket.OPEN) {
      this.websocket.send(JSON.stringify({ type: "stop" satisfies VoiceSttBridgeClientEvent["type"] }));
    }
    this.websocket?.close();
    this.websocket = null;
    await this.encoder?.stop();
    this.encoder = null;
  }
}

/**
 * 返回托管 STT WebSocket 地址。鉴权由 Worker Secret 注入。
 */
function resolveBridgeUrl() {
  return `${MANAGED_VOICE_PROXY_WS_ORIGIN}${STT_BRIDGE_PATH}`;
}

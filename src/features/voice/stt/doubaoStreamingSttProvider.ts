import { createNetworkError } from "../../../lib/model-providers/providerErrors";
import { DOUBAO_ASR_ENDPOINT, DOUBAO_ASR_RESOURCE_ID } from "../voiceProviderConfig";
import { VoicePcmEncoder } from "./voicePcmEncoder";
import type { VoiceSttProvider, VoiceSttStartOptions } from "./voiceSttContract";
import { isVoiceSttBridgeServerEvent, type VoiceSttBridgeClientEvent } from "./voiceSttBridgeProtocol";

type DoubaoStreamingSttProviderConfig = {
  appKey: string;
  accessKey: string;
  resourceId?: string;
  endpointUrl?: string;
};

// 桥接路径挂在 vite dev 同源上，用 location 推导，避免写死端口
const STT_BRIDGE_PATH = "/void-voice-proxy/stt";

export class DoubaoStreamingSttProvider implements VoiceSttProvider {
  private readonly appKey: string;
  private readonly accessKey: string;
  private readonly resourceId: string;
  private readonly endpointUrl: string;
  private readonly bridgeUrl: string;
  private websocket: WebSocket | null = null;
  private encoder: VoicePcmEncoder | null = null;

  constructor(config: DoubaoStreamingSttProviderConfig) {
    this.appKey = config.appKey.trim();
    this.accessKey = config.accessKey.trim();
    this.resourceId = config.resourceId?.trim() || DOUBAO_ASR_RESOURCE_ID;
    this.endpointUrl = config.endpointUrl?.trim() || DOUBAO_ASR_ENDPOINT;
    this.bridgeUrl = resolveBridgeUrl();
  }

  async start(options: VoiceSttStartOptions) {
    if (!this.appKey || !this.accessKey) {
      throw createNetworkError("Doubao 流式语音识别缺少 App ID 或 Access Token。", this.endpointUrl);
    }

    if (!import.meta.env.DEV) {
      throw createNetworkError("生产环境 STT 桥接尚未部署。", this.endpointUrl);
    }

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
      throw createNetworkError("开发环境 STT 桥接未部署，请先实现 /void-voice-proxy/stt。", this.bridgeUrl, error);
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
            appKey: this.appKey,
            accessKey: this.accessKey,
            resourceId: this.resourceId,
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
          reject(createNetworkError("开发环境 STT 桥接未部署，请先实现 /void-voice-proxy/stt。", this.bridgeUrl));
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

/** 用当前页面同源推导桥接 WebSocket 地址，避免写死开发端口 */
function resolveBridgeUrl() {
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${protocol}//${window.location.host}${STT_BRIDGE_PATH}`;
}

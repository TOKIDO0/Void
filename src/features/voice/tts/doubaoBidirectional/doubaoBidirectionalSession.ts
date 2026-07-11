/**
 * 豆包双向流式 TTS 浏览器侧会话。
 *
 * 通过开发环境桥接（server/voiceTtsBridge.ts）与豆包双向流式端点通信：
 * 一整轮回复的所有句子在**同一个 WS session** 内连续喂给豆包，豆包内部维持整段韵律，
 * 从头到尾回吐一条连续音频 —— 架构上消灭「句界」，根治多次独立合成导致的句界音调跳变。
 *
 * 播放选型 A（整段单音频）：累积所有音频块，会话结束后合成单个 Blob 返回，改动最小。
 * 上层 orchestrator 据此在 createStreamingSession 的 complete() 时单次回调播放。
 */
import { createNetworkError } from "../../../../lib/model-providers/providerErrors";
import { MANAGED_VOICE_PROXY_WS_ORIGIN } from "../../voiceProviderConfig";
import type { DoubaoBidirectionalAudioParams } from "./doubaoBidirectionalProtocol";
import {
  isDoubaoBidirectionalServerEvent,
  type DoubaoBidirectionalClientEvent
} from "./doubaoBidirectionalProtocol";

// 托管 Worker 上的 TTS 路径，浏览器与 Tauri 使用同一服务。
const TTS_BRIDGE_PATH = "/void-voice-proxy/tts";
// 双向流式回吐 mp3 音频（与 StartSession audio_params.format 一致）
const DOUBAO_TTS_AUDIO_MIME_TYPE = "audio/mpeg";

export type DoubaoBidirectionalSessionConfig = {
  speaker: string;
  audioParams: DoubaoBidirectionalAudioParams;
};

/**
 * 一次性合成整轮多句为单个音频 Blob。
 *
 * @param sentences 整轮待合成句子（已净化、非空）
 * @param config 鉴权与音频参数
 * @param signal 外部中断信号（打断/关闭语音输出时透传）
 * @returns 整段连续音频的 Blob；失败或无音频抛错，由上层 best-effort 兜底
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
        // 握手就绪：逐句发文本，末句后发 finish 收尾
        for (const sentence of sentences) {
          send({ type: "text", text: sentence });
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
      settleReject(createNetworkError("开发环境 TTS 桥接连接失败。", bridgeUrl));
    });

    websocket.addEventListener("close", () => {
      // 未在 done/error 前正常结算即视为异常关闭
      settleReject(createNetworkError("豆包 TTS 桥接连接已关闭。", bridgeUrl));
    });
  });
}

/**
 * 返回托管 TTS WebSocket 地址。鉴权由 Worker Secret 注入。
 */
function resolveBridgeUrl() {
  return `${MANAGED_VOICE_PROXY_WS_ORIGIN}${TTS_BRIDGE_PATH}`;
}

/** base64 音频块解码为字节 */
function base64ToBytes(base64: string): Uint8Array {
  const binary = window.atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

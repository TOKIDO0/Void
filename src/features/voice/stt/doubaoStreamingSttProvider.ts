import { createNetworkError } from "../../../lib/model-providers/providerErrors";
import {
  DOUBAO_ASR_ENDPOINT,
  MANAGED_VOICE_PROXY_STT_PATH,
  MANAGED_VOICE_PROXY_WS_ORIGIN
} from "../voiceProviderConfig";
import { VoicePcmEncoder } from "./voicePcmEncoder";
import type { VoiceSttProvider, VoiceSttStartOptions } from "./voiceSttContract";
import { isVoiceSttBridgeServerEvent, type VoiceSttBridgeClientEvent } from "./voiceSttBridgeProtocol";

/**
 * 握手超时：Worker 需完成「浏览器 WS → 豆包 WS → 首个成功响应 → ready」。
 * 过短会把弱网当失败；过长会让开麦按钮像卡住。8s 覆盖正常握手余量。
 */
const STT_READY_TIMEOUT_MS = 8000;

/**
 * 豆包流式 STT 客户端。
 *
 * 真源链路：
 *   浏览器 --(JSON start/audio/stop)--> CF Worker /stt --(SAUC 二进制)--> 豆包
 *   豆包 --(识别帧)--> Worker --(partial/final/error/ready JSON)--> 浏览器
 *
 * 就绪语义（产品级硬约束）：
 * - WebSocket `open` 只代表到 Worker 的传输层通了，不代表识别会话可用。
 * - 只有收到服务端 `ready`（上游豆包已接受并返回首帧）才允许开始送音频。
 * - 错误路径（如误用 /void-voice-proxy/stt）会 open 后立刻 1008 关闭；若把 open 当就绪，
 *   会表现为「开麦成功但不识别」的静默失败。
 */
export class DoubaoStreamingSttProvider implements VoiceSttProvider {
  private readonly endpointUrl = DOUBAO_ASR_ENDPOINT;
  private readonly bridgeUrl: string;
  private websocket: WebSocket | null = null;
  private encoder: VoicePcmEncoder | null = null;
  private sessionReady = false;
  /** 用户主动 stop / 本地 teardown，close 事件不得再报「连接断开」。 */
  private intentionalClose = false;

  constructor() {
    this.bridgeUrl = resolveBridgeUrl();
  }

  async start(options: VoiceSttStartOptions) {
    this.intentionalClose = false;
    this.sessionReady = false;

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
      stopMediaStream(microphoneStream);
      throw createNetworkError("托管 STT 服务连接失败。", this.bridgeUrl, error);
    }

    try {
      await this.waitUntilSessionReady(options);
    } catch (error) {
      stopMediaStream(microphoneStream);
      this.teardownSocket();
      throw error;
    }

    // 仅在 ready 之后启动采集，避免把音频打进未就绪/已关闭的连接。
    this.encoder = new VoicePcmEncoder(microphoneStream, (chunk) => {
      this.sendAudioChunk(chunk.audioBase64);
    });
    try {
      await this.encoder.ensureRunning();
    } catch (error) {
      await this.encoder.stop();
      this.encoder = null;
      this.teardownSocket();
      throw createNetworkError("麦克风音频上下文启动失败，无法开始识别。", this.bridgeUrl, error);
    }
  }

  async stop() {
    this.intentionalClose = true;
    // 仅在连接仍打开时通知桥接收尾，避免对已关闭连接发送导致告警。
    if (this.websocket?.readyState === WebSocket.OPEN) {
      this.websocket.send(JSON.stringify({ type: "stop" satisfies VoiceSttBridgeClientEvent["type"] }));
    }
    this.teardownSocket();
    await this.encoder?.stop();
    this.encoder = null;
    this.sessionReady = false;
  }

  /**
   * 等待 Worker 侧真正就绪。
   * open → 发 start → 等 ready；error/close/timeout 一律失败并带可诊断文案。
   */
  private waitUntilSessionReady(options: VoiceSttStartOptions) {
    return new Promise<void>((resolve, reject) => {
      if (!this.websocket) {
        reject(createNetworkError("STT 桥接连接创建失败。", this.bridgeUrl));
        return;
      }

      const websocket = this.websocket;
      let settled = false;

      const settleResolve = () => {
        if (settled) {
          return;
        }
        settled = true;
        cleanupHandshakeListeners();
        this.sessionReady = true;
        resolve();
      };

      const settleReject = (error: Error) => {
        if (settled) {
          return;
        }
        settled = true;
        cleanupHandshakeListeners();
        this.sessionReady = false;
        reject(error);
      };

      const readyTimer = window.setTimeout(() => {
        settleReject(
          createNetworkError(
            `托管 STT 握手超时（${STT_READY_TIMEOUT_MS}ms 内未收到 ready）。请检查网络与语音代理。`,
            this.bridgeUrl
          )
        );
      }, STT_READY_TIMEOUT_MS);

      const onOpen = () => {
        const startEvent: VoiceSttBridgeClientEvent = {
          type: "start",
          sampleRate: 16000,
          format: "pcm_s16le"
        };
        websocket.send(JSON.stringify(startEvent));
      };

      const onMessage = (event: MessageEvent) => {
        let payload: unknown;
        try {
          payload = JSON.parse(String(event.data));
        } catch {
          return;
        }

        if (!isVoiceSttBridgeServerEvent(payload)) {
          return;
        }

        if (payload.type === "ready") {
          // 会话真正可用：结束握手 Promise，后续 partial/final 继续走同一 message 监听。
          settleResolve();
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
          const error = new Error(payload.message);
          if (!settled) {
            settleReject(error);
            return;
          }
          options.onError(error);
        }
      };

      const onError = () => {
        settleReject(createNetworkError("托管 STT 服务连接失败。", this.bridgeUrl));
      };

      const onClose = (event: CloseEvent) => {
        if (this.intentionalClose) {
          return;
        }

        if (!settled) {
          const reason = event.reason?.trim();
          settleReject(
            createNetworkError(
              reason
                ? `STT 桥接在就绪前关闭（${event.code}）：${reason}`
                : `STT 桥接在就绪前关闭（${event.code}）。请确认路径为 Worker /stt。`,
              this.bridgeUrl
            )
          );
          return;
        }

        // 已就绪后异常关闭：通知上层，避免「看起来还在听」的假状态。
        if (this.sessionReady) {
          this.sessionReady = false;
          options.onError(
            createNetworkError(
              event.reason?.trim()
                ? `STT 连接已断开（${event.code}）：${event.reason}`
                : `STT 连接已断开（${event.code}）。`,
              this.bridgeUrl
            )
          );
        }
      };

      const cleanupHandshakeListeners = () => {
        window.clearTimeout(readyTimer);
        // open/error 仅握手期需要；message/close 整段会话保留，由 stop/teardown 移除。
        websocket.removeEventListener("open", onOpen);
        websocket.removeEventListener("error", onError);
      };

      websocket.addEventListener("open", onOpen);
      websocket.addEventListener("message", onMessage);
      websocket.addEventListener("error", onError);
      websocket.addEventListener("close", onClose);
    });
  }

  private sendAudioChunk(audioBase64: string) {
    if (!this.websocket || !this.sessionReady) {
      return;
    }
    if (this.websocket.readyState !== WebSocket.OPEN) {
      return;
    }

    const audioEvent: VoiceSttBridgeClientEvent = {
      type: "audio",
      audioBase64
    };
    this.websocket.send(JSON.stringify(audioEvent));
  }

  private teardownSocket() {
    const socket = this.websocket;
    this.websocket = null;
    this.sessionReady = false;
    if (!socket) {
      return;
    }
    // 本地主动拆除时标记，防止 close 回调误报错误。
    this.intentionalClose = true;
    try {
      socket.close();
    } catch {
      // 忽略关闭异常
    }
  }
}

/**
 * 返回托管 STT WebSocket 地址。鉴权由 Worker Secret 注入。
 */
function resolveBridgeUrl() {
  return `${MANAGED_VOICE_PROXY_WS_ORIGIN}${MANAGED_VOICE_PROXY_STT_PATH}`;
}

function stopMediaStream(stream: MediaStream) {
  stream.getTracks().forEach((track) => track.stop());
}

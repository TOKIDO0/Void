/**
 * 豆包双向流式 TTS —— Cloudflare Worker 侧翻译桥接。
 *
 * 逐行移植自 server/voiceTtsBridge.ts 的 handleBrowserConnection，握手序列与状态机逻辑一字不改。
 * 与 sidecar 版的唯一差异（仅"连接层"）：
 *   - WS 收发从 Node `ws` 适配为 Workers WebSocket API（出站用 fetch + https:// scheme）；
 *   - 豆包鉴权密钥来自 Worker Secret（env），客户端 start 事件不再携带；
 *   - 豆包二进制帧以 Blob 到达，统一转 Uint8Array（见 toBytes）；
 *   - 下行帧按到达顺序串行处理（Blob 转换是异步的，用 promise 链保序，防音频错乱）。
 */
import {
  MsgType,
  MsgTypeFlag,
  EventType,
  encodeFrame,
  decodeFrame,
  encodeJsonPayload
} from "../../../src/features/voice/tts/doubaoBidirectional/frameCodec";
import { toBytes } from "./wsBytes";
import type { Env } from "./index";

// 逻辑上是 wss，但 Workers fetch 出站 WS 必须用 https:// scheme（见 spike 结论）。
const DOUBAO_TTS_ENDPOINT = "https://openspeech.bytedance.com/api/v3/tts/bidirection";
const DOUBAO_TTS_NAMESPACE = "BidirectionalTTS";

type BridgeAudioParams = {
  format: string;
  sampleRate: number;
  speechRate?: number;
  loudnessRate?: number;
};

// 浏览器 → Worker 的客户端事件（start 不再带密钥，密钥由 Worker Secret 注入）。
type TtsClientEvent =
  | { type: "start"; speaker: string; audioParams: BridgeAudioParams }
  | { type: "text"; text: string }
  | { type: "finish" };

type StartEvent = Extract<TtsClientEvent, { type: "start" }>;

export function handleTtsSession(clientSocket: WebSocket, env: Env): void {
  let upstreamSocket: WebSocket | null = null;
  let upstreamOpen = false;
  let clientOpen = true;
  const sessionId = crypto.randomUUID();
  let handshakeState: "idle" | "connecting" | "session-starting" | "ready" | "closed" = "idle";
  const pendingTexts: string[] = [];
  let finishRequested = false;
  let startEvent: StartEvent | null = null;
  let doneSent = false;

  const sendToBrowser = (event: Record<string, unknown>) => {
    if (clientOpen) {
      clientSocket.send(JSON.stringify(event));
    }
  };

  const emitDone = () => {
    if (doneSent) {
      return;
    }
    doneSent = true;
    sendToBrowser({ type: "done" });
  };

  // 正常收尾时不要立刻掐客户端：done 事件需要先被浏览器处理完再 close。
  // 过早 close 会让前端走「桥接连接已关闭」，已收到的音频也播不出来。
  let clientCloseTimer: ReturnType<typeof setTimeout> | null = null;
  const scheduleClientClose = (delayMs = 80) => {
    if (handshakeState === "closed" || clientCloseTimer) {
      return;
    }
    clientCloseTimer = setTimeout(() => {
      clientCloseTimer = null;
      closeAll();
    }, delayMs);
  };

  const closeAll = () => {
    handshakeState = "closed";
    clientOpen = false;
    upstreamOpen = false;
    if (clientCloseTimer) {
      clearTimeout(clientCloseTimer);
      clientCloseTimer = null;
    }
    try {
      upstreamSocket?.close();
    } catch {
      // 忽略关闭异常
    }
    upstreamSocket = null;
    try {
      clientSocket.close();
    } catch {
      // 忽略关闭异常
    }
  };

  const failAndClose = (message: string) => {
    sendToBrowser({ type: "error", message });
    closeAll();
  };

  const sendUpstream = (frame: Uint8Array) => {
    if (upstreamSocket && upstreamOpen) {
      upstreamSocket.send(frame);
    }
  };

  const sendStartConnection = () => {
    sendUpstream(
      encodeFrame({
        type: MsgType.FullClientRequest,
        flag: MsgTypeFlag.WithEvent,
        event: EventType.StartConnection,
        payload: encodeJsonPayload({})
      })
    );
  };

  const sendStartSession = (start: StartEvent) => {
    const audioParams: Record<string, unknown> = {
      format: start.audioParams.format,
      sample_rate: start.audioParams.sampleRate
    };
    if (typeof start.audioParams.speechRate === "number") {
      audioParams.speech_rate = start.audioParams.speechRate;
    }
    if (typeof start.audioParams.loudnessRate === "number") {
      audioParams.loudness_rate = start.audioParams.loudnessRate;
    }

    sendUpstream(
      encodeFrame({
        type: MsgType.FullClientRequest,
        flag: MsgTypeFlag.WithEvent,
        event: EventType.StartSession,
        sessionId,
        payload: encodeJsonPayload({
          user: { uid: "void-web-mvp" },
          event: EventType.StartSession,
          namespace: DOUBAO_TTS_NAMESPACE,
          req_params: {
            text: "",
            speaker: start.speaker,
            audio_params: audioParams
          }
        })
      })
    );
  };

  const sendTaskRequest = (text: string) => {
    sendUpstream(
      encodeFrame({
        type: MsgType.FullClientRequest,
        flag: MsgTypeFlag.WithEvent,
        event: EventType.TaskRequest,
        sessionId,
        payload: encodeJsonPayload({
          user: { uid: "void-web-mvp" },
          event: EventType.TaskRequest,
          namespace: DOUBAO_TTS_NAMESPACE,
          req_params: {
            text,
            speaker: startEvent?.speaker ?? ""
          }
        })
      })
    );
  };

  const sendFinishSession = () => {
    sendUpstream(
      encodeFrame({
        type: MsgType.FullClientRequest,
        flag: MsgTypeFlag.WithEvent,
        event: EventType.FinishSession,
        sessionId,
        payload: encodeJsonPayload({})
      })
    );
  };

  const sendFinishConnection = () => {
    sendUpstream(
      encodeFrame({
        type: MsgType.FullClientRequest,
        flag: MsgTypeFlag.WithEvent,
        event: EventType.FinishConnection,
        payload: encodeJsonPayload({})
      })
    );
  };

  const flushPendingTexts = () => {
    while (pendingTexts.length > 0) {
      const text = pendingTexts.shift();
      if (typeof text === "string" && text) {
        sendTaskRequest(text);
      }
    }
    if (finishRequested) {
      sendFinishSession();
    }
  };

  const handleUpstreamFrame = (bytes: Uint8Array) => {
    let decoded;
    try {
      decoded = decodeFrame(bytes);
    } catch (error) {
      failAndClose(`豆包 TTS 帧解析失败：${error instanceof Error ? error.message : String(error)}`);
      return;
    }

    if (decoded.type === MsgType.Error) {
      failAndClose(`豆包 TTS 服务错误（code=${decoded.errorCode}）。`);
      return;
    }

    if (decoded.type === MsgType.AudioOnlyServer) {
      if (decoded.payload.length > 0) {
        // 不用 Buffer：Workers 运行时对 base64 用 btoa 更稳，避免偶发依赖差异。
        sendToBrowser({ type: "audio", audioBase64: bytesToBase64(decoded.payload) });
      }
      return;
    }

    if (decoded.type === MsgType.FullServerResponse) {
      switch (decoded.event) {
        case EventType.ConnectionStarted: {
          if (handshakeState === "connecting" && startEvent) {
            handshakeState = "session-starting";
            sendStartSession(startEvent);
          }
          return;
        }
        case EventType.ConnectionFailed: {
          failAndClose("豆包 TTS 连接失败（鉴权或资源不可用）。");
          return;
        }
        case EventType.SessionStarted: {
          handshakeState = "ready";
          sendToBrowser({ type: "ready" });
          flushPendingTexts();
          return;
        }
        case EventType.SessionFailed: {
          failAndClose("豆包 TTS 会话启动失败。");
          return;
        }
        case EventType.TTSSentenceStart:
        case EventType.TTSSentenceEnd:
        case EventType.TTSResponse: {
          return;
        }
        case EventType.TTSEnded: {
          emitDone();
          return;
        }
        case EventType.SessionFinished: {
          // 先 done 再 FinishConnection；给浏览器一个事件循环处理 done，
          // 避免「done 未结算就被 close」导致客户端报桥接关闭且无声。
          emitDone();
          sendFinishConnection();
          return;
        }
        case EventType.ConnectionFinished: {
          // 微延迟关客户端，确保 done 帧先被浏览器处理。
          scheduleClientClose();
          return;
        }
        default:
          return;
      }
    }
  };

  const startUpstream = async (start: StartEvent) => {
    startEvent = start;
    handshakeState = "connecting";

    let upstreamResponse: Response;
    try {
      upstreamResponse = await fetch(DOUBAO_TTS_ENDPOINT, {
        headers: {
          Upgrade: "websocket",
          // 与 sidecar 完全一致的鉴权头，值来自 Worker Secret。
          "X-Api-App-Key": env.DOUBAO_APP_ID,
          "X-Api-App-Id": env.DOUBAO_APP_ID,
          "X-Api-Access-Key": env.DOUBAO_ACCESS_KEY,
          "X-Api-Resource-Id": env.DOUBAO_TTS_RESOURCE_ID,
          "X-Api-Connect-Id": crypto.randomUUID()
        }
      });
    } catch (error) {
      failAndClose(`豆包 TTS 连接失败：${error instanceof Error ? error.message : String(error)}`);
      return;
    }

    const upstream = upstreamResponse.webSocket;
    if (!upstream) {
      const body = await upstreamResponse.text().catch(() => "");
      const logId = upstreamResponse.headers.get("x-tt-logid") ?? "";
      failAndClose(
        `豆包 TTS 握手被拒（${upstreamResponse.status}）：${body.trim() || `HTTP ${upstreamResponse.status}`}${logId ? `（logid=${logId}）` : ""}`
      );
      return;
    }

    // 建连期间客户端可能已断开：直接弃用上游连接。
    if (handshakeState === "closed") {
      try {
        upstream.close();
      } catch {
        // 忽略
      }
      return;
    }

    upstream.accept();
    upstreamSocket = upstream;
    upstreamOpen = true;

    // 下行帧按到达顺序串行处理（Blob→Uint8Array 是异步，用 promise 链保序）。
    let frameTail: Promise<void> = Promise.resolve();
    upstream.addEventListener("message", (event: MessageEvent) => {
      const data = event.data;
      frameTail = frameTail.then(async () => {
        handleUpstreamFrame(await toBytes(data));
      });
    });
    upstream.addEventListener("close", () => {
      upstreamOpen = false;
      if (handshakeState === "closed") {
        return;
      }
      // 音频已收完并通知过浏览器：不要立刻硬关客户端，留给 done 结算窗口。
      if (doneSent) {
        scheduleClientClose();
        return;
      }
      // 未完成就断：必须带错误消息，否则浏览器只会看到「桥接连接已关闭」。
      failAndClose(`豆包 TTS 上游连接提前关闭（state=${handshakeState}）。`);
    });
    upstream.addEventListener("error", () => {
      upstreamOpen = false;
      if (doneSent) {
        scheduleClientClose();
        return;
      }
      failAndClose("豆包 TTS 连接异常。");
    });

    // fetch 升级得到的上游连接 accept 后即为 open：直接发 StartConnection。
    sendStartConnection();
  };

  clientSocket.addEventListener("message", (event: MessageEvent) => {
    let parsed: TtsClientEvent;
    try {
      parsed = JSON.parse(typeof event.data === "string" ? event.data : "") as TtsClientEvent;
    } catch {
      return;
    }

    if (parsed.type === "start") {
      if (handshakeState === "idle") {
        void startUpstream(parsed);
      }
      return;
    }

    if (parsed.type === "text") {
      const text = parsed.text.trim();
      if (!text) {
        return;
      }
      if (handshakeState === "ready") {
        sendTaskRequest(text);
      } else {
        pendingTexts.push(text);
      }
      return;
    }

    if (parsed.type === "finish") {
      if (handshakeState === "ready") {
        sendFinishSession();
      } else {
        finishRequested = true;
      }
    }
  });

  clientSocket.addEventListener("close", () => {
    clientOpen = false;
    closeAll();
  });
  clientSocket.addEventListener("error", () => {
    clientOpen = false;
    closeAll();
  });
}

/** Uint8Array → base64，不依赖 Node Buffer。 */
function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    const chunk = bytes.subarray(offset, offset + chunkSize);
    binary += String.fromCharCode(...chunk);
  }
  return btoa(binary);
}
